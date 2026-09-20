const std = @import("std");
const ghostty = @import("ghostty-vt");
const gfx = ghostty.kitty.graphics;

const max_images = 512;
const max_placements = 2048;
const max_bytes = 256 * 1024;
const image_limit = 16 * 1024 * 1024;

const ImageRecord = struct {
    image: gfx.Image,
};

fn oldestFirst(_: void, left: ImageRecord, right: ImageRecord) bool {
    return left.image.generation < right.image.generation;
}

fn put(writer: *std.Io.Writer, comptime T: type, value: T) !void {
    var buffer: [@sizeOf(T)]u8 = undefined;
    std.mem.writeInt(T, &buffer, value, .little);
    try writer.writeAll(&buffer);
}

const Reader = struct {
    data: []const u8,
    offset: usize = 0,

    fn take(self: *Reader, comptime T: type) !T {
        if (@sizeOf(T) > self.data.len - self.offset) return error.InvalidCheckpoint;
        const result = std.mem.readInt(T, self.data[self.offset..][0..@sizeOf(T)], .little);
        self.offset += @sizeOf(T);
        return result;
    }
};

pub fn encode(alloc: std.mem.Allocator, writer: *std.Io.Writer, terminal: *const ghostty.Terminal) !void {
    try writer.writeAll("KGCP");
    try put(writer, u32, 1);
    const keys = [_]ghostty.ScreenSet.Key{ .primary, .alternate };
    for (keys) |key| {
        const screen = terminal.screens.get(key) orelse {
            try put(writer, u32, 0);
            continue;
        };
        const storage = &screen.kitty_images;
        const image_count = storage.images.count();
        const placement_count = storage.placements.count();
        if (image_count > max_images or placement_count > max_placements or storage.total_limit > image_limit) return error.GraphicsLimit;
        try put(writer, u32, 1);
        try put(writer, u32, @intCast(storage.total_limit));
        try put(writer, u32, storage.next_image_id);
        try put(writer, u32, storage.next_internal_placement_id);
        try put(writer, u32, @intCast(image_count));
        const images = try alloc.alloc(ImageRecord, image_count);
        defer alloc.free(images);
        var images_it = storage.images.valueIterator();
        for (images) |*slot| slot.* = .{ .image = images_it.next().?.* };
        std.mem.sort(ImageRecord, images, {}, oldestFirst);
        for (images) |record| {
            const image = record.image;
            if (!image.data.isPending() or image.animation != null or image.data.len() > image_limit) return error.GraphicsLimit;
            try put(writer, u32, image.id);
            try put(writer, u32, image.number);
            try put(writer, u32, image.width);
            try put(writer, u32, image.height);
            try put(writer, u32, @intCast(image.data.len()));
            try put(writer, u32, @intFromBool(image.metadata.transient) | (@as(u32, @intFromBool(image.metadata.implicit_id)) << 1));
        }
        try put(writer, u32, @intCast(placement_count));
        var it = storage.placements.iterator();
        while (it.next()) |item| {
            const p = item.value_ptr.*;
            const id = item.key_ptr.*;
            try put(writer, u32, id.image_id);
            try put(writer, u32, id.placement_id.id);
            try put(writer, u32, @intFromEnum(id.placement_id.tag));
            try put(writer, u32, p.x_offset);
            try put(writer, u32, p.y_offset);
            try put(writer, u32, p.source_x);
            try put(writer, u32, p.source_y);
            try put(writer, u32, p.source_width);
            try put(writer, u32, p.source_height);
            try put(writer, u32, p.columns);
            try put(writer, u32, p.rows);
            try put(writer, i32, p.z);
            switch (p.location) {
                .pin => |pin| {
                    if (pin.garbage) {
                        try put(writer, u32, 3);
                        try put(writer, u32, 0);
                        try put(writer, u32, 0);
                        try put(writer, u32, 0);
                        try put(writer, u32, 0);
                    } else {
                        const position = screen.pages.pointFromPin(.screen, pin.*) orelse return error.InvalidCheckpoint;
                        try put(writer, u32, 0);
                        try put(writer, u32, position.screen.x);
                        try put(writer, u32, position.screen.y);
                        try put(writer, u32, 0);
                        try put(writer, u32, 0);
                    }
                },
                .virtual => {
                    try put(writer, u32, 1);
                    for (0..4) |_| try put(writer, u32, 0);
                },
                .relative => |rel| {
                    try put(writer, u32, 2);
                    try put(writer, u32, rel.parent.image_id);
                    try put(writer, u32, rel.parent.placement_id.id);
                    try put(writer, u32, @intFromEnum(rel.parent.placement_id.tag));
                    try put(writer, i32, rel.horizontal_offset);
                    try put(writer, i32, rel.vertical_offset);
                },
            }
        }
    }
}

