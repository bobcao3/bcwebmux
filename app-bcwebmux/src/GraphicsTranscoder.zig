// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

//! Re-encodes Kitty graphics uploads in PTY output as WebP before the session
//! journals them, so the mirror, every browser and checkpoint replay all see
//! one smaller stream. Images are coded lossily at the configured quality, or
//! losslessly when that is smaller, as for many plots and screenshots.
//!
//! A rewritten upload is a PNG-format (f=100) transmission whose payload is
//! WebP, which terminal-graphics accepts and browsers decode natively. Only a
//! whole upload is rewritten: its APCs must be printable ASCII ended by ST,
//! follow one another with nothing between them, and spell out canonical
//! control keys; the image must be one the mirror would accept; the mirror
//! must have no upload in progress; and WebP must make it markedly smaller.
//! Everything else passes through byte for byte. Because the rewrite keeps
//! the image's identity, placement and reply settings, the mirror replies to
//! it exactly as it would have to the original.

const std = @import("std");
const ghostty = @import("ghostty-vt");
const Graphics = @import("terminal-graphics");
const wuffs = @import("wuffs");
const webp = @cImport({
    @cInclude("webp/encode.h");
    @cInclude("webp/decode.h");
});
const gfx = ghostty.kitty.graphics;
const Display = @FieldType(gfx.Command.Control, "display");
const Self = @This();

const log = std.log.scoped(.graphics_transcoder);

/// Smaller sources are left alone: there is little to save, and lossy coding
/// shows most on icons and pixel art.
const min_source_bytes = 16 * 1024;
/// A rewrite must shrink the source to at most this fraction of its size, so
/// that already-compact images keep their exact pixels.
const max_size_ratio = 0.75;
/// Base64 payload bytes per rewritten APC, a multiple of 4 within the mirror's limit.
const chunk_bytes = 512 * 1024;
/// Bytes of one APC worth holding; Ghostty drops anything larger.
const max_apc_bytes = Graphics.apc_limit + 4096;
/// Buffers above this are freed rather than kept between uploads.
const retained_bytes = 256 * 1024;

const esc = 0x1b;

alloc: std.mem.Allocator,
quality: f32,
/// Original bytes not yet released: an escape prefix split across inputs, or
/// the APCs of an upload that is still arriving.
held: std.ArrayListUnmanaged(u8) = .empty,
state: State = .ground,
/// Where the APC being captured begins in `held`.
apc_start: usize = 0,
upload: ?Upload = null,
/// The decoded payload of `upload` so far.
payload: std.ArrayListUnmanaged(u8) = .empty,
replacement: std.ArrayListUnmanaged(u8) = .empty,
/// Released bytes not yet passed on, so that one input makes few journal events.
released: std.ArrayListUnmanaged(u8) = .empty,

const State = enum {
    ground,
    /// After an ESC, which may begin a Kitty APC.
    escape,
    /// After ESC _.
    apc_intro,
    /// Inside a Kitty APC that may be rewritten.
    apc,
    /// After the ESC that ended `apc`.
    apc_end,
    /// Inside an APC that passes through as it arrives.
    apc_skip,
};

const Upload = struct {
    /// The first APC's control keys, as a range of `held`.
    control_start: usize,
    control_len: usize,
    control: std.meta.Tag(gfx.Command.Control),
    transmission: Graphics.Transmission,
    display: ?Display,
    quiet: gfx.Command.Quiet,
};

/// `quality` is libwebp's lossy quality, from 1 to 100.
pub fn init(alloc: std.mem.Allocator, quality: u8) Self {
    std.debug.assert(quality >= 1 and quality <= 100);
    return .{ .alloc = alloc, .quality = @floatFromInt(quality) };
}

pub fn deinit(self: *Self) void {
    self.held.deinit(self.alloc);
    self.payload.deinit(self.alloc);
    self.replacement.deinit(self.alloc);
    self.released.deinit(self.alloc);
    self.* = undefined;
}

/// Scans the next PTY output and passes everything it releases, in order, to
/// `sink.output(bytes)`. Before replacing an upload it asks
/// `sink.replaceable()`, which must report whether the mirror is between
/// uploads. Bytes that may begin or continue an upload are held until a later
/// call decides them.
pub fn feed(self: *Self, input: []const u8, sink: anytype) !void {
    // Most output cannot begin a Kitty APC and passes straight through.
    if (self.state == .ground and self.held.items.len == 0 and input.len != 0 and
        input[input.len - 1] != esc and std.mem.indexOf(u8, input, "\x1b_") == null) return sink.output(input);
    var index: usize = 0;
    while (index < input.len) {
        const rest = input[index..];
        switch (self.state) {
            .ground => {
                const end = std.mem.indexOfScalar(u8, rest, esc) orelse rest.len;
                if (end != 0) {
                    // Output between an upload's APCs leaves it unchanged.
                    try self.release(sink);
                    try self.emit(rest[0..end]);
                }
                index += end;
                if (end == rest.len) break;
                try self.held.append(self.alloc, esc);
                self.state = .escape;
                index += 1;
            },
            .escape, .apc_intro => {
                const expected: u8 = if (self.state == .escape) '_' else 'G';
                if (rest[0] != expected) {
                    // Not a Kitty APC: rescan this byte as ordinary output.
                    try self.release(sink);
                    self.state = .ground;
                    continue;
                }
                try self.held.append(self.alloc, rest[0]);
                index += 1;
                if (self.state == .escape) {
                    self.state = .apc_intro;
                } else {
                    self.apc_start = self.held.items.len - 3;
                    self.state = .apc;
                }
            },
            .apc => {
                // Ghostty ends an APC at any ESC; CAN, SUB and C1 bytes abort or
                // end it in ways not worth modelling, so such APCs pass through.
                const end = std.mem.indexOfScalar(u8, rest, esc) orelse rest.len;
                const content = rest[0..end];
                if (!printable(content) or self.held.items.len - self.apc_start + content.len > max_apc_bytes) {
                    try self.release(sink);
                    try self.emit(content);
                    self.state = .apc_skip;
                    index += end;
                    continue;
                }
                try self.held.appendSlice(self.alloc, content);
                index += end;
                if (end != rest.len) {
                    try self.held.append(self.alloc, esc);
                    self.state = .apc_end;
                    index += 1;
                }
            },
            .apc_end => {
                if (rest[0] != '\\') {
                    // Ghostty ran the APC at its ESC, which also begins the next
                    // sequence: pass the APC through and rescan from that ESC.
                    self.held.items.len -= 1;
                    try self.release(sink);
                    try self.held.append(self.alloc, esc);
                    self.state = .escape;
                    continue;
                }
                try self.held.append(self.alloc, '\\');
                index += 1;
                self.state = .ground;
                try self.complete(sink);
            },
            .apc_skip => {
                const end = std.mem.indexOfScalar(u8, rest, esc) orelse rest.len;
                if (end != 0) try self.emit(rest[0..end]);
                index += end;
                if (end != rest.len) {
                    try self.held.append(self.alloc, esc);
                    self.state = .escape;
                    index += 1;
                }
            },
        }
    }
    try self.flush(sink);
}

