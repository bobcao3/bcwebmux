const std = @import("std");
const ghostty = @import("ghostty-vt");
const gfx = ghostty.kitty.graphics;
const Self = @This();
pub const Transmission = @FieldType(gfx.Command.Control, "transmit");
const Format = @FieldType(Transmission, "format");
const Compression = @FieldType(Transmission, "compression");

/// Decoded bytes one image may account for.
pub const image_limit = 16 * 1024 * 1024;
/// Encoded bytes of one complete upload, summed over its chunks.
pub const upload_limit = 8 * 1024 * 1024;
const source_limit = 32 * 1024 * 1024;
pub const side_limit = 4096;
/// Payload bytes one Kitty APC may carry before Ghostty drops it.
pub const apc_limit = 1024 * 1024;
const max_images = 512;
const max_placements = 2048;

const Key = struct {
    screen: usize,
    id: u32,
};

/// How a source's bytes encode its pixels. A PNG-format (f=100) payload may
/// also be a still WebP image: the server re-encodes uploads that way, and
/// browsers decode both natively.
pub const Codec = enum { raw, png, webp };

pub const Source = struct {
    bytes: []const u8,
    /// The `Image.transmission` these bytes were sent as.
    transmission: u64,
    width: u32,
    height: u32,
    format: Format,
    codec: Codec,
    compression: Compression,
    png_size: u32,
};

const Upload = struct {
    screen: usize,
    first: gfx.Command,
    id: u32,
    data: std.ArrayListUnmanaged(u8) = .empty,
    quiet: gfx.Command.Quiet,

    fn deinit(self: *Upload, alloc: std.mem.Allocator) void {
        self.data.deinit(alloc);
    }
};

alloc: std.mem.Allocator,
sources: std.AutoHashMapUnmanaged(Key, Source) = .empty,
loading: [2]?Upload = .{ null, null },
draining: [2]bool = .{ false, false },
source_bytes: usize = 0,
fatal: bool = false,
state_changed: bool = false,

pub fn init(alloc: std.mem.Allocator) Self {
    return .{ .alloc = alloc };
}

pub fn deinit(self: *Self) void {
    for (&self.loading) |*slot| if (slot.*) |*pending| pending.deinit(self.alloc);
    var it = self.sources.valueIterator();
    while (it.next()) |item| self.alloc.free(item.bytes);
    self.sources.deinit(self.alloc);
    self.* = undefined;
}

pub fn source(self: *const Self, screen: *ghostty.Screen, image_id: u32, transmission: u64) ?Source {
    const value = self.sources.get(.{ .screen = @intFromPtr(screen), .id = image_id }) orelse return null;
    return if (value.transmission == transmission) value else null;
}

pub fn safeToCapture(self: *const Self) bool {
    // Checkpoints cannot represent a rejected transmission's remaining chunks.
    return self.loading[0] == null and self.loading[1] == null and !self.draining[0] and !self.draining[1];
}

pub fn execute(self: *Self, terminal: *ghostty.Terminal, cmd: *gfx.Command) ?gfx.Response {
    self.reconcile(terminal);
    const index = @backingInt(terminal.screens.active_key);
    if (self.draining[index] and (cmd.control == .transmit or cmd.control == .transmit_and_display)) {
        self.draining[index] = cmd.transmission().?.more_chunks;
        self.state_changed = true;
        return null;
    }
    const ids = cmd.control.identifiers();
    if (ids.image_id != 0 and ids.image_number != 0) {
        return respond(cmd.quiet, .{ .id = ids.image_id, .image_number = ids.image_number, .placement_id = ids.placement_id, .message = "EINVAL: image ID and number are mutually exclusive" });
    }
    switch (cmd.control) {
        .display, .delete => {
            self.state_changed = true;
            if (cmd.control == .delete) {
                const slot = &self.loading[@backingInt(terminal.screens.active_key)];
                if (slot.*) |*pending| pending.deinit(self.alloc);
                slot.* = null;
            }
            if (cmd.control == .display and terminal.screens.active.kitty_images.placements.count() >= max_placements) {
                return respond(cmd.quiet, .{
                    .id = ids.image_id,
                    .image_number = ids.image_number,
                    .placement_id = ids.placement_id,
                    .message = "ENOSPC: placement storage full",
                });
            }
            const result = gfx.execute(terminal.io(), self.alloc, terminal, cmd);
            self.reconcile(terminal);
            return result;
        },
        .transmit, .transmit_and_display => {
            self.state_changed = true;
            return self.transmit(terminal, cmd);
        },
        .query => return self.transmit(terminal, cmd),
        .transmit_animation_frame, .control_animation, .compose_animation => return respond(cmd.quiet, .{
            .id = ids.image_id,
            .image_number = ids.image_number,
            .placement_id = ids.placement_id,
            .message = "EINVAL: animation unsupported",
        }),
    }
}