pub fn restore(alloc: std.mem.Allocator, terminal: *ghostty.Terminal, bytes: []const u8) !void {
    if (bytes.len > max_bytes or bytes.len < 8 or !std.mem.eql(u8, bytes[0..4], "KGCP")) return error.InvalidCheckpoint;
    var reader: Reader = .{ .data = bytes, .offset = 4 };
    if (try reader.take(u32) != 1) return error.InvalidCheckpoint;
    const keys = [_]ghostty.ScreenSet.Key{ .primary, .alternate };
    for (keys) |key| {
        const present = try reader.take(u32);
        if (present == 0) continue;
        if (present != 1) return error.InvalidCheckpoint;
        const screen = terminal.screens.get(key) orelse return error.InvalidCheckpoint;
        const storage = &screen.kitty_images;
        const limit = try reader.take(u32);
        const next_image_id = try reader.take(u32);
        const next_placement_id = try reader.take(u32);
        const image_count = try reader.take(u32);
        if (limit > image_limit or image_count > max_images or storage.images.count() != 0) return error.InvalidCheckpoint;
        storage.setLimit(terminal.io(), alloc, screen, limit);
        var total: u64 = 0;
        for (0..image_count) |_| {
            const id = try reader.take(u32);
            const number = try reader.take(u32);
            const width = try reader.take(u32);
            const height = try reader.take(u32);
            const size = try reader.take(u32);
            const flags = try reader.take(u32);
            if (id == 0 or width == 0 or height == 0 or width > 4096 or height > 4096 or
                size > image_limit or flags > 3 or storage.images.contains(id)) return error.InvalidCheckpoint;
            total += size;
            if (total > limit) return error.InvalidCheckpoint;
            _ = try storage.addPendingImage(terminal.io(), alloc, screen, .{
                .id = id,
                .number = number,
                .width = width,
                .height = height,
                .format = .rgba,
                .data = .{ .pending = size },
                .metadata = .{ .transient = flags & 1 != 0, .implicit_id = flags & 2 != 0 },
            });
        }
        if (storage.images.count() != image_count or storage.total_bytes != total) return error.InvalidCheckpoint;
        storage.next_image_id = next_image_id;
        const placement_count = try reader.take(u32);
        if (placement_count > max_placements) return error.InvalidCheckpoint;
        try storage.placements.ensureUnusedCapacity(alloc, placement_count);
        for (0..placement_count) |_| {
            const image_id = try reader.take(u32);
            const placement_id = try reader.take(u32);
            const tag = try reader.take(u32);
            const x_offset = try reader.take(u32);
            const y_offset = try reader.take(u32);
            const source_x = try reader.take(u32);
            const source_y = try reader.take(u32);
            const source_width = try reader.take(u32);
            const source_height = try reader.take(u32);
            const columns = try reader.take(u32);
            const rows = try reader.take(u32);
            const z = try reader.take(i32);
            const kind = try reader.take(u32);
            const a = try reader.take(u32);
            const b = try reader.take(u32);
            const c = try reader.take(u32);
            const d = try reader.take(i32);
            const e = if (kind == 2) try reader.take(i32) else @as(i32, 0);
            if (tag > 1 or (kind == 2 and c > 1)) return error.InvalidCheckpoint;
            const key_: gfx.ImageStorage.PlacementKey = .{
                .image_id = image_id,
                .placement_id = .{ .tag = if (tag == 0) .internal else .external, .id = placement_id },
            };
            const image = storage.images.getPtr(image_id) orelse return error.InvalidCheckpoint;
            if (storage.placements.contains(key_)) return error.InvalidCheckpoint;
            var placement: gfx.ImageStorage.Placement = .{
                .location = .virtual,
                .x_offset = x_offset,
                .y_offset = y_offset,
                .source_x = source_x,
                .source_y = source_y,
                .source_width = source_width,
                .source_height = source_height,
                .columns = columns,
                .rows = rows,
                .z = z,
            };
            placement.location = switch (kind) {
                0, 3 => location: {
                    const point = if (kind == 3)
                        screen.pages.getTopLeft(.screen)
                    else
                        screen.pages.pin(.{ .screen = .{ .x = std.math.cast(u16, a) orelse return error.InvalidCheckpoint, .y = b } }) orelse return error.InvalidCheckpoint;
                    const pin = try screen.pages.trackPin(point);
                    if (kind == 3) pin.garbage = true;
                    break :location .{ .pin = pin };
                },
                1 => .virtual,
                2 => .{ .relative = .{
                    .parent = .{ .image_id = a, .placement_id = .{ .tag = if (c == 0) .internal else .external, .id = b } },
                    .horizontal_offset = d,
                    .vertical_offset = e,
                } },
                else => return error.InvalidCheckpoint,
            };
            storage.placements.putAssumeCapacity(key_, placement);
            image.metadata.placement_count += 1;
        }
        storage.next_internal_placement_id = next_placement_id;
        storage.dirty = true;
    }
    if (reader.offset != bytes.len) return error.InvalidCheckpoint;
}
