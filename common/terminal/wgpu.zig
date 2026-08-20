// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");
const ghostty = @import("ghostty-vt");
const font_engine = @import("font_engine.zig");
const text_view = @import("text_view.zig");

pub const max_cells = text_view.max_cells;
pub const max_glyphs = max_cells * 5 / 4;
const initial_atlas_slots = 256;

const cell_shader = @embedFile("shaders/cell.wgsl");
const grain_size = 64;
var grain: [grain_size * grain_size]i8 = undefined;

fn xorshift32(state: *u32) u32 {
    state.* ^= state.* << 13;
    state.* ^= state.* >> 17;
    state.* ^= state.* << 5;
    return state.*;
}

fn generateGrain() void {
    // r8snorm uses -127..127; keep a uniform histogram without -128's duplicate endpoint.
    var index: usize = 0;
    const uniform_count = grain.len / 255;
    var level: i16 = -127;
    while (level <= 127) : (level += 1) {
        var count: usize = 0;
        while (count < uniform_count) : (count += 1) {
            grain[index] = @intCast(level);
            index += 1;
        }
    }

    // The remainder is paired symmetrically to preserve the exact zero mean.
    var magnitude: i8 = 1;
    while (magnitude <= 8) : (magnitude += 1) {
        grain[index] = -magnitude;
        grain[index + 1] = magnitude;
        index += 2;
    }

    var state: u32 = 0x6d2b79f5;
    var remaining = grain.len;
    while (remaining > 1) {
        remaining -= 1;
        const swap_index = @as(usize, @intCast(xorshift32(&state) % @as(u32, @intCast(remaining + 1))));
        std.mem.swap(i8, &grain[remaining], &grain[swap_index]);
    }
}

pub const TextBackend = enum(u32) {
    kb_stb = 0,
    kb_canvas = 1,
};

var text_backend: TextBackend = .kb_stb;
var font_cell_width: u16 = 0;
var font_cell_height: u16 = 0;
var font_size_px: u16 = 0;
var atlas_columns: u16 = 0;
var ligatures_enabled = true;
var text_view_enabled = false;
var run_mask: [4 * 1024 * 1024]u8 align(64) = undefined;
var font_inputs: [max_cells]font_engine.Input = undefined;
fn isLigatureCandidate(codepoint: u21) bool {
    return codepoint <= 0x7f and std.mem.indexOfScalar(u8, "!#%&*+-/:<=>?@\\^|~", @intCast(codepoint)) != null;
}

pub const Frame = extern struct {
    magic: u32,
    version: u32,
    cols: u32,
    rows: u32,
    cell_count: u32,
    reserved: u32,
    background: u32,
    foreground: u32,
    cursor_x: u32,
    cursor_y: u32,
    cursor_flags: u32,
    cursor_style: u32,
    scroll_total: u32,
    scroll_offset: u32,
    scroll_length: u32,
    atlas_slots: u32,
};

// Meta low16 is style ID, bit16 wide, and bit17 active.
pub const Cell = extern struct {
    glyph: u32,
    meta: u32,
};

const CanvasRequest = extern struct {
    first_slot: u32,
    slot_count: u32,
    span_cells: u32,
    text_offset: u32,
    text_len: u32,
    flags: u32,
};

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

pub const DirtyRange = extern struct {
    first_row: u32,
    row_count: u32,
};

pub const Submission = extern struct {
    magic: u32,
    version: u32,
    byte_size: u32,
    reserved: u32,
    frame_offset: u32,
    frame_len: u32,
    cells_offset: u32,
    cells_count: u32,
    dirty_ranges_offset: u32,
    dirty_ranges_count: u32,
    styles_offset: u32,
    styles_first: u32,
    styles_count: u32,
    selections_offset: u32,
    selections_count: u32,
    bitmap_uploads_offset: u32,
    bitmap_uploads_count: u32,
    bitmap_upload_pixels_offset: u32,
    bitmap_upload_pixels_len: u32,
    canvas_requests_offset: u32,
    canvas_requests_count: u32,
    canvas_text_offset: u32,
    canvas_text_len: u32,
    text_rows_offset: u32,
    text_cells_offset: u32,
    text_text_offset: u32,
    text_text_len: u32,
    text_changed: u32,
};

const max_cached_codepoints = 32;
const max_cached_span = 16;
const max_styles = max_cells;

// Ordinary graphemes are cached independently; contextual punctuation runs use exact source-sequence keys.
const CacheKey = struct {
    style: u32,
    span: u32,
    codepoint_count: u32,
    codepoints: [max_cached_codepoints]u32,
};

pub const OrdinaryKey = extern struct {
    codepoint: u32,
    meta: u32,
};

const PreparedKey = union(enum) {
    ordinary: OrdinaryKey,
    complex: CacheKey,
};