/// Releases every held byte unchanged, as when the PTY closes.
pub fn finish(self: *Self, sink: anytype) !void {
    try self.release(sink);
    try self.flush(sink);
    self.state = .ground;
}

fn emit(self: *Self, bytes: []const u8) !void {
    try self.released.appendSlice(self.alloc, bytes);
}

fn flush(self: *Self, sink: anytype) !void {
    if (self.released.items.len == 0) return;
    defer if (self.released.capacity > retained_bytes) self.released.clearAndFree(self.alloc) else self.released.clearRetainingCapacity();
    try sink.output(self.released.items);
}

fn printable(bytes: []const u8) bool {
    for (bytes) |byte| if (byte < 0x20 or byte > 0x7e) return false;
    return true;
}

/// Whether Ghostty reads `control` as the comma-separated `key=value` pairs it
/// appears to be, so that pairs can be dropped and added as text. Ghostty
/// keeps one-letter keys and values of at most 11 bytes.
fn canonical(control: []const u8) bool {
    var pairs = std.mem.splitScalar(u8, control, ',');
    while (pairs.next()) |pair| {
        if (pair.len < 3 or pair.len > 13 or !std.ascii.isAlphabetic(pair[0]) or pair[1] != '=') return false;
        for (pair[2..]) |byte| if (!std.ascii.isAlphanumeric(byte) and byte != '-') return false;
    }
    return true;
}

/// Handles the APC that ends `held`, which ended with ST.
fn complete(self: *Self, sink: anytype) !void {
    const content = self.held.items[self.apc_start + 3 .. self.held.items.len - 2];
    var parser = gfx.CommandParser.init(self.alloc, Graphics.apc_limit);
    defer parser.deinit();
    parser.feedSlice(content) catch return self.release(sink);
    var command = parser.complete(self.alloc) catch return self.release(sink);
    defer command.deinit(self.alloc);

    if (self.upload) |*upload| {
        // Graphics continues the upload with any transmission; other commands
        // could act on it, so they end it unchanged.
        const t = switch (command.control) {
            .transmit => |value| value,
            else => return self.release(sink),
        };
        if (command.data.len > Graphics.upload_limit - self.payload.items.len) return self.release(sink);
        try self.payload.appendSlice(self.alloc, command.data);
        if (command.quiet != .no) upload.quiet = command.quiet;
        if (!t.more_chunks) try self.offer(sink);
        return;
    }

    if (command.control == .query) return self.release(sink);
    const t = command.transmission() orelse return self.release(sink);
    const control = content[0 .. std.mem.indexOfScalar(u8, content, ';') orelse content.len];
    if (t.medium != .direct or t.format_unknown or (t.image_id != 0 and t.image_number != 0) or
        command.data.len > Graphics.upload_limit or !canonical(control)) return self.release(sink);
    self.upload = .{
        .control_start = self.apc_start + 3,
        .control_len = control.len,
        .control = command.control,
        .transmission = t,
        .display = command.display(),
        .quiet = command.quiet,
    };
    try self.payload.appendSlice(self.alloc, command.data);
    if (!t.more_chunks) try self.offer(sink);
}

/// Releases a complete upload, rewritten when that is worthwhile.
fn offer(self: *Self, sink: anytype) !void {
    defer self.reset();
    // The mirror must have seen everything before the upload.
    try self.flush(sink);
    if (sink.replaceable()) {
        if (self.rewrite()) |replacement| return sink.output(replacement);
    }
    try sink.output(self.held.items);
}

/// Passes held bytes through unchanged and forgets any upload in progress.
fn release(self: *Self, sink: anytype) !void {
    defer self.reset();
    if (self.held.items.len <= retained_bytes) return self.emit(self.held.items);
    try self.flush(sink);
    try sink.output(self.held.items);
}

fn reset(self: *Self) void {
    for ([_]*std.ArrayListUnmanaged(u8){ &self.held, &self.payload, &self.replacement }) |buffer| {
        if (buffer.capacity > retained_bytes) buffer.clearAndFree(self.alloc) else buffer.clearRetainingCapacity();
    }
    self.upload = null;
}

/// Encodes the held upload as WebP APCs, or returns null to keep the original.
fn rewrite(self: *Self) ?[]const u8 {
    const upload = self.upload.?;
    const payload = self.payload.items;
    if (payload.len < min_source_bytes) return null;
    const t = upload.transmission;
    const source = Graphics.inspect(t, payload) catch return null;
    // WebP decodes to RGBA, which must fit the per-image budget too.
    if (source.codec == .webp or @as(usize, source.width) * source.height * 4 > Graphics.image_limit) return null;
    var writer = self.encode(t, payload, source) catch |err| {
        log.debug("kept {d}x{d} upload: {t}", .{ source.width, source.height, err });
        return null;
    };
    defer webp.WebPMemoryWriterClear(&writer);
    const encoded = writer.mem[0..writer.size];
    if (@as(f64, @floatFromInt(encoded.len)) > @as(f64, @floatFromInt(payload.len)) * max_size_ratio) return null;

    var webp_transmission = t;
    webp_transmission.format = .png;
    webp_transmission.compression = .none;
    const check = Graphics.inspect(webp_transmission, encoded) catch return null;
    if (check.codec != .webp or check.width != source.width or check.height != source.height) return null;

    self.writeApcs(encoded) catch return null;
    if (!self.preserves(upload)) return null;
    log.debug("rewrote {d}x{d} upload as WebP: {d} -> {d} bytes", .{ source.width, source.height, payload.len, encoded.len });
    return self.replacement.items;
}