fn respond(quiet: gfx.Command.Quiet, value: gfx.Response) ?gfx.Response {
    return switch (quiet) {
        .no => if (value.empty()) null else value,
        .ok => if (value.ok()) null else value,
        .failures => null,
    };
}

fn transmit(self: *Self, terminal: *ghostty.Terminal, cmd: *gfx.Command) ?gfx.Response {
    const t = cmd.transmission().?;
    const screen = terminal.screens.active;
    const screen_id = @intFromPtr(screen);
    const index = @backingInt(terminal.screens.active_key);
    const slot = &self.loading[index];
    const is_query = cmd.control == .query;
    var response: gfx.Response = .{ .id = t.image_id, .image_number = t.image_number, .placement_id = t.placement_id };
    if (is_query) {
        if (t.image_id == 0 or t.more_chunks or t.medium != .direct or t.format_unknown) {
            response.message = "EINVAL: invalid query";
            return respond(cmd.quiet, response);
        }
        return respond(cmd.quiet, self.accept(terminal, cmd, cmd.data, 0, &response));
    }
    if (slot.*) |*pending| {
        if (pending.screen != screen_id) {
            response.message = "EINVAL: incomplete transmission";
            return respond(cmd.quiet, response);
        }
        if (cmd.quiet != .no) pending.quiet = cmd.quiet;
        const quiet = pending.quiet;
        if (pending.data.items.len > upload_limit or cmd.data.len > upload_limit - pending.data.items.len) {
            const first = pending.first.transmission().?;
            response = .{ .id = first.image_id, .image_number = first.image_number, .placement_id = first.placement_id };
            pending.deinit(self.alloc);
            slot.* = null;
            self.draining[index] = t.more_chunks;
            response.message = "ENOMEM: upload too large";
            return respond(quiet, response);
        }
        pending.data.appendSlice(self.alloc, cmd.data) catch {
            self.fatal = true;
            pending.deinit(self.alloc);
            slot.* = null;
            response.message = "ENOMEM: out of memory";
            return respond(quiet, response);
        };
        if (t.more_chunks) return null;
        var completed = slot.*.?;
        slot.* = null;
        defer completed.deinit(self.alloc);
        const first = completed.first.transmission().?;
        response = .{ .id = first.image_id, .image_number = first.image_number, .placement_id = first.placement_id };
        return respond(quiet, self.accept(terminal, &completed.first, completed.data.items, completed.id, &response));
    }
    if (t.medium != .direct or t.format_unknown) {
        self.draining[index] = t.more_chunks;
        response.message = if (t.medium != .direct) "EINVAL: unsupported medium" else "EINVAL: unsupported format";
        return respond(cmd.quiet, response);
    }
    const storage = &screen.kitty_images;
    if (t.image_id > 0 and cmd.control != .query) {
        storage.delete(terminal.io(), self.alloc, terminal, .{ .id = .{ .image_id = t.image_id, .delete = true } });
        self.reconcile(terminal);
    }
    const implicit = t.image_id == 0 and t.image_number == 0;
    const id = if (t.image_id != 0) t.image_id else storage.nextImageId(if (implicit) .implicit else .explicit);
    if (cmd.data.len > upload_limit) {
        self.draining[index] = t.more_chunks;
        response.message = "ENOMEM: upload too large";
        return respond(cmd.quiet, response);
    }
    if (t.more_chunks) {
        var pending: Upload = .{ .screen = screen_id, .first = cmd.*, .id = id, .quiet = cmd.quiet };
        defer pending.deinit(self.alloc);
        pending.first.data = "";
        pending.data.appendSlice(self.alloc, cmd.data) catch {
            self.fatal = true;
            response.message = "ENOMEM: out of memory";
            return respond(cmd.quiet, response);
        };
        slot.* = pending;
        pending.data = .empty;
        return null;
    }
    return respond(cmd.quiet, self.accept(terminal, cmd, cmd.data, id, &response));
}