const CacheContext = struct {
    pub fn hash(_: @This(), key: CacheKey) u64 {
        var hasher = std.hash.Wyhash.init(0);
        hasher.update(std.mem.asBytes(&key.style));
        hasher.update(std.mem.asBytes(&key.span));
        hasher.update(std.mem.asBytes(&key.codepoint_count));
        const count: usize = @intCast(key.codepoint_count);
        hasher.update(std.mem.sliceAsBytes(key.codepoints[0..count]));
        return hasher.final();
    }

    pub fn eql(_: @This(), a: CacheKey, b: CacheKey) bool {
        if (a.style != b.style or a.span != b.span or a.codepoint_count != b.codepoint_count) return false;
        const count: usize = @intCast(a.codepoint_count);
        return std.mem.eql(u32, a.codepoints[0..count], b.codepoints[0..count]);
    }
};

const CacheValue = struct {
    slots: [max_cached_span]u32 = [_]u32{std.math.maxInt(u32)} ** max_cached_span,
};

const CachedHit = union(enum) {
    ordinary: u32,
    complex: *CacheValue,
};

pub const Style = extern struct {
    fg: u32,
    bg: u32,
    flags: u32,
};

const PreparedRun = struct {
    end: usize,
    slot_count: u32,
    style_index: font_engine.FontStyle,
    key: PreparedKey,
};

const PreparedMiss = struct {
    input_count: usize,
    text_len: usize,
};

fn prepareRunKey(raws: anytype, graphemes: anytype, y: usize, start: usize, cols: usize, cursor: anytype) !PreparedRun {
    const raw = raws[start];
    var end = @min(cols, start + @as(usize, raw.gridWidth()));
    if (ligatures_enabled and raw.wide == .narrow and !raw.hasGrapheme() and isLigatureCandidate(raw.codepoint())) {
        const first_style_id = cells[y * cols + start].meta & 0xffff;
        const cursor_x: ?usize = if (cursor != null and cursor.?.y == y) cursor.?.x else null;
        if (cursor_x != start) {
            while (end < cols and end - start < max_cached_span) : (end += 1) {
                const next_raw = raws[end];
                if (next_raw.wide != .narrow or next_raw.hasGrapheme() or !next_raw.hasText() or
                    !isLigatureCandidate(next_raw.codepoint())) break;
                if (next_raw.codepoint() == raw.codepoint()) break;
                const next_style_id = cells[y * cols + end].meta & 0xffff;
                if (next_style_id != first_style_id) break;
                if (cursor_x != null and end == cursor_x.?) break;
            }
        }
    }

    const span: u16 = @intCast(end - start);
    const first_style_id = cells[y * cols + start].meta & 0xffff;
    const style_flags = styles[first_style_id].flags;
    const style_index: font_engine.FontStyle = @enumFromInt(@as(u2, @intCast((style_flags & 1) | (style_flags & 2))));
    var cache_key: CacheKey = undefined;
    cache_key.style = @intFromEnum(style_index);
    cache_key.span = span;
    cache_key.codepoint_count = 0;
    var slot_count: u32 = 0;
    var input_count: usize = 0;
    for (start..end) |cell_x| {
        const run_raw = raws[cell_x];
        if (run_raw.wide == .spacer_tail) continue;
        slot_count += 1;
        if (input_count >= max_cached_codepoints) return error.RunTooLarge;
        cache_key.codepoints[input_count] = run_raw.codepoint();
        input_count += 1;
        if (run_raw.hasGrapheme()) for (graphemes[cell_x]) |cp| {
            if (input_count >= max_cached_codepoints) return error.RunTooLarge;
            cache_key.codepoints[input_count] = cp;
            input_count += 1;
        };
    }
    cache_key.codepoint_count = @intCast(input_count);
    const key: PreparedKey = if (input_count == 1 and slot_count == 1)
        .{ .ordinary = .{
            .codepoint = cache_key.codepoints[0],
            .meta = (@as(u32, span) << 2) | @intFromEnum(style_index),
        } }
    else
        .{ .complex = cache_key };
    return .{
        .end = end,
        .slot_count = slot_count,
        .style_index = style_index,
        .key = key,
    };
}

fn prepareRunMiss(raws: anytype, graphemes: anytype, start: usize, end: usize, write_inputs: bool, text_destination: ?[]u8) !PreparedMiss {
    var input_count: usize = 0;
    var text_len: usize = 0;
    var encoded: [4]u8 = undefined;
    for (start..end) |cell_x| {
        const run_raw = raws[cell_x];
        if (run_raw.wide == .spacer_tail) continue;
        if (input_count >= max_cached_codepoints) return error.RunTooLarge;
        if (write_inputs) font_inputs[input_count] = .{ .codepoint = run_raw.codepoint(), .cell = @intCast(cell_x - start) };
        input_count += 1;
        if (text_destination) |destination| {
            const len = std.unicode.utf8Encode(run_raw.codepoint(), &encoded) catch 0;
            if (text_len > destination.len or len > destination.len - text_len) return error.CanvasBatchFull;
            @memcpy(destination[text_len..][0..len], encoded[0..len]);
            text_len += len;
        }
        if (run_raw.hasGrapheme()) for (graphemes[cell_x]) |cp| {
            if (input_count >= max_cached_codepoints) return error.RunTooLarge;
            if (write_inputs) font_inputs[input_count] = .{ .codepoint = cp, .cell = @intCast(cell_x - start) };
            input_count += 1;
            if (text_destination) |destination| {
                const grapheme_len = std.unicode.utf8Encode(cp, &encoded) catch 0;
                if (text_len > destination.len or grapheme_len > destination.len - text_len) return error.CanvasBatchFull;
                @memcpy(destination[text_len..][0..grapheme_len], encoded[0..grapheme_len]);
                text_len += grapheme_len;
            }
        };
    }
    return .{ .input_count = input_count, .text_len = text_len };
}