/// Encodes the upload's pixels lossily, or losslessly when that is smaller.
fn encode(self: *Self, t: Graphics.Transmission, payload: []const u8, source: Graphics.Inspection) !webp.WebPMemoryWriter {
    var owned: ?[]u8 = null;
    defer if (owned) |bytes| self.alloc.free(bytes);
    var channels: u32 = 4;
    const pixels: []const u8 = switch (t.format) {
        .rgb, .rgba => raw: {
            channels = if (t.format == .rgb) 3 else 4;
            if (t.compression == .none) break :raw payload;
            owned = try inflate(self.alloc, payload, source.decoded_bytes);
            break :raw owned.?;
        },
        .png => png: {
            const inflated = if (t.compression == .zlib_deflate) try inflate(self.alloc, payload, t.size) else null;
            defer if (inflated) |bytes| self.alloc.free(bytes);
            const image = try wuffs.png.decode(self.alloc, inflated orelse payload);
            owned = image.data;
            if (image.width != source.width or image.height != source.height) return error.InvalidData;
            break :png image.data;
        },
        .gray, .gray_alpha => return error.InvalidData,
    };
    const image: Pixels = .{ .bytes = pixels, .width = source.width, .height = source.height, .channels = channels };
    if (pixels.len != @as(usize, image.width) * image.height * channels) return error.InvalidData;

    var best = try self.compress(image, .lossy);
    errdefer webp.WebPMemoryWriterClear(&best);
    // Plots, charts and screenshots often compress smaller losslessly, and
    // then keep every pixel; photos exceed the color limit within a few rows.
    if (fewColors(self.alloc, image)) {
        var lossless = self.compress(image, .lossless) catch return best;
        if (lossless.size < best.size) std.mem.swap(webp.WebPMemoryWriter, &best, &lossless);
        webp.WebPMemoryWriterClear(&lossless);
    }
    return best;
}

const Pixels = struct {
    bytes: []const u8,
    width: u32,
    height: u32,
    channels: u32,
};

/// Distinct colors up to which an image is also tried losslessly.
const max_lossless_colors = 8192;

fn fewColors(alloc: std.mem.Allocator, image: Pixels) bool {
    var seen: std.AutoHashMapUnmanaged(u32, void) = .empty;
    defer seen.deinit(alloc);
    seen.ensureTotalCapacity(alloc, max_lossless_colors + 1) catch return false;
    var previous: ?u32 = null;
    var offset: usize = 0;
    while (offset < image.bytes.len) : (offset += image.channels) {
        const color: u32 = if (image.channels == 4)
            std.mem.readInt(u32, image.bytes[offset..][0..4], .little)
        else
            std.mem.readInt(u24, image.bytes[offset..][0..3], .little);
        // Skipping repeats keeps the flat regions of such images cheap.
        if (color == previous) continue;
        previous = color;
        seen.putAssumeCapacity(color, {});
        if (seen.count() > max_lossless_colors) return false;
    }
    return true;
}

fn compress(self: *Self, image: Pixels, mode: enum { lossy, lossless }) !webp.WebPMemoryWriter {
    var config: webp.WebPConfig = undefined;
    switch (mode) {
        .lossy => {
            if (webp.WebPConfigPreset(&config, webp.WEBP_PRESET_DEFAULT, self.quality) == 0) return error.EncoderUnavailable;
            // Sharp RGB-to-YUV keeps chroma edges, such as colored text and
            // plot lines, crisp. Alpha stays lossless by default. Slower
            // methods add little and can take seconds on alpha.
            config.use_sharp_yuv = 1;
            config.method = 4;
        },
        // Level 3 of 9 is within a few tens of milliseconds of the fastest
        // levels on such images and 15-35% smaller.
        .lossless => if (webp.WebPConfigInit(&config) == 0 or webp.WebPConfigLosslessPreset(&config, 3) == 0)
            return error.EncoderUnavailable,
    }
    if (webp.WebPValidateConfig(&config) == 0) return error.EncoderUnavailable;
    var picture: webp.WebPPicture = undefined;
    if (webp.WebPPictureInit(&picture) == 0) return error.EncoderUnavailable;
    defer webp.WebPPictureFree(&picture);
    picture.width = @intCast(image.width);
    picture.height = @intCast(image.height);
    // Lossless coding and sharp YUV both start from ARGB.
    picture.use_argb = 1;
    const stride: c_int = @intCast(image.width * image.channels);
    const imported = if (image.channels == 3)
        webp.WebPPictureImportRGB(&picture, image.bytes.ptr, stride)
    else
        webp.WebPPictureImportRGBA(&picture, image.bytes.ptr, stride);
    if (imported == 0) return error.OutOfMemory;
    var writer: webp.WebPMemoryWriter = undefined;
    webp.WebPMemoryWriterInit(&writer);
    errdefer webp.WebPMemoryWriterClear(&writer);
    picture.writer = &webp.WebPMemoryWrite;
    picture.custom_ptr = &writer;
    if (webp.WebPEncode(&config, &picture) == 0) return error.EncodeFailed;
    return writer;
}

/// Inflates a zlib stream that must hold exactly `len` bytes.
fn inflate(alloc: std.mem.Allocator, bytes: []const u8, len: usize) ![]u8 {
    const inflated = try wuffs.zlib.decode(alloc, bytes, len, len);
    if (inflated.len != len) {
        alloc.free(inflated);
        return error.InvalidData;
    }
    return inflated;
}

