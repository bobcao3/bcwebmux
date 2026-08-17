// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");
const fonts = @import("fonts");

const c = @cImport({
    @cInclude("kb_text_shape.h");
    @cInclude("stb_truetype.h");
});

const alloc = std.heap.wasm_allocator;

pub const Metrics = struct {
    cell_width: u16,
    cell_height: u16,
    font_size_px: u16, // Integer physical-pixel CSS em size.
};

pub const Input = struct {
    codepoint: u21,
    cell: u16,
};

pub const RenderStats = struct {
    glyphs: u32,
    ligatures: u32,
};

const Face = struct {
    shape: c.kbts_font,
    raster: c.stbtt_fontinfo,
};

var context: ?*c.kbts_shape_context = null;
var faces: [4]Face = undefined;
var face_ready = [_]bool{false} ** 4;
var external_faces: [4]Face = undefined;
var external_face_ready = [_]bool{false} ** 4;
var external_face_data = [_]?[]u8{null} ** 4;

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

pub fn init() !void {
    if (context != null) return;
    context = c.kbts_CreateShapeContext(&kbAllocator, null) orelse return error.ShapeContextInitFailed;
}

fn ensureFace(font: u1, style: u2) !*Face {
    if (font == 1) {
        if (external_face_ready[style]) return &external_faces[style];
        return error.ExternalFontMissing;
    }
    if (face_ready[style]) return &faces[style];
    const data = switch (style) {
        0 => fonts.regular,
        1 => fonts.bold,
        2 => fonts.italic,
        3 => fonts.bold_italic,
    };
    try initFace(&faces[style], data);
    face_ready[style] = true;
    return &faces[style];
}

pub fn installExternalFace(style: u2, data: []u8) !void {
    if (data.len == 0) return error.EmptyFont;
    if (external_face_ready[style]) {
        c.kbts_FreeFont(&external_faces[style].shape);
        if (external_face_data[style]) |old_data| cFree(@ptrCast(old_data.ptr));
        external_face_ready[style] = false;
        external_face_data[style] = null;
    }
    initFace(&external_faces[style], data) catch |err| {
        cFree(@ptrCast(data.ptr));
        return err;
    };
    external_face_data[style] = data;
    external_face_ready[style] = true;
}

fn initFace(face: *Face, data: []const u8) !void {
    if (data.len > std.math.maxInt(c_int)) return error.FontTooLarge;
    face.shape = c.kbts_FontFromMemory(@ptrCast(@constCast(data.ptr)), @intCast(data.len), 0, &kbAllocator, null);
    if (face.shape.Error != c.KBTS_LOAD_FONT_ERROR_NONE) return error.ShapeFontInitFailed;
    const offset = c.stbtt_GetFontOffsetForIndex(data.ptr, 0);
    if (offset < 0 or c.stbtt_InitFont(&face.raster, data.ptr, offset) == 0)
        return error.RasterFontInitFailed;
}

pub fn render(
    font: u1,
    style: u2,
    ligatures: bool,
    input: []const Input,
    span_cells: u16,
    metrics: Metrics,
    mask: []u8,
) !RenderStats {
    const shape_context = context orelse return error.NotInitialized;
    if (input.len == 0 or span_cells == 0) return error.EmptyRun;
    const width = try std.math.mul(usize, span_cells, metrics.cell_width);
    const required = try std.math.mul(usize, width, metrics.cell_height);
    if (mask.len < required) return error.MaskTooSmall;
    @memset(mask[0..required], 0);

    const face = try ensureFace(font, style);
    if (c.kbts_ShapePushFont(shape_context, &face.shape) == null)
        return error.ShapeFontPushFailed;
    defer _ = c.kbts_ShapePopFont(shape_context);

    if (!ligatures) {
        c.kbts_ShapePushFeature(shape_context, c.KBTS_FEATURE_TAG_liga, 0);
        defer _ = c.kbts_ShapePopFeature(shape_context, c.KBTS_FEATURE_TAG_liga);
        c.kbts_ShapePushFeature(shape_context, c.KBTS_FEATURE_TAG_clig, 0);
        defer _ = c.kbts_ShapePopFeature(shape_context, c.KBTS_FEATURE_TAG_clig);
        c.kbts_ShapePushFeature(shape_context, c.KBTS_FEATURE_TAG_dlig, 0);
        defer _ = c.kbts_ShapePopFeature(shape_context, c.KBTS_FEATURE_TAG_dlig);
        c.kbts_ShapePushFeature(shape_context, c.KBTS_FEATURE_TAG_calt, 0);
        defer _ = c.kbts_ShapePopFeature(shape_context, c.KBTS_FEATURE_TAG_calt);
    }

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

    var pen_x: i32 = 0;
    var glyph_count: u32 = 0;
    var run: c.kbts_run = undefined;
    while (c.kbts_ShapeRun(shape_context, &run) != 0) {
        var glyph: ?*c.kbts_glyph = null;
        while (c.kbts_GlyphIteratorNext(&run.Glyphs, &glyph) != 0) {
            const value = glyph orelse return error.InvalidGlyph;
            const positioned_x = @as(f32, @floatFromInt(pen_x + value.OffsetX)) * scale_x;
            const origin_x: i32 = @intFromFloat(@floor(positioned_x));
            const shift_x = positioned_x - @as(f32, @floatFromInt(origin_x));
            const bitmap_y = baseline - @as(f32, @floatFromInt(value.OffsetY)) * scale_y;
            const origin_y: i32 = @intFromFloat(@floor(bitmap_y));
            const shift_y = bitmap_y - @as(f32, @floatFromInt(origin_y));

            var x0: c_int = 0;
            var y0: c_int = 0;
            var x1: c_int = 0;
            var y1: c_int = 0;
            c.stbtt_GetGlyphBitmapBoxSubpixel(
                &face.raster,
                value.Id,
                scale_x,
                scale_y,
                shift_x,
                shift_y,
                &x0,
                &y0,
                &x1,
                &y1,
            );
            const glyph_width = x1 - x0;
            const glyph_height = y1 - y0;
            if (glyph_width > 0 and glyph_height > 0) {
                const bitmap_len = try std.math.mul(usize, @intCast(glyph_width), @intCast(glyph_height));
                const bitmap = try alloc.alloc(u8, bitmap_len);
                defer alloc.free(bitmap);
                c.stbtt_MakeGlyphBitmapSubpixel(
                    &face.raster,
                    bitmap.ptr,
                    glyph_width,
                    glyph_height,
                    glyph_width,
                    scale_x,
                    scale_y,
                    shift_x,
                    shift_y,
                    value.Id,
                );
                const dest_x = origin_x + x0;
                const dest_y = origin_y + y0;
                composite(mask[0..required], width, metrics.cell_height, bitmap, glyph_width, glyph_height, dest_x, dest_y);
            }
            pen_x += value.AdvanceX;
            glyph_count += 1;
        }
    }

    return .{
        .glyphs = glyph_count,
        .ligatures = if (glyph_count < input.len) @intCast(input.len - glyph_count) else 0,
    };
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