comptime {
    std.debug.assert(@sizeOf(Frame) == 64);
    std.debug.assert(@sizeOf(Cell) == 8);
    std.debug.assert(@sizeOf(OrdinaryKey) == 8);
    std.debug.assert(@sizeOf(Style) == 12);
    std.debug.assert(@sizeOf(DirtyRange) == 8);
    std.debug.assert(@sizeOf(BitmapUpload) == 16);
    std.debug.assert(@sizeOf(BitmapTile) == 24);
    std.debug.assert(@sizeOf(Submission) == 112);
}

var frame: Frame = undefined;
var cells: [max_cells]Cell align(4) = undefined;
var styles: [max_styles]Style align(4) = undefined;
var selections: [max_cells]u32 align(4) = undefined;
var dirty_ranges: [max_cells]DirtyRange align(4) = undefined;
var row_has_blink: [max_cells]bool = undefined;
var row_text_heads: [max_cells]u16 = undefined;
var render_row_dirty: [max_cells]bool = undefined;
var style_cache: std.AutoHashMapUnmanaged(Style, u16) = .empty;
var style_count: usize = 0;
var previous_cols: usize = 0;
var previous_rows: usize = 0;
var previous_cursor_x: ?u16 = null;
var previous_cursor_y: ?u16 = null;
var render_cache_reset = true;
var glyph_cache: std.HashMapUnmanaged(CacheKey, CacheValue, CacheContext, 80) = .empty;
var ordinary_glyph_cache: std.AutoHashMapUnmanaged(OrdinaryKey, u32) = .empty;
var bitmap_slot_count: u32 = 0;
var bitmap_cache_reset = true;
var canvas_requests: [max_cells]CanvasRequest = undefined;
var canvas_text: [max_cells * max_cached_codepoints * 4]u8 = undefined;
var canvas_request_count: usize = 0;
var canvas_text_len: usize = 0;
var bitmap_tiles: std.ArrayListUnmanaged(BitmapTile) = .empty;
var bitmap_uploads: std.ArrayListUnmanaged(BitmapUpload) = .empty;
var bitmap_pixels: std.ArrayListUnmanaged(u8) = .empty;
var bitmap_upload_pixels: std.ArrayListUnmanaged(u8) = .empty;

extern "host" fn gpu_submit(submission_ptr: *const Submission) i32;
extern "host" fn gpu_text_backend() u32;
extern "host" fn gpu_init(
    cell_ptr: [*]const u8,
    cell_len: usize,
    grain_ptr: [*]const i8,
    grain_len: usize,
    grain_size_value: usize,
    max_cells_value: usize,
    max_glyphs_value: usize,
    max_styles_value: usize,
    style_size: usize,
    atlas_slots_value: usize,
    cell_size: usize,
) i32;

pub fn setFontMetrics(cell_width: u16, cell_height: u16, font_size_px_value: u16, atlas_columns_value: u16) void {
    if (font_cell_width != cell_width or font_cell_height != cell_height or font_size_px != font_size_px_value or atlas_columns != atlas_columns_value)
        bitmap_cache_reset = true;
    font_cell_width = cell_width;
    font_cell_height = cell_height;
    font_size_px = font_size_px_value;
    atlas_columns = atlas_columns_value;
}

pub fn setTextBackend(value: u32) bool {
    if (value > 1) return false;
    const backend: TextBackend = @enumFromInt(value);
    if (text_backend != backend) {
        text_backend = backend;
        bitmap_cache_reset = true;
    }
    return true;
}

pub fn setFont(ligatures: bool) void {
    if (ligatures_enabled != ligatures) bitmap_cache_reset = true;
    ligatures_enabled = ligatures;
}

pub fn invalidateGlyphCache() void {
    bitmap_cache_reset = true;
}

pub fn invalidateTextView() void {
    text_view.reset();
}

pub fn setTextViewEnabled(enabled: bool) bool {
    if (text_view_enabled == enabled) return false;
    text_view_enabled = enabled;
    text_view.reset();
    return true;
}

pub fn init(_: usize, _: usize) bool {
    const backend_value = gpu_text_backend();
    if (backend_value > 1) return false;
    text_backend = @enumFromInt(backend_value);
    text_view_enabled = false;
    font_engine.init() catch return false;
    text_view.reset();
    generateGrain();
    render_cache_reset = true;
    previous_cols = 0;
    previous_rows = 0;
    previous_cursor_y = null;
    style_cache.clearRetainingCapacity();
    style_count = 0;
    return gpu_init(
        cell_shader.ptr,
        cell_shader.len,
        grain[0..].ptr,
        grain.len,
        grain_size,
        max_cells,
        max_glyphs,
        max_styles,
        @sizeOf(Style),
        initial_atlas_slots,
        @sizeOf(Cell),
    ) == 1;
}