/// Writes `replacement` as the upload's APCs carrying `encoded`.
fn writeApcs(self: *Self, encoded: []const u8) !void {
    const upload = self.upload.?;
    const control = self.held.items[upload.control_start..][0..upload.control_len];
    const encoder = std.base64.standard.Encoder;
    const raw_chunk = chunk_bytes / 4 * 3;
    const chunks = @max(1, std.math.divCeil(usize, encoded.len, raw_chunk) catch unreachable);
    const out = &self.replacement;
    out.clearRetainingCapacity();
    try out.ensureTotalCapacity(self.alloc, encoder.calcSize(encoded.len) + control.len + chunks * 16 + 16);
    var offset: usize = 0;
    while (offset < encoded.len) {
        const piece = encoded[offset..@min(encoded.len, offset + raw_chunk)];
        const more = offset + piece.len < encoded.len;
        out.appendSliceAssumeCapacity("\x1b_G");
        if (offset == 0) {
            // Drop the keys that describe the old payload, keep the rest.
            var pairs = std.mem.splitScalar(u8, control, ',');
            while (pairs.next()) |pair| switch (pair[0]) {
                'f', 'o', 'S', 's', 'v', 'm', 'q' => {},
                else => {
                    out.appendSliceAssumeCapacity(pair);
                    out.appendAssumeCapacity(',');
                },
            };
            out.appendSliceAssumeCapacity("f=100");
            out.appendSliceAssumeCapacity(switch (upload.quiet) {
                .no => "",
                .ok => ",q=1",
                .failures => ",q=2",
            });
            if (more) out.appendSliceAssumeCapacity(",m=1");
        } else {
            out.appendSliceAssumeCapacity(if (more) "m=1" else "m=0");
        }
        out.appendAssumeCapacity(';');
        const start = out.items.len;
        out.items.len += encoder.calcSize(piece.len);
        _ = encoder.encode(out.items[start..], piece);
        out.appendSliceAssumeCapacity("\x1b\\");
        offset += piece.len;
    }
}

/// Whether Ghostty reads the rewritten control keys as the same command,
/// apart from the payload description.
fn preserves(self: *Self, upload: Upload) bool {
    const apc = self.replacement.items;
    const control = apc[3..std.mem.indexOfScalar(u8, apc, ';').?];
    var command = gfx.CommandParser.parseString(self.alloc, control) catch return false;
    defer command.deinit(self.alloc);
    const t = command.transmission() orelse return false;
    const before = upload.transmission;
    return std.meta.activeTag(command.control) == upload.control and
        command.quiet == upload.quiet and
        std.meta.eql(command.display(), upload.display) and
        t.format == .png and !t.format_unknown and t.compression == .none and t.medium == .direct and
        t.image_id == before.image_id and t.image_number == before.image_number and
        t.placement_id == before.placement_id and t.usage == before.usage;
}

const testing = std.testing;

/// Collects released output, standing in for the session.
const Recorder = struct {
    bytes: std.ArrayListUnmanaged(u8) = .empty,
    idle: bool = true,

    fn deinit(self: *Recorder) void {
        self.bytes.deinit(testing.allocator);
    }

    pub fn output(self: *Recorder, bytes: []const u8) !void {
        try self.bytes.appendSlice(testing.allocator, bytes);
    }

    pub fn replaceable(self: *Recorder) bool {
        return self.idle;
    }
};

/// A Ghostty terminal with the session's graphics adapter, recording replies.
const Mirror = struct {
    terminal: ghostty.Terminal,
    stream: ghostty.TerminalStream,
    graphics: Graphics,
    replies: std.ArrayListUnmanaged(u8) = .empty,

    fn init(self: *Mirror) !void {
        self.* = .{
            .terminal = try ghostty.Terminal.init(testing.io, testing.allocator, .{ .cols = 80, .rows = 24 }),
            .stream = undefined,
            .graphics = Graphics.init(testing.allocator),
        };
        self.terminal.setKittyGraphicsSizeLimit(testing.allocator, 16 * 1024 * 1024);
        var handler = self.terminal.vtHandler();
        handler.kitty_graphics = execute;
        handler.apc_handler.max_bytes.put(.kitty, Graphics.apc_limit);
        handler.effects.write_pty = writePty;
        self.stream = ghostty.TerminalStream.init(.{ .allocator = testing.allocator, .handler = handler });
    }

    fn deinit(self: *Mirror) void {
        self.stream.deinit();
        self.graphics.deinit();
        self.terminal.deinit(testing.allocator);
        self.replies.deinit(testing.allocator);
    }

    fn execute(handler: *ghostty.TerminalStream.Handler, cmd: *gfx.Command) ?gfx.Response {
        const self: *Mirror = @fieldParentPtr("terminal", handler.terminal);
        return self.graphics.execute(handler.terminal, cmd);
    }

    fn writePty(handler: *ghostty.TerminalStream.Handler, bytes: []const u8) void {
        const self: *Mirror = @fieldParentPtr("terminal", handler.terminal);
        self.replies.appendSlice(testing.allocator, bytes) catch @panic("OOM");
    }

    pub fn output(self: *Mirror, bytes: []const u8) !void {
        self.stream.nextSlice(bytes);
    }

    pub fn replaceable(self: *Mirror) bool {
        return self.graphics.safeToCapture();
    }
};

fn smoothImage(width: u32, height: u32, channels: u32) ![]u8 {
    const pixels = try testing.allocator.alloc(u8, @as(usize, width) * height * channels);
    var prng = std.Random.DefaultPrng.init(width ^ height);
    const random = prng.random();
    for (0..height) |y| for (0..width) |x| {
        const i = (y * width + x) * channels;
        pixels[i] = @intCast((x * 255) / width);
        pixels[i + 1] = @intCast((y * 255) / height);
        pixels[i + 2] = @intCast(((x + y) * 127) / (width + height) + random.uintLessThan(u8, 8));
        if (channels == 4) pixels[i + 3] = if (x < 8) 0 else 255;
    };
    return pixels;
}

