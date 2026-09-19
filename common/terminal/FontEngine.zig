// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");
const Self = @This();

const c = @cImport({
    @cInclude("kb_text_shape.h");
    @cInclude("stb_truetype.h");
});

extern "host" fn font_size(style: u32) u32;
extern "host" fn font_copy(style: u32, ptr: [*]u8, len: u32) i32;

const alloc = std.heap.wasm_allocator;
const max_font_bytes: usize = 16 * 1024 * 1024;

pub const Metrics = struct {
    cell_width: u16,
    cell_height: u16,
    font_size_px: u16, // Integer physical-pixel CSS em size.
};

pub const FontStyle = enum(u2) {
    regular,
    bold,
    italic,
    bold_italic,
};

pub const Input = struct {
    codepoint: u21,
    cell: u16,
};

pub const RenderStats = struct {
    glyphs: u32,
    ligatures: u32,
};

pub const max_layout_glyphs: usize = 128;
pub const max_path_commands: usize = 1024 * 1024;
pub const max_run_path_commands: usize = 32768;

pub const Glyph = struct {
    id: c_int,
    advance_x: i32,
    offset_x: i32,
    offset_y: i32,
    x: f32,
    baseline: f32,
};

pub const Layout = struct {
    style: FontStyle,
    span_cells: u16,
    metrics: Metrics,
    scale_x: f32,
    scale_y: f32,
    baseline: f32,
    glyphs: [max_layout_glyphs]Glyph = undefined,
    count: usize = 0,
    stats: RenderStats,
};

pub const PathCommand = extern struct {
    op: u32,
    x: f32 = 0,
    y: f32 = 0,
    cx: f32 = 0,
    cy: f32 = 0,
    cx1: f32 = 0,
    cy1: f32 = 0,
};

pub const PathOp = enum(u32) {
    move = 0,
    line = 1,
    quadratic = 2,
    cubic = 3,
    close = 4,
};

const Face = struct {
    shape: c.kbts_font,
    raster: c.stbtt_fontinfo,
};

context: ?*c.kbts_shape_context = null,
faces: [4]Face = undefined,
face_ready: [4]bool = [_]bool{false} ** 4,
font_data: [4]?[]u8 = [_]?[]u8{null} ** 4,

pub fn bootstrap(self: *Self) void {
    self.context = null;
    self.face_ready = [_]bool{false} ** 4;
    self.font_data = [_]?[]u8{null} ** 4;
}

pub fn deinit(self: *Self) void {
    for (self.face_ready, 0..) |ready, index| {
        if (ready) c.kbts_FreeFont(&self.faces[index].shape);
    }
    for (self.font_data) |data| {
        if (data) |value| alloc.free(value);
    }
    if (self.context) |context| c.kbts_DestroyShapeContext(context);
    self.bootstrap();
}

pub fn cAlloc(len: usize) ?*anyopaque {
    const total = std.math.add(usize, len, 16) catch return null;
    const allocation = alloc.alignedAlloc(u8, .@"16", total) catch return null;
    @as(*usize, @ptrCast(@alignCast(allocation.ptr))).* = total;
    return @ptrCast(allocation.ptr + 16);
}

pub fn cFree(pointer: ?*anyopaque) void {
    if (pointer) |value| {
        const allocation: [*]align(16) u8 = @ptrFromInt(@intFromPtr(value) - 16);
        const total = @as(*const usize, @ptrCast(@alignCast(allocation))).*;
        alloc.free(allocation[0..total]);
    }
}

fn kbAllocator(_: ?*anyopaque, op: [*c]c.kbts_allocator_op) callconv(.c) void {
    if (op == null) return;
    switch (op.*.Kind) {
        c.KBTS_ALLOCATOR_OP_KIND_ALLOCATE => op.*.unnamed_0.Allocate.Pointer = cAlloc(op.*.unnamed_0.Allocate.Size),
        c.KBTS_ALLOCATOR_OP_KIND_FREE => cFree(op.*.unnamed_0.Free.Pointer),
        else => {},
    }
}

pub fn init(self: *Self) !void {
    if (self.context != null) return;
    self.context = c.kbts_CreateShapeContext(&kbAllocator, null) orelse return error.ShapeContextInitFailed;
}