fn appendBitmapTile(slot: u32, mask: []const u8, source_offset: usize, width: u32, height: u32, stride: u32) !void {
    const row_len: usize = @intCast(width);
    const rows: usize = @intCast(height);
    const pixel_len = std.math.mul(usize, row_len, rows) catch return error.BitmapBatchFull;
    const pixel_offset = bitmap_pixels.items.len;
    const new_len = std.math.add(usize, pixel_offset, pixel_len) catch return error.BitmapBatchFull;
    try bitmap_pixels.ensureTotalCapacity(std.heap.wasm_allocator, new_len);
    bitmap_pixels.items.len = new_len;
    for (0..rows) |row| {
        const source = std.math.add(usize, source_offset, std.math.mul(usize, row, @intCast(stride)) catch return error.BitmapBatchFull) catch return error.BitmapBatchFull;
        @memcpy(bitmap_pixels.items[pixel_offset + row * row_len ..][0..row_len], mask[source..][0..row_len]);
    }
    try bitmap_tiles.append(std.heap.wasm_allocator, .{
        .slot = slot,
        .width = width,
        .height = height,
        .stride = width,
        .pixel_offset = @intCast(pixel_offset),
        .pixel_len = @intCast(pixel_len),
    });
}

fn packBitmapUploads() !void {
    bitmap_uploads.clearRetainingCapacity();
    if (bitmap_tiles.items.len == 0) return;
    if (atlas_columns == 0) return error.BitmapBatchFull;

    const tile_width = std.math.mul(usize, @intCast(font_cell_width), 2) catch return error.BitmapBatchFull;
    const cell_height: usize = @intCast(font_cell_height);
    const columns: u32 = @intCast(atlas_columns);
    var expanded_size: usize = 0;
    var tile_index: usize = 0;
    while (tile_index < bitmap_tiles.items.len) {
        const first_slot = bitmap_tiles.items[tile_index].slot;
        const atlas_row = first_slot / columns;
        var end = std.math.add(usize, tile_index, 1) catch return error.BitmapBatchFull;
        while (end < bitmap_tiles.items.len) {
            const previous_slot = bitmap_tiles.items[end - 1].slot;
            const next_slot = std.math.add(u32, previous_slot, 1) catch break;
            const current_slot = bitmap_tiles.items[end].slot;
            if (current_slot != next_slot or current_slot / columns != atlas_row) break;
            end = std.math.add(usize, end, 1) catch return error.BitmapBatchFull;
        }
        const slot_count = end - tile_index;
        const bytes_per_row = std.math.mul(usize, slot_count, tile_width) catch return error.BitmapBatchFull;
        const group_size = std.math.mul(usize, bytes_per_row, cell_height) catch return error.BitmapBatchFull;
        const pixel_offset = expanded_size;
        expanded_size = std.math.add(usize, expanded_size, group_size) catch return error.BitmapBatchFull;
        try bitmap_uploads.append(std.heap.wasm_allocator, .{
            .first_slot = first_slot,
            .slot_count = std.math.cast(u32, slot_count) orelse return error.BitmapBatchFull,
            .pixel_offset = std.math.cast(u32, pixel_offset) orelse return error.BitmapBatchFull,
            .bytes_per_row = std.math.cast(u32, bytes_per_row) orelse return error.BitmapBatchFull,
        });
        tile_index = end;
    }

    try bitmap_upload_pixels.ensureTotalCapacity(std.heap.wasm_allocator, expanded_size);
    bitmap_upload_pixels.items.len = expanded_size;
    @memset(bitmap_upload_pixels.items, 0);

    var copy_tile_index: usize = 0;
    for (bitmap_uploads.items) |upload| {
        const group_count: usize = @intCast(upload.slot_count);
        if (group_count > bitmap_tiles.items.len - copy_tile_index) return error.BitmapBatchFull;
        const bytes_per_row: usize = @intCast(upload.bytes_per_row);
        const upload_offset: usize = @intCast(upload.pixel_offset);
        for (0..group_count) |local| {
            const tile = bitmap_tiles.items[copy_tile_index + local];
            const width: usize = @intCast(tile.width);
            const height: usize = @intCast(tile.height);
            const stride: usize = @intCast(tile.stride);
            if (width > tile_width or height > cell_height) return error.BitmapBatchFull;
            const source_offset: usize = @intCast(tile.pixel_offset);
            const x_offset = std.math.mul(usize, local, tile_width) catch return error.BitmapBatchFull;
            for (0..height) |row| {
                const source_row = std.math.add(usize, source_offset, std.math.mul(usize, row, stride) catch return error.BitmapBatchFull) catch return error.BitmapBatchFull;
                const destination_row = std.math.add(usize, upload_offset, std.math.add(usize, std.math.mul(usize, row, bytes_per_row) catch return error.BitmapBatchFull, x_offset) catch return error.BitmapBatchFull) catch return error.BitmapBatchFull;
                @memcpy(bitmap_upload_pixels.items[destination_row..][0..width], bitmap_pixels.items[source_row..][0..width]);
            }
        }
        copy_tile_index += group_count;
    }
    if (copy_tile_index != bitmap_tiles.items.len) return error.BitmapBatchFull;
}