/// White with a few colored lines: few colors, so WebP stores it losslessly.
fn chartImage(width: u32, height: u32) ![]u8 {
    const pixels = try testing.allocator.alloc(u8, @as(usize, width) * height * 4);
    @memset(pixels, 255);
    for (0..width) |x| {
        for ([_][3]u8{ .{ 31, 119, 180 }, .{ 214, 39, 40 } }, 0..) |color, k| {
            const y = (height / 2 + (x * (k + 1)) % (height / 3)) % height;
            @memcpy(pixels[(y * width + x) * 4 ..][0..3], &color);
        }
    }
    return pixels;
}

/// A zlib stream of stored blocks.
fn zlibStored(bytes: []const u8) ![]u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    errdefer out.deinit(testing.allocator);
    try out.appendSlice(testing.allocator, &.{ 0x78, 0x01 });
    var offset: usize = 0;
    while (true) {
        const block = bytes[offset..@min(bytes.len, offset + 65535)];
        offset += block.len;
        const last = offset == bytes.len;
        var header: [5]u8 = undefined;
        header[0] = @intFromBool(last);
        std.mem.writeInt(u16, header[1..3], @intCast(block.len), .little);
        std.mem.writeInt(u16, header[3..5], ~@as(u16, @intCast(block.len)), .little);
        try out.appendSlice(testing.allocator, &header);
        try out.appendSlice(testing.allocator, block);
        if (last) break;
    }
    var adler: [4]u8 = undefined;
    std.mem.writeInt(u32, &adler, std.hash.Adler32.hash(bytes), .big);
    try out.appendSlice(testing.allocator, &adler);
    return out.toOwnedSlice(testing.allocator);
}

fn pngImage(rgba: []const u8, width: u32, height: u32) ![]u8 {
    var rows: std.ArrayListUnmanaged(u8) = .empty;
    defer rows.deinit(testing.allocator);
    for (0..height) |y| {
        try rows.append(testing.allocator, 0);
        try rows.appendSlice(testing.allocator, rgba[y * width * 4 ..][0 .. width * 4]);
    }
    const idat = try zlibStored(rows.items);
    defer testing.allocator.free(idat);
    var out: std.ArrayListUnmanaged(u8) = .empty;
    errdefer out.deinit(testing.allocator);
    try out.appendSlice(testing.allocator, "\x89PNG\r\n\x1a\n");
    var ihdr: [13]u8 = undefined;
    std.mem.writeInt(u32, ihdr[0..4], width, .big);
    std.mem.writeInt(u32, ihdr[4..8], height, .big);
    @memcpy(ihdr[8..13], &[_]u8{ 8, 6, 0, 0, 0 });
    for ([_]struct { []const u8, []const u8 }{ .{ "IHDR", &ihdr }, .{ "IDAT", idat }, .{ "IEND", "" } }) |chunk| {
        var length: [4]u8 = undefined;
        std.mem.writeInt(u32, &length, @intCast(chunk[1].len), .big);
        try out.appendSlice(testing.allocator, &length);
        const start = out.items.len;
        try out.appendSlice(testing.allocator, chunk[0]);
        try out.appendSlice(testing.allocator, chunk[1]);
        var crc: [4]u8 = undefined;
        std.mem.writeInt(u32, &crc, std.hash.crc.Crc32.hash(out.items[start..]), .big);
        try out.appendSlice(testing.allocator, &crc);
    }
    return out.toOwnedSlice(testing.allocator);
}

/// Kitty APCs as clients send them: the control keys and m=1 on the first
/// chunk, then only m on the rest.
fn kittyUpload(control: []const u8, payload: []const u8, chunk: usize) ![]u8 {
    const encoder = std.base64.standard.Encoder;
    const encoded = try testing.allocator.alloc(u8, encoder.calcSize(payload.len));
    defer testing.allocator.free(encoded);
    _ = encoder.encode(encoded, payload);
    var out: std.ArrayListUnmanaged(u8) = .empty;
    errdefer out.deinit(testing.allocator);
    var offset: usize = 0;
    while (true) {
        const piece = encoded[offset..@min(encoded.len, offset + chunk)];
        offset += piece.len;
        const more = offset < encoded.len;
        try out.appendSlice(testing.allocator, "\x1b_G");
        if (piece.ptr == encoded.ptr) {
            try out.appendSlice(testing.allocator, control);
            if (more) try out.appendSlice(testing.allocator, ",m=1");
        } else {
            try out.appendSlice(testing.allocator, if (more) "m=1" else "m=0");
        }
        try out.append(testing.allocator, ';');
        try out.appendSlice(testing.allocator, piece);
        try out.appendSlice(testing.allocator, "\x1b\\");
        if (!more) break;
    }
    return out.toOwnedSlice(testing.allocator);
}

/// Feeds `input` in pseudo-random slices, as PTY reads split it.
fn feedSplit(transcoder: *Self, input: []const u8, sink: anytype, seed: u64) !void {
    var prng = std.Random.DefaultPrng.init(seed);
    const random = prng.random();
    var offset: usize = 0;
    while (offset < input.len) {
        const len = @min(input.len - offset, 1 + random.uintLessThan(usize, if (random.boolean()) 7 else 70000));
        try transcoder.feed(input[offset..][0..len], sink);
        offset += len;
    }
}

const Rewritten = struct {
    control: []const u8,
    webp: []u8,

    fn deinit(self: Rewritten) void {
        testing.allocator.free(self.webp);
    }
};

/// Splits rewritten output into its first control keys and the WebP payload.
fn parseRewrite(output: []const u8) !Rewritten {
    var webp_bytes: std.ArrayListUnmanaged(u8) = .empty;
    errdefer webp_bytes.deinit(testing.allocator);
    var control: []const u8 = "";
    var rest = output;
    while (rest.len != 0) {
        try testing.expect(std.mem.startsWith(u8, rest, "\x1b_G"));
        const end = std.mem.indexOf(u8, rest, "\x1b\\").?;
        const content = rest[3..end];
        const semicolon = std.mem.indexOfScalar(u8, content, ';').?;
        if (control.len == 0) control = content[0..semicolon];
        const data = content[semicolon + 1 ..];
        const decoder = std.base64.standard.Decoder;
        const start = webp_bytes.items.len;
        try webp_bytes.resize(testing.allocator, start + try decoder.calcSizeForSlice(data));
        try decoder.decode(webp_bytes.items[start..], data);
        rest = rest[end + 2 ..];
    }
    return .{ .control = control, .webp = try webp_bytes.toOwnedSlice(testing.allocator) };
}