fn accept(self: *Self, terminal: *ghostty.Terminal, cmd: *const gfx.Command, bytes: []const u8, id: u32, response: *gfx.Response) gfx.Response {
    const t = cmd.transmission().?;
    const image = inspect(t, bytes) catch |err| {
        response.message = switch (err) {
            error.TooLarge => "ENOMEM: image too large",
            else => "EINVAL: invalid image data",
        };
        return response.*;
    };
    if (cmd.control == .query) return response.*;
    const screen = terminal.screens.active;
    const storage = &screen.kitty_images;
    const implicit = t.image_id == 0 and t.image_number == 0;
    if (storage.images.count() >= max_images and storage.imageById(id) == null) {
        response.message = "ENOSPC: image storage full";
        return response.*;
    }
    // Ghostty also reports storage bounds as OutOfMemory; allocator failures remain fatal.
    if (image.decoded_bytes > storage.total_limit) {
        response.message = "ENOMEM: image storage full";
        return response.*;
    }
    const value: gfx.Image = .{
        .id = id,
        .number = t.image_number,
        .width = image.width,
        .height = image.height,
        .format = .rgba,
        .data = .{ .pending = image.decoded_bytes },
        .metadata = .{ .transient = t.usage.transient, .implicit_id = implicit },
    };
    const copy = self.alloc.dupe(u8, bytes) catch {
        self.fatal = true;
        response.message = "ENOMEM: out of memory";
        return response.*;
    };
    var copy_owned = true;
    defer if (copy_owned) self.alloc.free(copy);
    self.sources.ensureUnusedCapacity(self.alloc, 1) catch {
        self.fatal = true;
        response.message = "ENOMEM: out of memory";
        return response.*;
    };
    const pending = storage.addPendingImage(terminal.io(), self.alloc, screen, value) catch {
        self.fatal = true;
        response.message = "ENOMEM: image storage full";
        return response.*;
    };
    const key: Key = .{ .screen = @intFromPtr(screen), .id = pending.id };
    if (self.sources.fetchPutAssumeCapacity(key, .{
        .bytes = copy,
        .transmission = pending.transmission,
        .width = image.width,
        .height = image.height,
        .format = t.format,
        .codec = image.codec,
        .compression = t.compression,
        .png_size = if (t.format == .png) t.size else 0,
    })) |replaced| {
        self.source_bytes -= replaced.value.bytes.len;
        self.alloc.free(replaced.value.bytes);
    }
    copy_owned = false;
    self.source_bytes += bytes.len;
    self.reconcile(terminal);
    while (self.source_bytes > source_limit) self.discardOldest();
    if (cmd.display()) |original| {
        if (storage.placements.count() >= max_placements) {
            response.message = "ENOSPC: placement storage full";
            return response.*;
        }
        var display = original;
        display.image_id = id;
        const display_cmd: gfx.Command = .{ .control = .{ .display = display } };
        if (gfx.execute(terminal.io(), self.alloc, terminal, &display_cmd)) |display_result| {
            if (!display_result.ok()) return display_result;
        }
    }
    response.id = id;
    if (implicit) return .{};
    return response.*;
}

