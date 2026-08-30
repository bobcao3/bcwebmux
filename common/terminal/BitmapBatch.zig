// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");
const Self = @This();

const alloc = std.heap.wasm_allocator;

pub const BitmapUpload = extern struct {
    first_slot: u32,
    slot_count: u32,
    pixel_offset: u32,
    bytes_per_row: u32,
};

const BitmapTile = extern struct {
    slot: u32,
    width: u32,
    height: u32,
    stride: u32,
    pixel_offset: u32,
    pixel_len: u32,
};

font_cell_width: u16 = 0,
font_cell_height: u16 = 0,
atlas_columns: u16 = 0,
tiles: std.ArrayListUnmanaged(BitmapTile) = .empty,
packed_uploads: std.ArrayListUnmanaged(BitmapUpload) = .empty,
pixels: std.ArrayListUnmanaged(u8) = .empty,
upload_pixels: std.ArrayListUnmanaged(u8) = .empty,

comptime {
    std.debug.assert(@sizeOf(BitmapUpload) == 16);
    std.debug.assert(@sizeOf(BitmapTile) == 24);
}

pub fn bootstrap(self: *Self) void {
    self.font_cell_width = 0;
    self.font_cell_height = 0;
    self.atlas_columns = 0;
    self.tiles = .empty;
    self.packed_uploads = .empty;
    self.pixels = .empty;
    self.upload_pixels = .empty;
}

pub fn deinit(self: *Self) void {
    self.tiles.deinit(alloc);
    self.packed_uploads.deinit(alloc);
    self.pixels.deinit(alloc);
    self.upload_pixels.deinit(alloc);
    self.bootstrap();
}

pub fn setMetrics(self: *Self, cell_width: u16, cell_height: u16, columns: u16) void {
    self.font_cell_width = cell_width;
    self.font_cell_height = cell_height;
    self.atlas_columns = columns;
}

pub fn reset(self: *Self) void {
    self.tiles.clearRetainingCapacity();
    self.packed_uploads.clearRetainingCapacity();
    self.pixels.clearRetainingCapacity();
    self.upload_pixels.clearRetainingCapacity();
}

pub fn append(self: *Self, slot: u32, mask: []const u8, source_offset: usize, width: u32, height: u32, stride: u32) !void {
    const row_len: usize = @intCast(width);
    const rows: usize = @intCast(height);
    const pixel_len = std.math.mul(usize, row_len, rows) catch return error.BitmapBatchFull;
    const pixel_offset = self.pixels.items.len;
    const new_len = std.math.add(usize, pixel_offset, pixel_len) catch return error.BitmapBatchFull;
    try self.pixels.ensureTotalCapacity(alloc, new_len);
    self.pixels.items.len = new_len;
    for (0..rows) |row| {
        const source = std.math.add(usize, source_offset, std.math.mul(usize, row, @intCast(stride)) catch return error.BitmapBatchFull) catch return error.BitmapBatchFull;
        @memcpy(self.pixels.items[pixel_offset + row * row_len ..][0..row_len], mask[source..][0..row_len]);
    }
    try self.tiles.append(alloc, .{
        .slot = slot,
        .width = width,
        .height = height,
        .stride = width,
        .pixel_offset = @intCast(pixel_offset),
        .pixel_len = @intCast(pixel_len),
    });
}

pub fn pack(self: *Self) !void {
    self.packed_uploads.clearRetainingCapacity();
    if (self.tiles.items.len == 0) return;
    if (self.atlas_columns == 0) return error.BitmapBatchFull;

    const tile_width: usize = @intCast(self.font_cell_width);
    const cell_height: usize = @intCast(self.font_cell_height);
    const columns: u32 = @intCast(self.atlas_columns);
    var expanded_size: usize = 0;
    var tile_index: usize = 0;
    while (tile_index < self.tiles.items.len) {
        const first_slot = self.tiles.items[tile_index].slot;
        const atlas_row = first_slot / columns;
        var end = std.math.add(usize, tile_index, 1) catch return error.BitmapBatchFull;
        while (end < self.tiles.items.len) {
            const previous_slot = self.tiles.items[end - 1].slot;
            const next_slot = std.math.add(u32, previous_slot, 1) catch break;
            const current_slot = self.tiles.items[end].slot;
            if (current_slot != next_slot or current_slot / columns != atlas_row) break;
            end = std.math.add(usize, end, 1) catch return error.BitmapBatchFull;
        }
        const slot_count = end - tile_index;
        const bytes_per_row = std.math.mul(usize, slot_count, tile_width) catch return error.BitmapBatchFull;
        const group_size = std.math.mul(usize, bytes_per_row, cell_height) catch return error.BitmapBatchFull;
        const pixel_offset = expanded_size;
        expanded_size = std.math.add(usize, expanded_size, group_size) catch return error.BitmapBatchFull;
        try self.packed_uploads.append(alloc, .{
            .first_slot = first_slot,
            .slot_count = std.math.cast(u32, slot_count) orelse return error.BitmapBatchFull,
            .pixel_offset = std.math.cast(u32, pixel_offset) orelse return error.BitmapBatchFull,
            .bytes_per_row = std.math.cast(u32, bytes_per_row) orelse return error.BitmapBatchFull,
        });
        tile_index = end;
    }

    try self.upload_pixels.ensureTotalCapacity(alloc, expanded_size);
    self.upload_pixels.items.len = expanded_size;
    @memset(self.upload_pixels.items, 0);

    var copy_tile_index: usize = 0;
    for (self.packed_uploads.items) |upload| {
        const group_count: usize = @intCast(upload.slot_count);
        if (group_count > self.tiles.items.len - copy_tile_index) return error.BitmapBatchFull;
        const bytes_per_row: usize = @intCast(upload.bytes_per_row);
        const upload_offset: usize = @intCast(upload.pixel_offset);
        for (0..group_count) |local| {
            const tile = self.tiles.items[copy_tile_index + local];
            const width: usize = @intCast(tile.width);
            const height: usize = @intCast(tile.height);
            const stride: usize = @intCast(tile.stride);
            if (width > tile_width or height > cell_height) return error.BitmapBatchFull;
            const source_offset: usize = @intCast(tile.pixel_offset);
            const x_offset = std.math.mul(usize, local, tile_width) catch return error.BitmapBatchFull;
            for (0..height) |row| {
                const source_row = std.math.add(usize, source_offset, std.math.mul(usize, row, stride) catch return error.BitmapBatchFull) catch return error.BitmapBatchFull;
                const destination_row = std.math.add(usize, upload_offset, std.math.add(usize, std.math.mul(usize, row, bytes_per_row) catch return error.BitmapBatchFull, x_offset) catch return error.BitmapBatchFull) catch return error.BitmapBatchFull;
                @memcpy(self.upload_pixels.items[destination_row..][0..width], self.pixels.items[source_row..][0..width]);
            }
        }
        copy_tile_index += group_count;
    }
    if (copy_tile_index != self.tiles.items.len) return error.BitmapBatchFull;
}

pub fn uploads(self: *const Self) []const BitmapUpload {
    return self.packed_uploads.items;
}

pub fn uploadPixels(self: *const Self) []const u8 {
    return self.upload_pixels.items;
}