/// Peak signal-to-noise ratio of alpha-weighted RGBA, in decibels.
fn psnr(expected: []const u8, actual: []const u8) f64 {
    var sum: f64 = 0;
    var offset: usize = 0;
    while (offset < expected.len) : (offset += 4) {
        for (0..4) |channel| {
            const a: f64 = @floatFromInt(expected[offset + channel]);
            const b: f64 = @floatFromInt(actual[offset + channel]);
            const wa: f64 = if (channel == 3) 255 else @floatFromInt(expected[offset + 3]);
            const wb: f64 = if (channel == 3) 255 else @floatFromInt(actual[offset + 3]);
            const difference = a * wa / 255 - b * wb / 255;
            sum += difference * difference;
        }
    }
    if (sum == 0) return std.math.inf(f64);
    return 10 * std.math.log10(255 * 255 / (sum / @as(f64, @floatFromInt(expected.len))));
}

fn decodeWebp(bytes: []const u8, width: u32, height: u32) ![]u8 {
    var decoded_width: c_int = 0;
    var decoded_height: c_int = 0;
    const decoded = webp.WebPDecodeRGBA(bytes.ptr, bytes.len, &decoded_width, &decoded_height) orelse return error.InvalidData;
    defer webp.WebPFree(decoded);
    try testing.expectEqual(@as(c_int, @intCast(width)), decoded_width);
    try testing.expectEqual(@as(c_int, @intCast(height)), decoded_height);
    return testing.allocator.dupe(u8, decoded[0 .. @as(usize, width) * height * 4]);
}

fn expectUnchanged(input: []const u8, idle: bool) !void {
    var transcoder = init(testing.allocator, 90);
    defer transcoder.deinit();
    var recorder: Recorder = .{ .idle = idle };
    defer recorder.deinit();
    try feedSplit(&transcoder, input, &recorder, input.len);
    try transcoder.finish(&recorder);
    try testing.expectEqualSlices(u8, input, recorder.bytes.items);
}

test "transcoder passes other output through byte for byte" {
    var prng = std.Random.DefaultPrng.init(0x5eed);
    const random = prng.random();
    const fragments = [_][]const u8{
        "text ",     "\x1b[31m",            "\x1b",           "\x1b_",       "\x1b_G",       "\x1b\\",
        "\x1b_Ga=q", "\x1b_Ga=T,f=32;AAAA", "\x1b_Gm=1;QQ==", "\x18",        "\x07",         "\xe2\x94\x80",
        "\x9c",      "\x1bP1$r\x1b\\",      "\x1b]0;t\x07",   "\x1b_Xother", ";AAAA",        "\x1b_Ga=p,i=1",
        "\x1b\x1b",  "\r\n",                "\x1b_G\x00",     "\x1b_G;",     "\x1b_Gf=24,s", "=1\x1b\\",
    };
    for (0..200) |round| {
        var input: std.ArrayListUnmanaged(u8) = .empty;
        defer input.deinit(testing.allocator);
        for (0..random.uintLessThan(usize, 60)) |_| try input.appendSlice(testing.allocator, fragments[random.uintLessThan(usize, fragments.len)]);
        var transcoder = init(testing.allocator, 90);
        defer transcoder.deinit();
        var recorder: Recorder = .{};
        defer recorder.deinit();
        try feedSplit(&transcoder, input.items, &recorder, round);
        try transcoder.finish(&recorder);
        try testing.expectEqualSlices(u8, input.items, recorder.bytes.items);
    }
}

test "transcoder rewrites a chunked RGBA upload as lossy WebP" {
    const width = 320;
    const height = 200;
    const pixels = try smoothImage(width, height, 4);
    defer testing.allocator.free(pixels);
    const upload = try kittyUpload("a=T,f=32,s=320,v=200,i=7,c=10,r=5,q=1", pixels, 4096);
    defer testing.allocator.free(upload);
    const input = try std.mem.concat(testing.allocator, u8, &.{ "before\x1b[1m", upload, "after" });
    defer testing.allocator.free(input);

    var transcoder = init(testing.allocator, 90);
    defer transcoder.deinit();
    var recorder: Recorder = .{};
    defer recorder.deinit();
    try feedSplit(&transcoder, input, &recorder, 1);
    try transcoder.finish(&recorder);
    const output = recorder.bytes.items;
    try testing.expect(std.mem.startsWith(u8, output, "before\x1b[1m"));
    try testing.expect(std.mem.endsWith(u8, output, "after"));
    const rewritten = try parseRewrite(output["before\x1b[1m".len .. output.len - "after".len]);
    defer rewritten.deinit();
    try testing.expectEqualStrings("a=T,i=7,c=10,r=5,f=100,q=1", rewritten.control);
    try testing.expect(rewritten.webp.len * 20 < pixels.len);
    const decoded = try decodeWebp(rewritten.webp, width, height);
    defer testing.allocator.free(decoded);
    try testing.expect(psnr(pixels, decoded) > 40);
}