fn wasmOffset(pointer: anytype) !u32 {
    const address = @intFromPtr(pointer);
    if (address > std.math.maxInt(u32)) return error.WasmOffsetOverflow;
    return @intCast(address);
}

fn internStyle(value: Style) !u16 {
    if (style_cache.get(value)) |id| return id;
    if (style_count >= max_styles) return error.StyleCacheFull;
    const id: u16 = @intCast(style_count);
    try style_cache.put(std.heap.wasm_allocator, value, id);
    styles[style_count] = value;
    style_count += 1;
    return id;
}

fn packedCell(style_id: u16, width: u8) Cell {
    const wide: u32 = if (width == 2) @as(u32, 1) << 16 else 0;
    return .{ .glyph = 0, .meta = @as(u32, style_id) | wide | (1 << 17) };
}

fn packedSelection(selection: ?[2]u16) !u32 {
    const range = selection orelse return 0;
    if (range[1] > 0x7fff) return error.SelectionRangeTooLarge;
    return (@as(u32, 1) << 31) | @as(u32, range[0]) | (@as(u32, range[1]) << 16);
}

fn buildDirtyRanges(row_count: usize) usize {
    var count: usize = 0;
    var row: usize = 0;
    while (row < row_count) {
        if (!render_row_dirty[row]) {
            row += 1;
            continue;
        }
        const first_row = row;
        while (row < row_count and render_row_dirty[row]) row += 1;
        dirty_ranges[count] = .{
            .first_row = @intCast(first_row),
            .row_count = @intCast(row - first_row),
        };
        count += 1;
    }
    return count;
}

fn rebuildCompactRow(state: *const ghostty.RenderState, render_cells: anytype, selection: ?[2]u16, y: usize, cols: usize, default_style_id: u16, applied_styles: anytype) !void {
    @memset(cells[y * cols ..][0..cols], Cell{ .glyph = 0, .meta = 0 });
    selections[y] = try packedSelection(selection);
    row_has_blink[y] = false;
    row_text_heads[y] = 0;
    const slice = render_cells.slice();
    const raws = slice.items(.raw);
    for (raws, 0..) |raw, x| {
        if (raw.wide == .spacer_tail) continue;
        if (raw.hasText()) row_text_heads[y] += 1;
        cells[y * cols + x] = packedCell(default_style_id, @intCast(raw.gridWidth()));
    }
    for (applied_styles) |run| {
        const run_start = @min(@as(usize, @intCast(run.start)), raws.len);
        const run_end = @min(@as(usize, @intCast(run.end)), raws.len);
        if (run_start >= run_end) continue;
        var style_raw = run_start;
        while (style_raw < run_end and !hasStyleOrBackground(raws[style_raw])) : (style_raw += 1) {}
        if (style_raw == run_end) continue;
        const style_id = try internStyle(cellStyle(state, raws[style_raw], run.style));
        if ((styles[style_id].flags & 128) != 0) row_has_blink[y] = true;
        for (run_start..run_end) |x| {
            if (raws[x].wide == .spacer_tail or !hasStyleOrBackground(raws[x])) continue;
            cells[y * cols + x].meta = (cells[y * cols + x].meta & ~@as(u32, 0xffff)) | @as(u32, style_id);
        }
    }
}

pub fn submit(state: *ghostty.RenderState, terminal: *ghostty.Terminal) !void {
    return switch (text_backend) {
        .kb_stb, .kb_canvas => submitCached(state, terminal),
    };
}