fn loadFont(self: *Self, index: usize) ![]u8 {
    if (self.font_data[index]) |existing| return existing;

    const size_raw = font_size(@intCast(index));
    if (size_raw == 0) return error.FontDataMissing;
    const size = std.math.cast(usize, size_raw) orelse return error.FontTooLarge;
    if (size > max_font_bytes) return error.FontTooLarge;

    const data = try alloc.alloc(u8, size);
    errdefer alloc.free(data);
    if (font_copy(@intCast(index), data.ptr, size_raw) != 1)
        return error.FontCopyFailed;
    self.font_data[index] = data;
    return data;
}

fn ensureFace(self: *Self, style: FontStyle) !*Face {
    const index = @intFromEnum(style);
    if (self.face_ready[index]) return &self.faces[index];
    const data = try self.loadFont(index);
    try initFace(&self.faces[index], data);
    self.face_ready[index] = true;
    return &self.faces[index];
}

fn initFace(face: *Face, data: []const u8) !void {
    if (data.len > std.math.maxInt(c_int)) return error.FontTooLarge;
    face.shape = c.kbts_FontFromMemory(@ptrCast(@constCast(data.ptr)), @intCast(data.len), 0, &kbAllocator, null);
    if (face.shape.Error != c.KBTS_LOAD_FONT_ERROR_NONE) {
        c.kbts_FreeFont(&face.shape);
        return error.ShapeFontInitFailed;
    }
    const offset = c.stbtt_GetFontOffsetForIndex(data.ptr, 0);
    errdefer c.kbts_FreeFont(&face.shape);
    if (offset < 0 or c.stbtt_InitFont(&face.raster, data.ptr, offset) == 0)
        return error.RasterFontInitFailed;
}

pub fn shape(
    self: *Self,
    style: FontStyle,
    ligatures: bool,
    input: []const Input,
    span_cells: u16,
    metrics: Metrics,
) !Layout {
    const shape_context = self.context orelse return error.NotInitialized;
    if (input.len == 0 or input.len > 32 or span_cells == 0 or span_cells > 16)
        return error.InvalidRun;
    if (metrics.cell_width == 0 or metrics.cell_height == 0 or metrics.font_size_px == 0)
        return error.InvalidMetrics;
    const width = try std.math.mul(usize, span_cells, metrics.cell_width);
    const required = try std.math.mul(usize, width, metrics.cell_height);
    if (required > 16 * 1024 * 1024) return error.RunTooLarge;

    const face = try self.ensureFace(style);
    if (c.kbts_ShapePushFont(shape_context, &face.shape) == null)
        return error.ShapeFontPushFailed;
    defer _ = c.kbts_ShapePopFont(shape_context);

    if (!ligatures) {
        c.kbts_ShapePushFeature(shape_context, c.KBTS_FEATURE_TAG_liga, 0);
        c.kbts_ShapePushFeature(shape_context, c.KBTS_FEATURE_TAG_clig, 0);
        c.kbts_ShapePushFeature(shape_context, c.KBTS_FEATURE_TAG_dlig, 0);
        c.kbts_ShapePushFeature(shape_context, c.KBTS_FEATURE_TAG_calt, 0);
    }
    defer if (!ligatures) {
        _ = c.kbts_ShapePopFeature(shape_context, c.KBTS_FEATURE_TAG_calt);
        _ = c.kbts_ShapePopFeature(shape_context, c.KBTS_FEATURE_TAG_dlig);
        _ = c.kbts_ShapePopFeature(shape_context, c.KBTS_FEATURE_TAG_clig);
        _ = c.kbts_ShapePopFeature(shape_context, c.KBTS_FEATURE_TAG_liga);
    };

    c.kbts_ShapeBegin(shape_context, c.KBTS_DIRECTION_LTR, c.KBTS_LANGUAGE_DONT_KNOW);
    for (input) |item|
        c.kbts_ShapeCodepointWithUserId(shape_context, item.codepoint, item.cell);
    c.kbts_ShapeEnd(shape_context);
    if (c.kbts_ShapeError(shape_context) != c.KBTS_SHAPE_ERROR_NONE)
        return error.ShapeFailed;

    var ascent: c_int = 0;
    var descent: c_int = 0;
    var line_gap: c_int = 0;
    c.stbtt_GetFontVMetrics(&face.raster, &ascent, &descent, &line_gap);
    var advance_units: c_int = 0;
    var left_side_bearing: c_int = 0;
    const m_glyph = c.stbtt_FindGlyphIndex(&face.raster, 'M');
    c.stbtt_GetGlyphHMetrics(&face.raster, m_glyph, &advance_units, &left_side_bearing);
    if (advance_units <= 0) return error.InvalidFontAdvance;
    const scale_x = @as(f32, @floatFromInt(metrics.cell_width)) / @as(f32, @floatFromInt(advance_units));
    const scale_y = c.stbtt_ScaleForMappingEmToPixels(&face.raster, @floatFromInt(metrics.font_size_px));
    const line_height: f32 = @as(f32, @floatFromInt(ascent - descent)) * scale_y;
    const baseline = (@as(f32, @floatFromInt(metrics.cell_height)) - line_height) * 0.5 +
        @as(f32, @floatFromInt(ascent)) * scale_y;

    var pen_x: i64 = 0;
    var glyph_count: u32 = 0;
    var layout = Layout{
        .style = style,
        .span_cells = span_cells,
        .metrics = metrics,
        .scale_x = scale_x,
        .scale_y = scale_y,
        .baseline = baseline,
        .stats = undefined,
    };
    var run: c.kbts_run = undefined;
    while (c.kbts_ShapeRun(shape_context, &run) != 0) {
        var glyph: ?*c.kbts_glyph = null;
        while (c.kbts_GlyphIteratorNext(&run.Glyphs, &glyph) != 0) {
            const value = glyph orelse return error.InvalidGlyph;
            if (layout.count == max_layout_glyphs) return error.TooManyGlyphs;
            const x = @as(f32, @floatFromInt(pen_x + value.OffsetX)) * scale_x;
            const glyph_baseline = baseline - @as(f32, @floatFromInt(value.OffsetY)) * scale_y;
            if (!std.math.isFinite(x) or !std.math.isFinite(glyph_baseline) or
                @abs(x) > 1048576 or @abs(glyph_baseline) > 1048576)
                return error.InvalidGlyphPosition;
            layout.glyphs[layout.count] = .{
                .id = value.Id,
                .advance_x = value.AdvanceX,
                .offset_x = value.OffsetX,
                .offset_y = value.OffsetY,
                .x = x,
                .baseline = glyph_baseline,
            };
            layout.count += 1;
            pen_x += value.AdvanceX;
            glyph_count += 1;
        }
    }

    layout.stats = .{
        .glyphs = glyph_count,
        .ligatures = if (glyph_count < input.len) @intCast(input.len - glyph_count) else 0,
    };
    return layout;
}