test "transcoder stores few-color PNG uploads losslessly" {
    const width = 400;
    const height = 300;
    const pixels = try chartImage(width, height);
    defer testing.allocator.free(pixels);
    const png = try pngImage(pixels, width, height);
    defer testing.allocator.free(png);
    const compressed = try zlibStored(png);
    defer testing.allocator.free(compressed);
    const control = try std.fmt.allocPrint(testing.allocator, "a=t,f=100,o=z,S={d},i=3", .{png.len});
    defer testing.allocator.free(control);
    for ([_]struct { []const u8, []const u8 }{ .{ "a=t,f=100,i=3", png }, .{ control, compressed } }) |case| {
        const upload = try kittyUpload(case[0], case[1], 4096);
        defer testing.allocator.free(upload);
        var transcoder = init(testing.allocator, 90);
        defer transcoder.deinit();
        var recorder: Recorder = .{};
        defer recorder.deinit();
        try transcoder.feed(upload, &recorder);
        const rewritten = try parseRewrite(recorder.bytes.items);
        defer rewritten.deinit();
        try testing.expectEqualStrings("a=t,i=3,f=100", rewritten.control);
        const decoded = try decodeWebp(rewritten.webp, width, height);
        defer testing.allocator.free(decoded);
        try testing.expectEqualSlices(u8, pixels, decoded);
    }
}

test "transcoder rewrites zlib-compressed RGB uploads" {
    const pixels = try smoothImage(256, 128, 3);
    defer testing.allocator.free(pixels);
    const compressed = try zlibStored(pixels);
    defer testing.allocator.free(compressed);
    const upload = try kittyUpload("f=24,o=z,s=256,v=128,I=9,q=2", compressed, 1 << 20);
    defer testing.allocator.free(upload);
    var transcoder = init(testing.allocator, 90);
    defer transcoder.deinit();
    var recorder: Recorder = .{};
    defer recorder.deinit();
    try transcoder.feed(upload, &recorder);
    const rewritten = try parseRewrite(recorder.bytes.items);
    defer rewritten.deinit();
    try testing.expectEqualStrings("I=9,f=100,q=2", rewritten.control);
    const decoded = try decodeWebp(rewritten.webp, 256, 128);
    defer testing.allocator.free(decoded);
    const rgba = try testing.allocator.alloc(u8, decoded.len);
    defer testing.allocator.free(rgba);
    for (0..256 * 128) |i| {
        @memcpy(rgba[i * 4 ..][0..3], pixels[i * 3 ..][0..3]);
        rgba[i * 4 + 3] = 255;
    }
    try testing.expect(psnr(rgba, decoded) > 40);
}

test "transcoder keeps uploads it cannot rewrite exactly" {
    const pixels = try smoothImage(128, 64, 4);
    defer testing.allocator.free(pixels);
    const valid = try kittyUpload("a=T,f=32,s=128,v=64,i=1", pixels, 4096);
    defer testing.allocator.free(valid);

    // The mirror is still assembling an earlier upload this one would join.
    try expectUnchanged(valid, false);
    // Other output between chunks.
    const split = std.mem.indexOf(u8, valid, "\x1b\\\x1b_G").? + 2;
    const interleaved = try std.mem.concat(testing.allocator, u8, &.{ valid[0..split], "\r\n", valid[split..] });
    defer testing.allocator.free(interleaved);
    try expectUnchanged(interleaved, true);
    // An APC ended by ESC without ST, and one with a byte Ghostty treats specially.
    const unterminated = try std.mem.replaceOwned(u8, testing.allocator, valid, "\x1b\\\x1b_G", "\x1b\x1b_G");
    defer testing.allocator.free(unterminated);
    try expectUnchanged(unterminated, true);
    const control_byte = try std.mem.replaceOwned(u8, testing.allocator, valid, "m=1;", "m=1;\x07");
    defer testing.allocator.free(control_byte);
    try expectUnchanged(control_byte, true);
    // An upload that never finishes.
    try expectUnchanged(valid[0..split], true);

    const cases = [_][]const u8{
        "a=q,f=32,s=128,v=64,i=1", // queries are answered for the original
        "a=T,f=32,s=128,v=63,i=1", // wrong length: Graphics rejects it
        "a=T,f=32,s=128,v=64,i=1,I=2", // ID and number together
        "a=T,f=32,s=128,v=64,t=f", // not a direct transmission
        "a=T,f=31,s=128,v=64", // unknown format
        "a=T,f=32,s=128,v=64,x,i=1", // keys Ghostty would not read as written
        "a=T,f=32,s=128,v=64,i=000000000001", // a value Ghostty ignores
    };
    for (cases) |control| {
        const upload = try kittyUpload(control, pixels, 4096);
        defer testing.allocator.free(upload);
        try expectUnchanged(upload, true);
    }

    // Too small to be worth re-encoding.
    const small = try kittyUpload("a=T,f=32,s=64,v=32", pixels[0 .. 64 * 32 * 4], 4096);
    defer testing.allocator.free(small);
    try expectUnchanged(small, true);

    // Already WebP.
    const noise = try testing.allocator.alloc(u8, 256 * 256 * 4);
    defer testing.allocator.free(noise);
    var prng = std.Random.DefaultPrng.init(1);
    prng.random().bytes(noise);
    var transcoder = init(testing.allocator, 90);
    defer transcoder.deinit();
    var writer = try transcoder.compress(.{ .bytes = noise, .width = 256, .height = 256, .channels = 4 }, .lossless);
    defer webp.WebPMemoryWriterClear(&writer);
    try testing.expect(writer.size > min_source_bytes);
    const webp_upload = try kittyUpload("a=T,f=100", writer.mem[0..writer.size], 4096);
    defer testing.allocator.free(webp_upload);
    try expectUnchanged(webp_upload, true);
}