fn submitCached(state: *ghostty.RenderState, terminal: *ghostty.Terminal) !void {
    canvas_request_count = 0;
    canvas_text_len = 0;
    bitmap_tiles.clearRetainingCapacity();
    bitmap_uploads.clearRetainingCapacity();
    bitmap_pixels.clearRetainingCapacity();
    bitmap_upload_pixels.clearRetainingCapacity();
    if (font_cell_width == 0 or font_cell_height == 0 or font_size_px == 0 or atlas_columns == 0) return error.FontMetricsMissing;
    const cols: usize = @intCast(state.cols);
    const rows_count: usize = @intCast(state.rows);
    const cell_count = cols * rows_count;
    if (cell_count > cells.len) return error.GridTooLarge;
    const rows = state.row_data.slice();
    const row_cells = rows.items(.cells);
    const row_selections = rows.items(.selection);
    const row_applied_styles = rows.items(.applied_styles);
    const row_dirty = rows.items(.dirty);
    const cursor = state.cursor.viewport;
    const current_cursor_x: ?u16 = if (cursor) |pos| pos.x else null;
    const current_cursor_y: ?u16 = if (cursor) |pos| pos.y else null;
    const cursor_position_changed = previous_cursor_x != current_cursor_x or previous_cursor_y != current_cursor_y;
    const bar = terminal.screens.active.pages.scrollbar();
    const dimensions_changed = previous_cols != cols or previous_rows != rows_count;
    const reset_styles = render_cache_reset or state.dirty == .full;
    const full_rebuild = reset_styles or bitmap_cache_reset or dimensions_changed;
    if (reset_styles) {
        style_cache.clearRetainingCapacity();
        style_count = 0;
    }
    const styles_first = style_count;
    const default_style_id = try internStyle(defaultCellStyle(state));
    const glyph_cache_was_reset = bitmap_cache_reset;
    // Bulk reset is bounded eviction performed before constructing a frame, so no referenced slot is reused.
    if (bitmap_cache_reset) {
        glyph_cache.clearRetainingCapacity();
        ordinary_glyph_cache.clearRetainingCapacity();
        bitmap_slot_count = 0;
        bitmap_cache_reset = false;
    }
    for (0..rows_count) |y| render_row_dirty[y] = full_rebuild or row_dirty[y];
    if (!full_rebuild and cursor_position_changed) {
        if (previous_cursor_y) |y| {
            if (y < rows_count) render_row_dirty[y] = true;
        }
        if (current_cursor_y) |y| {
            if (y < rows_count) render_row_dirty[y] = true;
        }
    }
    for (row_cells, row_selections, 0..) |*render_cells, selection, y| {
        if (render_row_dirty[y]) try rebuildCompactRow(state, render_cells, selection, y, cols, default_style_id, row_applied_styles[y].items);
    }

    var possible_new_slots: usize = 0;
    for (0..rows_count) |y| {
        if (render_row_dirty[y]) possible_new_slots += @as(usize, row_text_heads[y]);
    }
    const needs_cache_preflight = glyph_cache.count() + ordinary_glyph_cache.count() + possible_new_slots > max_cells or
        @as(usize, bitmap_slot_count) + possible_new_slots > max_glyphs;
    if (!glyph_cache_was_reset and needs_cache_preflight) {
        var prospective_entries: usize = 0;
        var prospective_slots: u32 = 0;
        var preflight_overflow = false;
        var scratch_allocator = std.heap.FixedBufferAllocator.init(run_mask[0..]);
        var pending_keys: std.HashMapUnmanaged(CacheKey, void, CacheContext, 80) = .empty;
        var pending_ordinary_keys: std.AutoHashMapUnmanaged(OrdinaryKey, void) = .empty;
        preflight: for (row_cells, 0..) |*render_cells, y| {
            if (!render_row_dirty[y]) continue;
            const slice = render_cells.slice();
            const raws = slice.items(.raw);
            const graphemes = slice.items(.grapheme);
            var x: usize = 0;
            while (x < cols) {
                const raw = raws[x];
                if (raw.wide == .spacer_tail or !raw.hasText()) {
                    x += 1;
                    continue;
                }
                const prepared = try prepareRunKey(raws, graphemes, y, x, cols, cursor);
                switch (prepared.key) {
                    .ordinary => |key| {
                        if (!ordinary_glyph_cache.contains(key)) {
                            const pending = pending_ordinary_keys.getOrPut(scratch_allocator.allocator(), key) catch {
                                preflight_overflow = true;
                                break :preflight;
                            };
                            if (!pending.found_existing) {
                                prospective_entries += 1;
                                prospective_slots += prepared.slot_count;
                            }
                        }
                    },
                    .complex => |key| {
                        if (!glyph_cache.contains(key)) {
                            const pending = pending_keys.getOrPut(scratch_allocator.allocator(), key) catch {
                                preflight_overflow = true;
                                break :preflight;
                            };
                            if (!pending.found_existing) {
                                prospective_entries += 1;
                                prospective_slots += prepared.slot_count;
                            }
                        }
                    },
                }
                x = prepared.end;
            }
        }
        pending_keys.deinit(scratch_allocator.allocator());
        pending_ordinary_keys.deinit(scratch_allocator.allocator());
        if (preflight_overflow or glyph_cache.count() + ordinary_glyph_cache.count() + prospective_entries > max_cells or
            bitmap_slot_count + prospective_slots > max_glyphs)
        {
            glyph_cache.clearRetainingCapacity();
            ordinary_glyph_cache.clearRetainingCapacity();
            bitmap_slot_count = 0;
            for (0..rows_count) |y| {
                if (!render_row_dirty[y]) {
                    render_row_dirty[y] = true;
                    try rebuildCompactRow(state, &row_cells[y], row_selections[y], y, cols, default_style_id, row_applied_styles[y].items);
                }
            }
        }
    }

    var cache_hits: u32 = 0;
    var cache_misses: u32 = 0;
    for (row_cells, 0..) |*render_cells, y| {
        if (!render_row_dirty[y]) continue;
        const slice = render_cells.slice();
        const raws = slice.items(.raw);
        const graphemes = slice.items(.grapheme);
        var x: usize = 0;
        while (x < cols) {
            const raw = raws[x];
            if (raw.wide == .spacer_tail or !raw.hasText()) {
                x += 1;
                continue;
            }
            const start = x;
            const prepared = try prepareRunKey(raws, graphemes, y, start, cols, cursor);
            const end = prepared.end;
            const span: u16 = @intCast(end - start);
            const style_index = prepared.style_index;
            const cache_key = prepared.key;
            const cache_hit: ?CachedHit = switch (cache_key) {
                .ordinary => |key| if (ordinary_glyph_cache.get(key)) |slot|
                    .{ .ordinary = slot }
                else
                    null,
                .complex => |key| if (glyph_cache.getPtr(key)) |cached|
                    .{ .complex = cached }
                else
                    null,
            };
            if (cache_hit) |hit| {
                cache_hits += 1;
                switch (hit) {
                    .ordinary => |key| {
                        cells[y * cols + start].glyph = key + 1;
                    },
                    .complex => |key| {
                        for (start..end) |cell_x| {
                            if (raws[cell_x].wide == .spacer_tail) continue;
                            const slot = key.slots[cell_x - start];
                            cells[y * cols + cell_x].glyph = slot + 1;
                        }
                    },
                }
            } else {
                cache_misses += 1;
                var run_width: usize = 0;
                var mask_len: usize = 0;
                if (text_backend == .kb_canvas and canvas_request_count >= canvas_requests.len) return error.CanvasBatchFull;
                const text_destination: ?[]u8 = if (text_backend == .kb_canvas)
                    canvas_text[canvas_text_len..]
                else
                    null;
                const miss = try prepareRunMiss(raws, graphemes, start, end, text_backend == .kb_stb, text_destination);
                if (text_backend == .kb_stb) {
                    run_width = @as(usize, font_cell_width) * span;
                    mask_len = run_width * font_cell_height;
                    if (mask_len > run_mask.len) return error.RunMaskTooSmall;
                    _ = try font_engine.render(style_index, ligatures_enabled, font_inputs[0..miss.input_count], span, .{
                        .cell_width = font_cell_width,
                        .cell_height = font_cell_height,
                        .font_size_px = font_size_px,
                    }, run_mask[0..mask_len]);
                }
                var cached: CacheValue = undefined;
                const first_slot = bitmap_slot_count;
                const slot_count = prepared.slot_count;
                if (bitmap_slot_count + slot_count > max_glyphs) return error.GlyphCacheFull;
                if (text_backend == .kb_canvas) {
                    canvas_requests[canvas_request_count] = .{
                        .first_slot = first_slot,
                        .slot_count = slot_count,
                        .span_cells = span,
                        .text_offset = @intCast(canvas_text_len),
                        .text_len = @intCast(miss.text_len),
                        .flags = @intFromEnum(style_index),
                    };
                    canvas_request_count += 1;
                    canvas_text_len += miss.text_len;
                }
                for (start..end) |cell_x| {
                    if (raws[cell_x].wide == .spacer_tail) continue;
                    if (bitmap_slot_count >= max_glyphs) return error.GlyphCacheFull;
                    const slot = bitmap_slot_count;
                    bitmap_slot_count += 1;
                    if (text_backend == .kb_stb) {
                        const pixel_offset = (cell_x - start) * font_cell_width;
                        const pixel_width: u32 = @as(u32, font_cell_width) * @as(u32, raws[cell_x].gridWidth());
                        try appendBitmapTile(slot, run_mask[0..mask_len], pixel_offset, pixel_width, font_cell_height, @intCast(run_width));
                    }
                    cached.slots[cell_x - start] = slot;
                    cells[y * cols + cell_x].glyph = slot + 1;
                }
                switch (cache_key) {
                    .ordinary => |key| try ordinary_glyph_cache.put(std.heap.wasm_allocator, key, first_slot),
                    .complex => |key| try glyph_cache.put(std.heap.wasm_allocator, key, cached),
                }
            }
            x = end;
        }
    }

    try packBitmapUploads();
    var has_text_blink = false;
    for (0..rows_count) |y| has_text_blink = has_text_blink or row_has_blink[y];
    const dirty_ranges_count = buildDirtyRanges(rows_count);
    const cursor_x: u32 = if (cursor) |pos| if (pos.wide_tail and pos.x > 0) pos.x - 1 else pos.x else std.math.maxInt(u16);
    frame = .{
        .magic = 0x46574342,
        .version = 2,
        .cols = state.cols,
        .rows = state.rows,
        .cell_count = @intCast(cell_count),
        .reserved = (@as(u32, @intCast(@min(cache_hits, 0xffff))) << 16) | @as(u32, @intCast(@min(cache_misses, 0xffff))),
        .background = rgb(state.colors.background),
        .foreground = rgb(state.colors.foreground),
        .cursor_x = cursor_x,
        .cursor_y = if (cursor) |pos| pos.y else std.math.maxInt(u16),
        .cursor_flags = 0,
        .cursor_style = @intFromEnum(state.cursor.visual_style),
        .scroll_total = @intCast(bar.total),
        .scroll_offset = @intCast(bar.offset),
        .scroll_length = @intCast(bar.len),
        .atlas_slots = @max(initial_atlas_slots, bitmap_slot_count),
    };
    if (state.cursor.visible and cursor != null) frame.cursor_flags |= 1;
    if (state.cursor.blinking) frame.cursor_flags |= 2;
    if (has_text_blink) frame.cursor_flags |= 4;
    const build_text_snapshot = text_view_enabled and
        (text_view.needsBuild() or dimensions_changed or state.dirty != .false);
    const snapshot = if (build_text_snapshot)
        try text_view.build(state)
    else
        text_view.inactiveSnapshot();
    const submission = Submission{
        .magic = 0x5355424d,
        .version = 2,
        .byte_size = @sizeOf(Submission),
        .reserved = 0,
        .frame_offset = try wasmOffset(&frame),
        .frame_len = @sizeOf(Frame),
        .cells_offset = try wasmOffset(cells[0..].ptr),
        .cells_count = @intCast(cell_count),
        .dirty_ranges_offset = try wasmOffset(dirty_ranges[0..].ptr),
        .dirty_ranges_count = @intCast(dirty_ranges_count),
        .styles_offset = try wasmOffset(styles[0..].ptr),
        .styles_first = @intCast(styles_first),
        .styles_count = @intCast(style_count - styles_first),
        .selections_offset = try wasmOffset(selections[0..].ptr),
        .selections_count = @intCast(rows_count),
        .bitmap_uploads_offset = try wasmOffset(bitmap_uploads.items.ptr),
        .bitmap_uploads_count = @intCast(bitmap_uploads.items.len),
        .bitmap_upload_pixels_offset = try wasmOffset(bitmap_upload_pixels.items.ptr),
        .bitmap_upload_pixels_len = @intCast(bitmap_upload_pixels.items.len),
        .canvas_requests_offset = try wasmOffset(canvas_requests[0..].ptr),
        .canvas_requests_count = @intCast(canvas_request_count),
        .canvas_text_offset = try wasmOffset(canvas_text[0..].ptr),
        .canvas_text_len = @intCast(canvas_text_len),
        .text_rows_offset = try wasmOffset(snapshot.rows),
        .text_cells_offset = try wasmOffset(snapshot.cells),
        .text_text_offset = try wasmOffset(snapshot.text),
        .text_text_len = @intCast(snapshot.text_len),
        .text_changed = @intFromBool(snapshot.changed),
    };
    if (gpu_submit(&submission) != 1) {
        bitmap_cache_reset = true;
        return error.SubmitFailed;
    }
    if (build_text_snapshot) text_view.commit(snapshot.hash);
    previous_cols = cols;
    previous_rows = rows_count;
    previous_cursor_x = current_cursor_x;
    previous_cursor_y = current_cursor_y;
    render_cache_reset = false;
}