fn reconcile(self: *Self, terminal: *ghostty.Terminal) void {
    var it = self.sources.iterator();
    while (it.next()) |entry| {
        var found = false;
        var screens = terminal.screens.all.iterator();
        while (screens.next()) |screen| {
            if (@intFromPtr(screen.value.*) != entry.key_ptr.screen) continue;
            if (screen.value.*.kitty_images.imageById(entry.key_ptr.id)) |image| {
                found = image.transmission == entry.value_ptr.transmission;
            }
            break;
        }
        if (!found) {
            const key = entry.key_ptr.*;
            const stale = self.sources.fetchRemove(key).?.value;
            self.source_bytes -= stale.bytes.len;
            self.alloc.free(stale.bytes);
            it = self.sources.iterator();
        }
    }
}

fn discardOldest(self: *Self) void {
    var oldest_key: ?Key = null;
    var oldest_transmission: u64 = std.math.maxInt(u64);
    var it = self.sources.iterator();
    while (it.next()) |item| {
        if (item.value_ptr.transmission >= oldest_transmission) continue;
        oldest_transmission = item.value_ptr.transmission;
        oldest_key = item.key_ptr.*;
    }
    const stale = self.sources.fetchRemove(oldest_key.?).?.value;
    self.source_bytes -= stale.bytes.len;
    self.alloc.free(stale.bytes);
}

pub const Inspection = struct { width: u32, height: u32, decoded_bytes: usize, codec: Codec };

/// Validates a complete upload's bytes as `execute` will before accepting it.
/// Encoded images are checked only as far as their headers; browsers decode
/// the rest.
pub fn inspect(t: Transmission, bytes: []const u8) error{ InvalidData, TooLarge }!Inspection {
    var width = t.width;
    var height = t.height;
    var codec: Codec = .raw;
    if (t.format == .png) {
        var buffer: [33]u8 = undefined;
        const header: []const u8 = if (t.compression == .zlib_deflate) blk: {
            if (t.size < buffer.len or t.size > source_limit) return error.TooLarge;
            var input: std.Io.Reader = .fixed(bytes);
            var window: [std.compress.flate.max_window_len]u8 = undefined;
            var inflater: std.compress.flate.Decompress = .init(&input, .zlib, &window);
            inflater.reader.readSliceAll(&buffer) catch return error.InvalidData;
            break :blk &buffer;
        } else bytes[0..@min(bytes.len, buffer.len)];
        const size = pngSize(header) orelse
            webpSize(header, if (t.compression == .zlib_deflate) t.size else bytes.len) orelse
            return error.InvalidData;
        width = size.width;
        height = size.height;
        codec = size.codec;
    }
    if (width == 0 or height == 0 or width > side_limit or height > side_limit) return error.InvalidData;
    const decoded = @as(usize, width) * height * (if (t.format == .rgb) @as(usize, 3) else 4);
    if (decoded > image_limit) return error.TooLarge;
    if (t.format != .png and t.compression == .none and bytes.len != decoded) return error.InvalidData;
    if (t.compression == .zlib_deflate) try validateInflated(bytes, if (t.format == .png) t.size else decoded);
    return .{ .width = width, .height = height, .decoded_bytes = decoded, .codec = codec };
}

const EncodedSize = struct { width: u32, height: u32, codec: Codec };

fn pngSize(png: []const u8) ?EncodedSize {
    if (png.len < 33 or !std.mem.eql(u8, png[0..8], "\x89PNG\r\n\x1a\n") or
        std.mem.readInt(u32, png[8..12], .big) != 13 or !std.mem.eql(u8, png[12..16], "IHDR") or
        std.hash.Crc32.hash(png[12..29]) != std.mem.readInt(u32, png[29..33], .big)) return null;
    return .{
        .width = std.mem.readInt(u32, png[16..20], .big),
        .height = std.mem.readInt(u32, png[20..24], .big),
        .codec = .png,
    };
}