pub fn rasterize(self: *Self, layout: *const Layout, mask: []u8) !void {
    const face = try self.ensureFace(layout.style);
    const width = try std.math.mul(usize, layout.span_cells, layout.metrics.cell_width);
    const required = try std.math.mul(usize, width, layout.metrics.cell_height);
    if (required > 16 * 1024 * 1024) return error.RunTooLarge;
    if (mask.len < required) return error.MaskTooSmall;
    @memset(mask[0..required], 0);

    for (layout.glyphs[0..layout.count]) |glyph| {
        const origin_x: i32 = @intFromFloat(@floor(glyph.x));
        const shift_x = glyph.x - @as(f32, @floatFromInt(origin_x));
        const origin_y: i32 = @intFromFloat(@floor(glyph.baseline));
        const shift_y = glyph.baseline - @as(f32, @floatFromInt(origin_y));
        var x0: c_int = 0;
        var y0: c_int = 0;
        var x1: c_int = 0;
        var y1: c_int = 0;
        c.stbtt_GetGlyphBitmapBoxSubpixel(&face.raster, glyph.id, layout.scale_x, layout.scale_y, shift_x, shift_y, &x0, &y0, &x1, &y1);
        const glyph_width = x1 - x0;
        const glyph_height = y1 - y0;
        if (glyph_width <= 0 or glyph_height <= 0) continue;
        const bitmap_len = try std.math.mul(usize, @intCast(glyph_width), @intCast(glyph_height));
        if (bitmap_len > 16 * 1024 * 1024) return error.BitmapTooLarge;
        const bitmap = try alloc.alloc(u8, bitmap_len);
        defer alloc.free(bitmap);
        c.stbtt_MakeGlyphBitmapSubpixel(&face.raster, bitmap.ptr, glyph_width, glyph_height, glyph_width, layout.scale_x, layout.scale_y, shift_x, shift_y, glyph.id);
        composite(mask[0..required], width, layout.metrics.cell_height, bitmap, glyph_width, glyph_height, origin_x + x0, origin_y + y0);
    }
}