fn backgroundIsTrueColor(raw: ghostty.page.Cell, style: ghostty.Style) bool {
    if (style.flags.inverse) return switch (style.fg_color) {
        .rgb => true,
        else => false,
    };
    return switch (raw.content_tag) {
        .bg_color_rgb => true,
        .bg_color_palette => false,
        else => switch (style.bg_color) {
            .rgb => true,
            else => false,
        },
    };
}

fn hasStyleOrBackground(raw: ghostty.page.Cell) bool {
    return raw.hasStyling() or switch (raw.content_tag) {
        .bg_color_rgb, .bg_color_palette => true,
        else => false,
    };
}

fn defaultCellStyle(state: *const ghostty.RenderState) Style {
    return .{
        .fg = rgb(state.colors.foreground),
        .bg = rgb(state.colors.background),
        .flags = 0,
    };
}

fn cellStyle(state: *const ghostty.RenderState, raw: ghostty.page.Cell, stored: ghostty.Style) Style {
    const style: ghostty.Style = if (raw.hasStyling()) stored else .{};
    var fg = style.fg(.{
        .default = state.colors.foreground,
        .palette = &state.colors.palette,
        .bold = .bright,
    });
    var bg = style.bg(&raw, &state.colors.palette) orelse state.colors.background;
    if (style.flags.inverse) std.mem.swap(ghostty.color.RGB, &fg, &bg);
    if (style.flags.invisible) fg = bg;
    var flags: u32 = 0;
    if (style.flags.bold) flags |= 1;
    if (style.flags.italic) flags |= 2;
    if (style.flags.faint) flags |= 4;
    if (style.flags.underline != .none) flags |= 8;
    if (style.flags.strikethrough) flags |= 16;
    if (style.flags.overline) flags |= 32;
    if (backgroundIsTrueColor(raw, style)) flags |= 256;
    if (style.flags.blink) flags |= 128;
    return .{ .fg = rgb(fg), .bg = rgb(bg), .flags = flags };
}

fn rgb(value: ghostty.color.RGB) u32 {
    return (@as(u32, value.r) << 16) | (@as(u32, value.g) << 8) | value.b;
}