/// Reads the canvas size of a still WebP image from its first bytes. `len` is
/// the whole image's length, which its RIFF header must state exactly.
fn webpSize(header: []const u8, len: usize) ?EncodedSize {
    if (header.len < 25 or !std.mem.eql(u8, header[0..4], "RIFF") or !std.mem.eql(u8, header[8..12], "WEBP")) return null;
    const riff_size = std.mem.readInt(u32, header[4..8], .little);
    const chunk_size = std.mem.readInt(u32, header[16..20], .little);
    if (riff_size < 12 or @as(usize, riff_size) + 8 != len or chunk_size > riff_size - 12) return null;
    const fourcc = header[12..16];
    if (std.mem.eql(u8, fourcc, "VP8L")) {
        // Lossless: signature byte, then 14-bit width-1, height-1, alpha bit and a zero version.
        const bits = std.mem.readInt(u32, header[21..25], .little);
        if (chunk_size < 5 or header[20] != 0x2f or bits >> 29 != 0) return null;
        return .{ .width = (bits & 0x3fff) + 1, .height = ((bits >> 14) & 0x3fff) + 1, .codec = .webp };
    }
    if (header.len < 30 or chunk_size < 10) return null;
    if (std.mem.eql(u8, fourcc, "VP8 ")) {
        // Lossy: a shown key frame of a known version, its start code, then 14-bit sizes.
        const tag = std.mem.readInt(u24, header[20..23], .little);
        if (tag & 1 != 0 or (tag >> 1) & 7 > 3 or (tag >> 4) & 1 == 0 or
            !std.mem.eql(u8, header[23..26], "\x9d\x01\x2a")) return null;
        return .{
            .width = std.mem.readInt(u16, header[26..28], .little) & 0x3fff,
            .height = std.mem.readInt(u16, header[28..30], .little) & 0x3fff,
            .codec = .webp,
        };
    }
    if (std.mem.eql(u8, fourcc, "VP8X")) {
        // Extended: flags (animation unsupported), then 24-bit canvas width-1, height-1.
        if (header[20] & 0x02 != 0) return null;
        return .{
            .width = std.mem.readInt(u24, header[24..27], .little) + 1,
            .height = std.mem.readInt(u24, header[27..30], .little) + 1,
            .codec = .webp,
        };
    }
    return null;
}

fn validateInflated(bytes: []const u8, expected: usize) error{ InvalidData, TooLarge }!void {
    if (expected > source_limit) return error.TooLarge;
    var input: std.Io.Reader = .fixed(bytes);
    var window: [std.compress.flate.max_window_len]u8 = undefined;
    var inflater: std.compress.flate.Decompress = .init(&input, .zlib, &window);
    var scratch: [4096]u8 = undefined;
    var total: usize = 0;
    while (true) {
        const count = inflater.reader.readSliceShort(&scratch) catch return error.InvalidData;
        if (count == 0) break;
        if (count > expected - total) return error.InvalidData;
        total += count;
    }
    if (total != expected) return error.InvalidData;
}