test "rewritten uploads get the original's replies and image state" {
    const photo = try smoothImage(512, 384, 4);
    defer testing.allocator.free(photo);
    const chart = try chartImage(400, 300);
    defer testing.allocator.free(chart);
    const png = try pngImage(chart, 400, 300);
    defer testing.allocator.free(png);
    // Noise defeats WebP enough to need several rewritten APCs.
    const noisy = try testing.allocator.alloc(u8, 1024 * 768 * 4);
    defer testing.allocator.free(noisy);
    var prng = std.Random.DefaultPrng.init(3);
    for (noisy, 0..) |*byte, i| byte.* = if (i % 4 == 3) 255 else prng.random().int(u8) | 0x0f;

    const streams = [_]struct { []const u8, []const u8 }{
        .{ "a=T,f=32,s=512,v=384,i=5,c=8,r=4", photo },
        .{ "a=T,f=32,s=512,v=384,i=5,p=2,z=-3,q=1", photo },
        .{ "a=t,f=100,I=12", png },
        .{ "a=T,f=100", png },
        .{ "f=32,s=1024,v=768,i=9,q=2", noisy },
        .{ "a=T,f=32,s=512,v=384,i=5,U=1,c=2,r=2", photo },
    };
    var all: std.ArrayListUnmanaged(u8) = .empty;
    defer all.deinit(testing.allocator);
    for (streams, 0..) |stream, n| {
        const upload = try kittyUpload(stream[0], stream[1], 4096);
        defer testing.allocator.free(upload);
        try all.appendSlice(testing.allocator, upload);
        // Placements and deletions between uploads.
        try all.appendSlice(testing.allocator, if (n % 2 == 0) "\x1b_Ga=p,i=5,p=3\x1b\\x" else "\x1b_Ga=d,d=i,i=12\x1b\\\r\n");
    }

    var original: Mirror = undefined;
    try original.init();
    defer original.deinit();
    original.stream.nextSlice(all.items);

    var rewritten: Mirror = undefined;
    try rewritten.init();
    defer rewritten.deinit();
    var transcoder = init(testing.allocator, 90);
    defer transcoder.deinit();
    var recorder: Recorder = .{};
    defer recorder.deinit();
    const Tee = struct {
        mirror: *Mirror,
        recorder: *Recorder,
        pub fn output(tee: @This(), bytes: []const u8) !void {
            try tee.mirror.output(bytes);
            try tee.recorder.output(bytes);
        }
        pub fn replaceable(tee: @This()) bool {
            return tee.mirror.replaceable();
        }
    };
    try feedSplit(&transcoder, all.items, Tee{ .mirror = &rewritten, .recorder = &recorder }, 7);
    try transcoder.finish(Tee{ .mirror = &rewritten, .recorder = &recorder });

    try testing.expect(recorder.bytes.items.len * 4 < all.items.len);
    // The noisy image needs continuation APCs once rewritten.
    try testing.expect(std.mem.indexOf(u8, recorder.bytes.items, "\x1b_Gm=0;") != null);
    try testing.expect(original.replies.items.len != 0);
    try testing.expectEqualStrings(original.replies.items, rewritten.replies.items);
    const before = &original.terminal.screens.active.kitty_images;
    const after = &rewritten.terminal.screens.active.kitty_images;
    try testing.expectEqual(before.images.count(), after.images.count());
    var images = before.images.valueIterator();
    while (images.next()) |image| {
        const other = after.images.get(image.id).?;
        try testing.expectEqual(image.number, other.number);
        try testing.expectEqual(image.width, other.width);
        try testing.expectEqual(image.height, other.height);
        try testing.expectEqual(image.metadata.implicit_id, other.metadata.implicit_id);
        const source = rewritten.graphics.source(rewritten.terminal.screens.active, other.id, other.generation).?;
        try testing.expectEqual(Graphics.Codec.webp, source.codec);
    }
    try testing.expectEqual(before.placements.count(), after.placements.count());
    var placements = before.placements.iterator();
    while (placements.next()) |entry| {
        const other = after.placements.get(entry.key_ptr.*).?;
        try testing.expectEqual(entry.value_ptr.z, other.z);
        try testing.expectEqual(entry.value_ptr.columns, other.columns);
    }
}

test "graphics accepts still WebP payloads under the PNG format" {
    const pixels = try smoothImage(64, 48, 4);
    defer testing.allocator.free(pixels);
    var transcoder = init(testing.allocator, 90);
    defer transcoder.deinit();
    const image: Pixels = .{ .bytes = pixels, .width = 64, .height = 48, .channels = 4 };
    var t: Graphics.Transmission = .{ .format = .png };
    for ([_]bool{ false, true }) |lossless| {
        // With transparent pixels, lossy output is VP8X; lossless is VP8L.
        var writer = try transcoder.compress(image, if (lossless) .lossless else .lossy);
        defer webp.WebPMemoryWriterClear(&writer);
        const bytes = writer.mem[0..writer.size];
        try testing.expectEqualStrings(if (lossless) "VP8L" else "VP8X", bytes[12..16]);
        const accepted = try Graphics.inspect(t, bytes);
        try testing.expectEqual(Graphics.Codec.webp, accepted.codec);
        try testing.expectEqual(@as(u32, 64), accepted.width);
        try testing.expectEqual(@as(u32, 48), accepted.height);
        try testing.expectEqual(@as(usize, 64 * 48 * 4), accepted.decoded_bytes);

        const copy = try testing.allocator.dupe(u8, bytes);
        defer testing.allocator.free(copy);
        // The RIFF size must match the payload exactly.
        try testing.expectError(error.InvalidData, Graphics.inspect(t, copy[0 .. copy.len - 1]));
        if (!lossless) {
            copy[20] |= 0x02; // animated
            try testing.expectError(error.InvalidData, Graphics.inspect(t, copy));
        }
    }
    // Opaque lossy output is a plain VP8 frame.
    const opaque_pixels = try smoothImage(64, 48, 3);
    defer testing.allocator.free(opaque_pixels);
    var writer = try transcoder.compress(.{ .bytes = opaque_pixels, .width = 64, .height = 48, .channels = 3 }, .lossy);
    defer webp.WebPMemoryWriterClear(&writer);
    const bytes = writer.mem[0..writer.size];
    try testing.expectEqualStrings("VP8 ", bytes[12..16]);
    try testing.expectEqual(@as(u32, 64), (try Graphics.inspect(t, bytes)).width);
    // Zlib-wrapped WebP is checked like zlib-wrapped PNG.
    const compressed = try zlibStored(bytes);
    defer testing.allocator.free(compressed);
    t.compression = .zlib_deflate;
    t.size = @intCast(bytes.len);
    try testing.expectEqual(Graphics.Codec.webp, (try Graphics.inspect(t, compressed)).codec);
    t.size += 1;
    try testing.expectError(error.InvalidData, Graphics.inspect(t, compressed));
}