fn appendPath(
    commands: *std.ArrayListUnmanaged(PathCommand),
    command: PathCommand,
    initial_len: usize,
) !void {
    if (commands.items.len >= max_path_commands or commands.items.len - initial_len >= max_run_path_commands)
        return error.TooManyPathCommands;
    for ([_]f32{ command.x, command.y, command.cx, command.cy, command.cx1, command.cy1 }) |value| {
        if (!std.math.isFinite(value) or @abs(value) > 1048576) return error.InvalidPathCoordinate;
    }
    if (commands.items.len == commands.capacity)
        try commands.ensureTotalCapacityPrecise(alloc, @min(max_path_commands, @max(64, commands.capacity * 2)));
    commands.appendAssumeCapacity(command);
}

pub fn outline(self: *Self, layout: *const Layout, commands: *std.ArrayListUnmanaged(PathCommand)) !void {
    const face = try self.ensureFace(layout.style);
    const initial_len = commands.items.len;
    errdefer commands.shrinkRetainingCapacity(initial_len);
    for (layout.glyphs[0..layout.count]) |glyph| {
        var vertices: ?[*]c.stbtt_vertex = null;
        const count = c.stbtt_GetGlyphShape(&face.raster, glyph.id, &vertices);
        defer if (vertices) |value| c.stbtt_FreeShape(&face.raster, value);
        if (count < 0 or count > max_run_path_commands) return error.TooManyPathCommands;
        if (count > 0 and vertices == null) return error.InvalidGlyphPath;
        var open = false;
        for (0..@intCast(count)) |index| {
            const vertex = vertices.?[index];
            const x = glyph.x + @as(f32, @floatFromInt(vertex.x)) * layout.scale_x;
            const y = glyph.baseline - @as(f32, @floatFromInt(vertex.y)) * layout.scale_y;
            switch (vertex.type) {
                c.STBTT_vmove => {
                    if (open) try appendPath(commands, .{ .op = @intFromEnum(PathOp.close) }, initial_len);
                    try appendPath(commands, .{ .op = @intFromEnum(PathOp.move), .x = x, .y = y }, initial_len);
                    open = true;
                },
                c.STBTT_vline => {
                    if (!open) return error.InvalidGlyphPath;
                    try appendPath(commands, .{ .op = @intFromEnum(PathOp.line), .x = x, .y = y }, initial_len);
                },
                c.STBTT_vcurve => {
                    if (!open) return error.InvalidGlyphPath;
                    try appendPath(commands, .{ .op = @intFromEnum(PathOp.quadratic), .x = x, .y = y, .cx = glyph.x + @as(f32, @floatFromInt(vertex.cx)) * layout.scale_x, .cy = glyph.baseline - @as(f32, @floatFromInt(vertex.cy)) * layout.scale_y }, initial_len);
                },
                c.STBTT_vcubic => {
                    if (!open) return error.InvalidGlyphPath;
                    try appendPath(commands, .{ .op = @intFromEnum(PathOp.cubic), .x = x, .y = y, .cx = glyph.x + @as(f32, @floatFromInt(vertex.cx)) * layout.scale_x, .cy = glyph.baseline - @as(f32, @floatFromInt(vertex.cy)) * layout.scale_y, .cx1 = glyph.x + @as(f32, @floatFromInt(vertex.cx1)) * layout.scale_x, .cy1 = glyph.baseline - @as(f32, @floatFromInt(vertex.cy1)) * layout.scale_y }, initial_len);
                },
                else => return error.InvalidGlyphPath,
            }
        }
        if (open) try appendPath(commands, .{ .op = @intFromEnum(PathOp.close) }, initial_len);
    }
}

fn composite(
    mask: []u8,
    width: usize,
    height: usize,
    bitmap: []const u8,
    glyph_width: i32,
    glyph_height: i32,
    dest_x: i32,
    dest_y: i32,
) void {
    for (0..@intCast(glyph_height)) |y| {
        const out_y = dest_y + @as(i32, @intCast(y));
        if (out_y < 0 or out_y >= height) continue;
        for (0..@intCast(glyph_width)) |x| {
            const out_x = dest_x + @as(i32, @intCast(x));
            if (out_x < 0 or out_x >= width) continue;
            const source = bitmap[y * @as(usize, @intCast(glyph_width)) + x];
            const dest = &mask[@as(usize, @intCast(out_y)) * width + @as(usize, @intCast(out_x))];
            const value = @as(u16, source) + (@as(u16, dest.*) * (255 - @as(u16, source)) + 127) / 255;
            dest.* = @intCast(@min(value, 255));
        }
    }
}
