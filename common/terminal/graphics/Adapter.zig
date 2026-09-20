const std = @import("std");
const ghostty = @import("ghostty-vt");
const gfx = ghostty.kitty.graphics;
const Self = @This();
const Transmission = @FieldType(gfx.Command.Control, "transmit");
const Format = @FieldType(Transmission, "format");
const Compression = @FieldType(Transmission, "compression");

const image_limit = 16 * 1024 * 1024;
const upload_limit = 8 * 1024 * 1024;
const source_limit = 32 * 1024 * 1024;
const side_limit = 4096;
const max_images = 512;
const max_placements = 2048;

const Key = struct {
    screen: usize,
    id: u32,
};

pub const Source = struct {
    bytes: []const u8,
    generation: u64,
    width: u32,
    height: u32,
    format: Format,
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

pub fn source(self: *const Self, screen: *ghostty.Screen, image_id: u32, generation: u64) ?Source {
    const value = self.sources.get(.{ .screen = @intFromPtr(screen), .id = image_id }) orelse return null;
    return if (value.generation == generation) value else null;
}

pub fn safeToCapture(self: *const Self) bool {
    return self.loading[0] == null and self.loading[1] == null;
}

pub fn execute(self: *Self, terminal: *ghostty.Terminal, cmd: *gfx.Command) ?gfx.Response {
    self.reconcile(terminal);
    const ids = cmd.control.identifiers();
    if (ids.image_id != 0 and ids.image_number != 0) {
        return respond(cmd.quiet, .{ .id = ids.image_id, .image_number = ids.image_number, .placement_id = ids.placement_id, .message = "EINVAL: image ID and number are mutually exclusive" });
    }
    switch (cmd.control) {
        .display, .delete => {
            self.state_changed = true;
            if (cmd.control == .delete) {
                const slot = &self.loading[@intFromEnum(terminal.screens.active_key)];
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
    const slot = &self.loading[@intFromEnum(terminal.screens.active_key)];
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
            pending.deinit(self.alloc);
            slot.* = null;
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
        .generation = pending.generation,
        .width = image.width,
        .height = image.height,
        .format = t.format,
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
                found = image.generation == entry.value_ptr.generation;
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
    var oldest_generation: u64 = std.math.maxInt(u64);
    var it = self.sources.iterator();
    while (it.next()) |item| {
        if (item.value_ptr.generation >= oldest_generation) continue;
        oldest_generation = item.value_ptr.generation;
        oldest_key = item.key_ptr.*;
    }
    const stale = self.sources.fetchRemove(oldest_key.?).?.value;
    self.source_bytes -= stale.bytes.len;
    self.alloc.free(stale.bytes);
}

const Inspection = struct { width: u32, height: u32, decoded_bytes: usize };

fn inspect(t: Transmission, bytes: []const u8) error{ InvalidData, TooLarge }!Inspection {
    var width = t.width;
    var height = t.height;
    if (t.format == .png) {
        var header: [33]u8 = undefined;
        const png: []const u8 = if (t.compression == .zlib_deflate) blk: {
            if (t.size < header.len or t.size > source_limit) return error.TooLarge;
            var input: std.Io.Reader = .fixed(bytes);
            var window: [std.compress.flate.max_window_len]u8 = undefined;
            var inflater: std.compress.flate.Decompress = .init(&input, .zlib, &window);
            inflater.reader.readSliceAll(&header) catch return error.InvalidData;
            break :blk &header;
        } else bytes;
        if (png.len < 33 or !std.mem.eql(u8, png[0..8], "\x89PNG\r\n\x1a\n") or
            std.mem.readInt(u32, png[8..12], .big) != 13 or !std.mem.eql(u8, png[12..16], "IHDR") or
            std.hash.crc.Crc32.hash(png[12..29]) != std.mem.readInt(u32, png[29..33], .big)) return error.InvalidData;
        width = std.mem.readInt(u32, png[16..20], .big);
        height = std.mem.readInt(u32, png[20..24], .big);
    }
    if (width == 0 or height == 0 or width > side_limit or height > side_limit) return error.InvalidData;
    const decoded = @as(usize, width) * height * (if (t.format == .rgb) @as(usize, 3) else 4);
    if (decoded > image_limit) return error.TooLarge;
    if (t.format != .png and t.compression == .none and bytes.len != decoded) return error.InvalidData;
    if (t.compression == .zlib_deflate) try validateInflated(bytes, if (t.format == .png) t.size else decoded);
    return .{ .width = width, .height = height, .decoded_bytes = decoded };
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
