const std = @import("std");
const ghostty = @import("ghostty-vt");
const Graphics = @import("Adapter.zig");
const Self = @This();

pub const Resource = extern struct {
    screen: u32,
    image_id: u32,
    generation_low: u32,
    generation_high: u32,
    width: u32,
    height: u32,
    format: u32,
    compression: u32,
    png_size: u32,
    bytes_offset: u32,
    bytes_len: u32,
};

pub const Draw = extern struct {
    resource_index: u32,
    z: i32,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    source_x: u32,
    source_y: u32,
    source_width: u32,
    source_height: u32,
    cell_offset_x: u32,
    cell_offset_y: u32,
};

resources: std.ArrayListUnmanaged(Resource) = .empty,
draws: std.ArrayListUnmanaged(Draw) = .empty,

pub fn deinit(self: *Self, alloc: std.mem.Allocator) void {
    self.resources.deinit(alloc);
    self.draws.deinit(alloc);
    self.* = .{};
}

fn drawLessThan(resources: []const Resource, lhs: Draw, rhs: Draw) bool {
    return lhs.z < rhs.z or (lhs.z == rhs.z and resources[lhs.resource_index].image_id < resources[rhs.resource_index].image_id);
}

fn append(
    self: *Self,
    alloc: std.mem.Allocator,
    terminal: *ghostty.Terminal,
    graphics: *Graphics,
    image: ghostty.kitty.graphics.Image,
    position_x: i32,
    position_y: i32,
    z: i32,
    width: u32,
    height: u32,
    source_x: u32,
    source_y: u32,
    source_width: u32,
    source_height: u32,
    offset_x: u32,
    offset_y: u32,
) !void {
    if (width == 0 or height == 0 or source_width == 0 or source_height == 0 or z < -1073741824) return;
    if (self.draws.items.len >= 2048) return;
    const screen = terminal.screens.active;
    const resource_source = graphics.source(screen, image.id, image.generation) orelse return;
    var resource_index: u32 = 0;
    while (resource_index < self.resources.items.len) : (resource_index += 1) {
        if (self.resources.items[resource_index].image_id == image.id) break;
    }
    if (resource_index == self.resources.items.len) {
        if (self.resources.items.len >= 512) return;
        try self.resources.append(alloc, .{
            .screen = @intFromEnum(terminal.screens.active_key),
            .image_id = image.id,
            .generation_low = @truncate(image.generation),
            .generation_high = @truncate(image.generation >> 32),
            .width = resource_source.width,
            .height = resource_source.height,
            .format = switch (resource_source.format) {
                .rgb => 24,
                .rgba => 32,
                .png => 100,
                .gray_alpha, .gray => unreachable,
            },
            .compression = if (resource_source.compression == .none) 0 else 1,
            .png_size = resource_source.png_size,
            .bytes_offset = @intCast(@intFromPtr(resource_source.bytes.ptr)),
            .bytes_len = @intCast(resource_source.bytes.len),
        });
    }
    try self.draws.append(alloc, .{
        .resource_index = resource_index,
        .z = z,
        .x = position_x,
        .y = position_y,
        .width = width,
        .height = height,
        .source_x = source_x,
        .source_y = source_y,
        .source_width = source_width,
        .source_height = source_height,
        .cell_offset_x = offset_x,
        .cell_offset_y = offset_y,
    });
}

fn placement(
    self: *Self,
    alloc: std.mem.Allocator,
    terminal: *ghostty.Terminal,
    graphics: *Graphics,
    image: ghostty.kitty.graphics.Image,
    p: ghostty.kitty.graphics.ImageStorage.Placement,
    x: i32,
    y: i32,
) !void {
    const size = p.pixelSize(image, terminal);
    const source = p.sourceRect(image);
    const offset = p.cellOffset(terminal);
    try self.append(alloc, terminal, graphics, image, x, y, p.z, size.width, size.height, source.x, source.y, source.width, source.height, offset.x, offset.y);
}

pub fn prepare(self: *Self, alloc: std.mem.Allocator, terminal: *ghostty.Terminal, graphics: *Graphics, cell_width: u32, cell_height: u32) !void {
    self.resources.clearRetainingCapacity();
    self.draws.clearRetainingCapacity();
    const screen = terminal.screens.active;
    const storage = &screen.kitty_images;
    const top = screen.pages.getTopLeft(.viewport);
    const bottom = screen.pages.getBottomRight(.viewport) orelse return;
    const top_y = (screen.pages.pointFromPin(.screen, top) orelse return).screen.y;
    const bottom_y = (screen.pages.pointFromPin(.screen, bottom) orelse return).screen.y;
    var it = storage.placements.iterator();
    while (it.next()) |entry| {
        const image = storage.imageById(entry.key_ptr.image_id) orelse continue;
        const p = entry.value_ptr.*;
        const anchor: struct { pin: *const ghostty.Pin, x: i32, y: i32 } = switch (p.location) {
            .pin => |pin| .{ .pin = pin, .x = 0, .y = 0 },
            .virtual => continue,
            .relative => |relative| relative: {
                const chain = storage.resolveChain(relative) orelse continue;
                const pin = switch (chain.root.location) {
                    .pin => |value| value,
                    .virtual, .relative => continue,
                };
                break :relative .{ .pin = pin, .x = chain.horizontal_offset, .y = chain.vertical_offset };
            },
        };
        if (anchor.pin.garbage) continue;
        const grid = p.gridSize(image, terminal);
        if (grid.cols == 0 or grid.rows == 0) continue;
        const point = screen.pages.pointFromPin(.screen, anchor.pin.*) orelse continue;
        const y = @as(i64, point.screen.y) + anchor.y;
        const x = @as(i64, anchor.pin.x) + anchor.x;
        if (y > bottom_y or y + @as(i64, @intCast(grid.rows)) <= top_y or x >= terminal.cols or x + @as(i64, @intCast(grid.cols)) <= 0) continue;
        try self.placement(alloc, terminal, graphics, image, p, std.math.cast(i32, x) orelse continue, std.math.cast(i32, y - top_y) orelse continue);
    }
    if (cell_width == 0 or cell_height == 0) return;
    var virtual = ghostty.kitty.graphics.unicode.placementIterator(top, bottom);
    while (virtual.next()) |fragment| {
        const image = storage.imageById(fragment.image_id) orelse continue;
        const rendered = fragment.renderPlacement(storage, &image, cell_width, cell_height) catch continue;
        const point = screen.pages.pointFromPin(.viewport, rendered.top_left) orelse continue;
        try self.append(alloc, terminal, graphics, image, @intCast(point.viewport.x), @intCast(point.viewport.y), -1, rendered.dest_width, rendered.dest_height, rendered.source_x, rendered.source_y, rendered.source_width, rendered.source_height, rendered.offset_x, rendered.offset_y);
    }
    std.mem.sort(Draw, self.draws.items, self.resources.items, drawLessThan);
}