test "graphics rejected upload drains through final chunk without blocking other commands" {
    const testing = std.testing;
    const alloc = testing.allocator;
    const cases = [_]struct { id: u32, number: u32, quiet: gfx.Command.Quiet }{
        .{ .id = 42, .number = 0, .quiet = .no },
        .{ .id = 0, .number = 77, .quiet = .ok },
        .{ .id = 42, .number = 0, .quiet = .failures },
    };
    const chunk = try alloc.alloc(u8, apc_limit / 2);
    defer alloc.free(chunk);
    @memset(chunk, 0);
    for (cases) |case| {
        var terminal = try ghostty.Terminal.init(testing.io, alloc, .{ .cols = 20, .rows = 8 });
        defer terminal.deinit(alloc);
        terminal.setKittyGraphicsSizeLimit(alloc, image_limit);
        var adapter = Self.init(alloc);
        defer adapter.deinit();
        var valid: gfx.Command = .{ .control = .{ .transmit = .{ .image_id = 99, .width = 1, .height = 1 } }, .data = "\x01\x02\x03\xff" };
        try testing.expectEqualStrings("OK", adapter.execute(&terminal, &valid).?.message);
        var first: gfx.Command = .{ .control = .{ .transmit = .{
            .image_id = case.id,
            .image_number = case.number,
            .placement_id = 7,
            .width = 2,
            .height = 1,
            .more_chunks = true,
        } }, .quiet = case.quiet, .data = chunk };
        try testing.expect(adapter.execute(&terminal, &first) == null);
        var continuation: gfx.Command = .{ .control = .{ .transmit = .{ .more_chunks = true } }, .data = chunk };
        for (1..upload_limit / chunk.len) |_| try testing.expect(adapter.execute(&terminal, &continuation) == null);
        const rejected = adapter.execute(&terminal, &continuation);
        try testing.expect(!adapter.fatal);
        try testing.expect(!adapter.safeToCapture());
        if (case.quiet == .failures) {
            try testing.expect(rejected == null);
        } else {
            try testing.expect(rejected != null);
            try testing.expectEqualStrings("ENOMEM: upload too large", rejected.?.message);
            try testing.expectEqual(case.id, rejected.?.id);
            try testing.expectEqual(case.number, rejected.?.image_number);
            try testing.expectEqual(@as(u32, 7), rejected.?.placement_id);
        }
        var query: gfx.Command = .{ .control = .{ .query = .{ .image_id = 99, .width = 1, .height = 1 } }, .data = valid.data };
        try testing.expectEqualStrings("OK", adapter.execute(&terminal, &query).?.message);
        var deletion = try gfx.CommandParser.parseString(alloc, "a=d,d=I,i=99");
        defer deletion.deinit(alloc);
        _ = adapter.execute(&terminal, &deletion);
        try testing.expect(terminal.screens.active.kitty_images.imageById(99) == null);
        try testing.expect(!adapter.safeToCapture());
        var tail: gfx.Command = .{ .control = .{ .transmit = .{ .image_id = 55, .width = 1, .height = 1, .more_chunks = true } }, .data = valid.data };
        try testing.expect(adapter.execute(&terminal, &tail) == null);
        try testing.expect(!adapter.safeToCapture());
        var final_chunk: gfx.Command = .{ .control = .{ .transmit = .{} } };
        try testing.expect(adapter.execute(&terminal, &final_chunk) == null);
        try testing.expect(adapter.safeToCapture());
        try testing.expectEqual(@as(usize, 0), terminal.screens.active.kitty_images.images.count());
        try testing.expectEqualStrings("OK", adapter.execute(&terminal, &valid).?.message);
        try testing.expectEqualStrings("OK", adapter.execute(&terminal, &query).?.message);
        const image = terminal.screens.active.kitty_images.imageById(99).?;
        try testing.expectEqualStrings(valid.data, adapter.source(terminal.screens.active, 99, image.transmission).?.bytes);
        var stream = ghostty.TerminalStream.init(.{ .allocator = alloc, .handler = terminal.vtHandler() });
        defer stream.deinit();
        stream.nextSlice("X");
        try testing.expectEqual(@as(u21, 'X'), terminal.screens.active.pages.getCell(.{ .active = .{ .x = 0, .y = 0 } }).?.cell.codepoint());
        try testing.expect(!adapter.fatal);
    }
}

test "graphics storage byte limit returns a protocol error and permits later uploads" {
    const testing = std.testing;
    const alloc = testing.allocator;
    var terminal = try ghostty.Terminal.init(testing.io, alloc, .{ .cols = 20, .rows = 8 });
    defer terminal.deinit(alloc);
    terminal.setKittyGraphicsSizeLimit(alloc, 3);
    var adapter = Self.init(alloc);
    defer adapter.deinit();
    var valid: gfx.Command = .{ .control = .{ .transmit = .{ .image_id = 42, .width = 1, .height = 1 } }, .data = "\x01\x02\x03\xff" };
    try testing.expectEqualStrings("ENOMEM: image storage full", adapter.execute(&terminal, &valid).?.message);
    try testing.expect(!adapter.fatal);
    try testing.expectEqual(@as(usize, 0), terminal.screens.active.kitty_images.images.count());
    terminal.setKittyGraphicsSizeLimit(alloc, image_limit);
    try testing.expectEqualStrings("OK", adapter.execute(&terminal, &valid).?.message);
    try testing.expect(!adapter.fatal);
}
