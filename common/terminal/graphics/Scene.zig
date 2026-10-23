const std = @import("std");
const ghostty = @import("ghostty-vt");
const Graphics = @import("Adapter.zig");
const Self = @This();

/// Kitty's f= value for raw and PNG sources, or this for a WebP payload,
/// which arrives as f=100.
pub const webp_format = 101;

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
    p: ghostty.RenderState.ImagePlacement,
    scale: Scale,
) !void {
    const width = scale.x(p.width);
    const height = scale.y(p.height);
    if (width == 0 or height == 0 or p.source_width == 0 or p.source_height == 0) return;
    if (self.draws.items.len >= 2048) return;
    const screen = terminal.screens.active;
    const resource_source = graphics.source(screen, image.id, image.transmission) orelse return;
    var resource_index: u32 = 0;
    while (resource_index < self.resources.items.len) : (resource_index += 1) {
        if (self.resources.items[resource_index].image_id == image.id) break;
    }
    if (resource_index == self.resources.items.len) {
        if (self.resources.items.len >= 512) return;
        try self.resources.append(alloc, .{
            .screen = @backingInt(terminal.screens.active_key),
            .image_id = image.id,
            .generation_low = @truncate(p.image_generation),
            .generation_high = @truncate(p.image_generation >> 32),
            .width = resource_source.width,
            .height = resource_source.height,
            .format = switch (resource_source.format) {
                .rgb => 24,
                .rgba => 32,
                .png => if (resource_source.codec == .webp) webp_format else 100,
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
        .z = p.z,
        .x = p.x,
        .y = p.y,
        .width = width,
        .height = height,
        .source_x = p.source_x,
        .source_y = p.source_y,
        .source_width = p.source_width,
        .source_height = p.source_height,
        .cell_offset_x = scale.x(p.offset_x),
        .cell_offset_y = scale.y(p.offset_y),
    });
}

/// Ghostty lays images out in the terminal's cell size, but the browser
/// positions draws in glyph cells, so pixel lengths convert between them.
const Scale = struct {
    terminal_cell: [2]u32,
    glyph_cell: [2]u32,

    fn x(self: Scale, value: u32) u32 {
        return @intCast(@as(u64, value) * self.glyph_cell[0] / self.terminal_cell[0]);
    }

    fn y(self: Scale, value: u32) u32 {
        return @intCast(@as(u64, value) * self.glyph_cell[1] / self.terminal_cell[1]);
    }
};

pub fn prepare(self: *Self, alloc: std.mem.Allocator, state: *const ghostty.RenderState, terminal: *ghostty.Terminal, graphics: *Graphics, cell_width: u32, cell_height: u32) !void {
    self.resources.clearRetainingCapacity();
    self.draws.clearRetainingCapacity();
    if (cell_width == 0 or cell_height == 0 or terminal.cols == 0 or terminal.rows == 0) return;
    const scale: Scale = .{
        .terminal_cell = .{ terminal.width_px / terminal.cols, terminal.height_px / terminal.rows },
        .glyph_cell = .{ cell_width, cell_height },
    };
    if (scale.terminal_cell[0] == 0 or scale.terminal_cell[1] == 0) return;
    const storage = &terminal.screens.active.kitty_images;
    var it = state.imagePlacementIterator();
    while (it.next()) |p| {
        // Cell backgrounds are opaque and would hide these entirely.
        if (p.layer == .below_background) continue;
        if (p.x >= terminal.cols or p.x + @as(i64, p.cols) <= 0) continue;
        const image = switch (p.protocol) {
            .kitty => storage.imageById(p.image_id) orelse continue,
        };
        try self.append(alloc, terminal, graphics, image, p, scale);
    }
    std.mem.sort(Draw, self.draws.items, self.resources.items, drawLessThan);
}
