// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");
const ghostty = @import("ghostty-vt");
const Self = @This();
const FontEngine = @import("FontEngine.zig");
const grain_data = @import("grain.zig");
const TextView = @import("TextView.zig");
const BitmapBatch = @import("BitmapBatch.zig");

pub const max_cells = TextView.max_cells;
pub const max_glyphs = max_cells * 5 / 4;
const initial_atlas_slots = 256;

const cell_shader = @embedFile("shaders/cell.wgsl");

pub const TextBackend = enum(u32) {
    kb_stb = 0,
    kb_canvas = 1,
};

text_backend: TextBackend = .kb_stb,
font_cell_width: u16 = 0,
font_cell_height: u16 = 0,
font_size_px: u16 = 0,
atlas_columns: u16 = 0,
ligatures_enabled: bool = true,
text_view_enabled: bool = false,
run_mask: [4 * 1024 * 1024]u8 align(64) = undefined,
font_inputs: [max_cells]FontEngine.Input = undefined,
font_engine: FontEngine = .{},
text_view: TextView = .{},
bitmap_batch: BitmapBatch = .{},
grain: [grain_data.size * grain_data.size]i8 = undefined,
frame: Frame = undefined,
cells: [max_cells]Cell align(4) = undefined,
styles: [max_styles]Style align(4) = undefined,
selections: [max_cells]u32 align(4) = undefined,
dirty_ranges: [max_cells]DirtyRange align(4) = undefined,
row_has_blink: [max_cells]bool = undefined,
row_text_heads: [max_cells]u16 = undefined,
render_row_dirty: [max_cells]bool = undefined,
style_cache: std.AutoHashMapUnmanaged(Style, u16) = .empty,
style_count: usize = 0,
previous_cols: usize = 0,
previous_rows: usize = 0,
previous_cursor_x: ?u16 = null,
previous_cursor_y: ?u16 = null,
render_cache_reset: bool = true,
glyph_cache: std.HashMapUnmanaged(CacheKey, CacheValue, CacheContext, 80) = .empty,
ordinary_glyph_cache: std.AutoHashMapUnmanaged(OrdinaryKey, u32) = .empty,
bitmap_slot_count: u32 = 0,
bitmap_cache_reset: bool = true,
canvas_requests: [max_cells]CanvasRequest = undefined,
canvas_text: [max_cells * max_cached_codepoints * 4]u8 = undefined,
canvas_request_count: usize = 0,
canvas_text_len: usize = 0,
pub fn bootstrap(self: *Self) void {
    self.text_backend = .kb_stb;
    self.font_cell_width = 0;
    self.font_cell_height = 0;
    self.font_size_px = 0;
    self.atlas_columns = 0;
    self.ligatures_enabled = true;
    self.text_view_enabled = false;
    self.style_cache = .empty;
    self.glyph_cache = .empty;
    self.ordinary_glyph_cache = .empty;
    self.style_count = 0;
    self.previous_cols = 0;
    self.previous_rows = 0;
    self.previous_cursor_x = null;
    self.previous_cursor_y = null;
    self.render_cache_reset = true;
    self.bitmap_slot_count = 0;
    self.bitmap_cache_reset = true;
    self.canvas_request_count = 0;
    self.canvas_text_len = 0;
    self.font_engine.bootstrap();
    self.text_view.bootstrap();
    self.bitmap_batch.bootstrap();
}

fn isLigatureCandidate(codepoint: u21) bool {
    return codepoint <= 0x7f and std.mem.indexOfScalar(u8, "!#%&*+-/:<=>?@\\^|~", @intCast(codepoint)) != null;
}

pub const ViewportMode = enum(u32) {
    active = 0,
    top = 1,
    pinned = 2,
};

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
    viewport_mode: ViewportMode,
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

pub const BitmapUpload = BitmapBatch.BitmapUpload;

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
    style_index: FontEngine.FontStyle,
    key: PreparedKey,
};

const PreparedMiss = struct {
    input_count: usize,
    text_len: usize,
};

fn prepareRunKey(self: *Self, raws: anytype, graphemes: anytype, y: usize, start: usize, cols: usize, cursor: anytype) !PreparedRun {
    const raw = raws[start];
    var end = @min(cols, start + @as(usize, raw.gridWidth()));
    if (self.ligatures_enabled and raw.wide == .narrow and !raw.hasGrapheme() and isLigatureCandidate(raw.codepoint())) {
        const first_style_id = self.cells[y * cols + start].meta & 0xffff;
        const cursor_x: ?usize = if (cursor != null and cursor.?.y == y) cursor.?.x else null;
        if (cursor_x != start) {
            while (end < cols and end - start < max_cached_span) : (end += 1) {
                const next_raw = raws[end];
                if (next_raw.wide != .narrow or next_raw.hasGrapheme() or !next_raw.hasText() or
                    !isLigatureCandidate(next_raw.codepoint())) break;
                if (next_raw.codepoint() == raw.codepoint()) break;
                const next_style_id = self.cells[y * cols + end].meta & 0xffff;
                if (next_style_id != first_style_id) break;
                if (cursor_x != null and end == cursor_x.?) break;
            }
        }
    }

    const span: u16 = @intCast(end - start);
    const first_style_id = self.cells[y * cols + start].meta & 0xffff;
    const style_flags = self.styles[first_style_id].flags;
    const style_index: FontEngine.FontStyle = @enumFromInt(@as(u2, @intCast((style_flags & 1) | (style_flags & 2))));
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

fn prepareRunMiss(self: *Self, raws: anytype, graphemes: anytype, start: usize, end: usize, write_inputs: bool, text_destination: ?[]u8) !PreparedMiss {
    var input_count: usize = 0;
    var text_len: usize = 0;
    var encoded: [4]u8 = undefined;
    for (start..end) |cell_x| {
        const run_raw = raws[cell_x];
        if (run_raw.wide == .spacer_tail) continue;
        if (input_count >= max_cached_codepoints) return error.RunTooLarge;
        if (write_inputs) self.font_inputs[input_count] = .{ .codepoint = run_raw.codepoint(), .cell = @intCast(cell_x - start) };
        input_count += 1;
        if (text_destination) |destination| {
            const len = std.unicode.utf8Encode(run_raw.codepoint(), &encoded) catch 0;
            if (text_len > destination.len or len > destination.len - text_len) return error.CanvasBatchFull;
            @memcpy(destination[text_len..][0..len], encoded[0..len]);
            text_len += len;
        }
        if (run_raw.hasGrapheme()) for (graphemes[cell_x]) |cp| {
            if (input_count >= max_cached_codepoints) return error.RunTooLarge;
            if (write_inputs) self.font_inputs[input_count] = .{ .codepoint = cp, .cell = @intCast(cell_x - start) };
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
    std.debug.assert(@sizeOf(Frame) == 68);
    std.debug.assert(@sizeOf(Cell) == 8);
    std.debug.assert(@sizeOf(OrdinaryKey) == 8);
    std.debug.assert(@sizeOf(Style) == 12);
    std.debug.assert(@sizeOf(DirtyRange) == 8);
    std.debug.assert(@sizeOf(Submission) == 112);
}

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

pub fn setFontMetrics(self: *Self, cell_width: u16, cell_height: u16, font_size_px_value: u16, atlas_columns_value: u16) void {
    if (self.font_cell_width != cell_width or self.font_cell_height != cell_height or self.font_size_px != font_size_px_value or self.atlas_columns != atlas_columns_value)
        self.bitmap_cache_reset = true;
    self.font_cell_width = cell_width;
    self.font_cell_height = cell_height;
    self.font_size_px = font_size_px_value;
    self.atlas_columns = atlas_columns_value;
    self.bitmap_batch.setMetrics(cell_width, cell_height, atlas_columns_value);
}

pub fn setTextBackend(self: *Self, value: u32) bool {
    if (value > 1) return false;
    const backend: TextBackend = @enumFromInt(value);
    if (self.text_backend != backend) {
        self.text_backend = backend;
        self.bitmap_cache_reset = true;
    }
    return true;
}

pub fn setFont(self: *Self, ligatures: bool) void {
    if (self.ligatures_enabled != ligatures) self.bitmap_cache_reset = true;
    self.ligatures_enabled = ligatures;
}

pub fn invalidateGlyphCache(self: *Self) void {
    self.bitmap_cache_reset = true;
}

pub fn invalidateRenderCache(self: *Self) void {
    self.render_cache_reset = true;
    self.bitmap_cache_reset = true;
    self.text_view.reset();
    self.previous_cols = 0;
    self.previous_rows = 0;
    self.previous_cursor_x = null;
    self.previous_cursor_y = null;
}

pub fn invalidateTextView(self: *Self) void {
    self.text_view.reset();
}

pub fn setTextViewEnabled(self: *Self, enabled: bool) bool {
    if (self.text_view_enabled == enabled) return false;
    self.text_view_enabled = enabled;
    self.text_view.reset();
    return true;
}

pub fn init(self: *Self, _: usize, _: usize) bool {
    const backend_value = gpu_text_backend();
    if (backend_value > 1) return false;
    self.text_backend = @enumFromInt(backend_value);
    self.text_view_enabled = false;
    self.font_engine.init() catch return false;
    self.text_view.reset();
    grain_data.generate(&self.grain);
    self.render_cache_reset = true;
    self.previous_cols = 0;
    self.previous_rows = 0;
    self.previous_cursor_y = null;
    self.style_cache.clearRetainingCapacity();
    self.style_count = 0;
    return gpu_init(
        cell_shader.ptr,
        cell_shader.len,
        self.grain[0..].ptr,
        self.grain.len,
        grain_data.size,
        max_cells,
        max_glyphs,
        max_styles,
        @sizeOf(Style),
        initial_atlas_slots,
        @sizeOf(Cell),
    ) == 1;
}

fn wasmOffset(pointer: anytype) !u32 {
    const address = @intFromPtr(pointer);
    if (address > std.math.maxInt(u32)) return error.WasmOffsetOverflow;
    return @intCast(address);
}

fn internStyle(self: *Self, value: Style) !u16 {
    if (self.style_cache.get(value)) |id| return id;
    if (self.style_count >= max_styles) return error.StyleCacheFull;
    const id: u16 = @intCast(self.style_count);
    try self.style_cache.put(std.heap.wasm_allocator, value, id);
    self.styles[self.style_count] = value;
    self.style_count += 1;
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

fn buildDirtyRanges(self: *Self, row_count: usize) usize {
    var count: usize = 0;
    var row: usize = 0;
    while (row < row_count) {
        if (!self.render_row_dirty[row]) {
            row += 1;
            continue;
        }
        const first_row = row;
        while (row < row_count and self.render_row_dirty[row]) row += 1;
        self.dirty_ranges[count] = .{
            .first_row = @intCast(first_row),
            .row_count = @intCast(row - first_row),
        };
        count += 1;
    }
    return count;
}

fn rebuildCompactRow(self: *Self, state: *const ghostty.RenderState, render_cells: anytype, selection: ?[2]u16, y: usize, cols: usize, default_style_id: u16, applied_styles: anytype) !void {
    @memset(self.cells[y * cols ..][0..cols], Cell{ .glyph = 0, .meta = 0 });
    self.selections[y] = try packedSelection(selection);
    self.row_has_blink[y] = false;
    self.row_text_heads[y] = 0;
    const slice = render_cells.slice();
    const raws = slice.items(.raw);
    for (raws, 0..) |raw, x| {
        if (raw.wide == .spacer_tail) continue;
        if (raw.hasText()) self.row_text_heads[y] += 1;
        self.cells[y * cols + x] = packedCell(default_style_id, @intCast(raw.gridWidth()));
    }
    for (applied_styles) |run| {
        const run_start = @min(@as(usize, @intCast(run.start)), raws.len);
        const run_end = @min(@as(usize, @intCast(run.end)), raws.len);
        if (run_start >= run_end) continue;
        var style_raw = run_start;
        while (style_raw < run_end and !hasStyleOrBackground(raws[style_raw])) : (style_raw += 1) {}
        if (style_raw == run_end) continue;
        const style_id = try self.internStyle(cellStyle(state, raws[style_raw], run.style));
        if ((self.styles[style_id].flags & 128) != 0) self.row_has_blink[y] = true;
        for (run_start..run_end) |x| {
            if (raws[x].wide == .spacer_tail or !hasStyleOrBackground(raws[x])) continue;
            self.cells[y * cols + x].meta = (self.cells[y * cols + x].meta & ~@as(u32, 0xffff)) | @as(u32, style_id);
        }
    }
}

pub fn submit(self: *Self, state: *ghostty.RenderState, terminal: *ghostty.Terminal) !void {
    return switch (self.text_backend) {
        .kb_stb, .kb_canvas => self.submitCached(state, terminal),
    };
}

fn submitCached(self: *Self, state: *ghostty.RenderState, terminal: *ghostty.Terminal) !void {
    self.canvas_request_count = 0;
    self.canvas_text_len = 0;
    self.bitmap_batch.reset();
    if (self.font_cell_width == 0 or self.font_cell_height == 0 or self.font_size_px == 0 or self.atlas_columns == 0) return error.FontMetricsMissing;
    const cols: usize = @intCast(state.cols);
    const rows_count: usize = @intCast(state.rows);
    const cell_count = cols * rows_count;
    if (cell_count > self.cells.len) return error.GridTooLarge;
    const rows = state.row_data.slice();
    const row_cells = rows.items(.cells);
    const row_selections = rows.items(.selection);
    const row_applied_styles = rows.items(.applied_styles);
    const row_dirty = rows.items(.dirty);
    const cursor = state.cursor.viewport;
    const current_cursor_x: ?u16 = if (cursor) |pos| pos.x else null;
    const current_cursor_y: ?u16 = if (cursor) |pos| pos.y else null;
    const cursor_position_changed = self.previous_cursor_x != current_cursor_x or self.previous_cursor_y != current_cursor_y;
    const bar = terminal.screens.active.pages.scrollbar();
    const dimensions_changed = self.previous_cols != cols or self.previous_rows != rows_count;
    const reset_styles = self.render_cache_reset or state.dirty == .full;
    const full_rebuild = reset_styles or self.bitmap_cache_reset or dimensions_changed;
    if (reset_styles) {
        self.style_cache.clearRetainingCapacity();
        self.style_count = 0;
    }
    const styles_first = self.style_count;
    const default_style_id = try self.internStyle(defaultCellStyle(state));
    const glyph_cache_was_reset = self.bitmap_cache_reset;
    // Bulk reset is bounded eviction performed before constructing a frame, so no referenced slot is reused.
    if (self.bitmap_cache_reset) {
        self.glyph_cache.clearRetainingCapacity();
        self.ordinary_glyph_cache.clearRetainingCapacity();
        self.bitmap_slot_count = 0;
        self.bitmap_cache_reset = false;
    }
    for (0..rows_count) |y| self.render_row_dirty[y] = full_rebuild or row_dirty[y];
    if (!full_rebuild and cursor_position_changed) {
        if (self.previous_cursor_y) |y| {
            if (y < rows_count) self.render_row_dirty[y] = true;
        }
        if (current_cursor_y) |y| {
            if (y < rows_count) self.render_row_dirty[y] = true;
        }
    }
    for (row_cells, row_selections, 0..) |*render_cells, selection, y| {
        if (self.render_row_dirty[y]) try self.rebuildCompactRow(state, render_cells, selection, y, cols, default_style_id, row_applied_styles[y].items);
    }

    var possible_new_slots: usize = 0;
    for (0..rows_count) |y| {
        if (self.render_row_dirty[y]) possible_new_slots += @as(usize, self.row_text_heads[y]);
    }
    const needs_cache_preflight = self.glyph_cache.count() + self.ordinary_glyph_cache.count() + possible_new_slots > max_cells or
        @as(usize, self.bitmap_slot_count) + possible_new_slots > max_glyphs;
    if (!glyph_cache_was_reset and needs_cache_preflight) {
        var prospective_entries: usize = 0;
        var prospective_slots: u32 = 0;
        var preflight_overflow = false;
        var scratch_allocator = std.heap.FixedBufferAllocator.init(self.run_mask[0..]);
        var pending_keys: std.HashMapUnmanaged(CacheKey, void, CacheContext, 80) = .empty;
        var pending_ordinary_keys: std.AutoHashMapUnmanaged(OrdinaryKey, void) = .empty;
        preflight: for (row_cells, 0..) |*render_cells, y| {
            if (!self.render_row_dirty[y]) continue;
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
                const prepared = try self.prepareRunKey(raws, graphemes, y, x, cols, cursor);
                switch (prepared.key) {
                    .ordinary => |key| {
                        if (!self.ordinary_glyph_cache.contains(key)) {
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
                        if (!self.glyph_cache.contains(key)) {
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
        if (preflight_overflow or self.glyph_cache.count() + self.ordinary_glyph_cache.count() + prospective_entries > max_cells or
            self.bitmap_slot_count + prospective_slots > max_glyphs)
        {
            self.glyph_cache.clearRetainingCapacity();
            self.ordinary_glyph_cache.clearRetainingCapacity();
            self.bitmap_slot_count = 0;
            for (0..rows_count) |y| {
                if (!self.render_row_dirty[y]) {
                    self.render_row_dirty[y] = true;
                    try self.rebuildCompactRow(state, &row_cells[y], row_selections[y], y, cols, default_style_id, row_applied_styles[y].items);
                }
            }
        }
    }

    var cache_hits: u32 = 0;
    var cache_misses: u32 = 0;
    for (row_cells, 0..) |*render_cells, y| {
        if (!self.render_row_dirty[y]) continue;
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
            const prepared = try self.prepareRunKey(raws, graphemes, y, start, cols, cursor);
            const end = prepared.end;
            const span: u16 = @intCast(end - start);
            const style_index = prepared.style_index;
            const cache_key = prepared.key;
            const cache_hit: ?CachedHit = switch (cache_key) {
                .ordinary => |key| if (self.ordinary_glyph_cache.get(key)) |slot|
                    .{ .ordinary = slot }
                else
                    null,
                .complex => |key| if (self.glyph_cache.getPtr(key)) |cached|
                    .{ .complex = cached }
                else
                    null,
            };
            if (cache_hit) |hit| {
                cache_hits += 1;
                switch (hit) {
                    .ordinary => |key| {
                        self.cells[y * cols + start].glyph = key + 1;
                    },
                    .complex => |key| {
                        for (start..end) |cell_x| {
                            if (raws[cell_x].wide == .spacer_tail) continue;
                            const slot = key.slots[cell_x - start];
                            self.cells[y * cols + cell_x].glyph = slot + 1;
                        }
                    },
                }
            } else {
                cache_misses += 1;
                var run_width: usize = 0;
                var mask_len: usize = 0;
                if (self.text_backend == .kb_canvas and self.canvas_request_count >= self.canvas_requests.len) return error.CanvasBatchFull;
                const text_destination: ?[]u8 = if (self.text_backend == .kb_canvas)
                    self.canvas_text[self.canvas_text_len..]
                else
                    null;
                const miss = try self.prepareRunMiss(raws, graphemes, start, end, self.text_backend == .kb_stb, text_destination);
                if (self.text_backend == .kb_stb) {
                    run_width = @as(usize, self.font_cell_width) * span;
                    mask_len = run_width * self.font_cell_height;
                    if (mask_len > self.run_mask.len) return error.RunMaskTooSmall;
                    _ = try self.font_engine.render(style_index, self.ligatures_enabled, self.font_inputs[0..miss.input_count], span, .{
                        .cell_width = self.font_cell_width,
                        .cell_height = self.font_cell_height,
                        .font_size_px = self.font_size_px,
                    }, self.run_mask[0..mask_len]);
                }
                var cached: CacheValue = undefined;
                const first_slot = self.bitmap_slot_count;
                const slot_count = prepared.slot_count;
                if (self.bitmap_slot_count + slot_count > max_glyphs) return error.GlyphCacheFull;
                if (self.text_backend == .kb_canvas) {
                    self.canvas_requests[self.canvas_request_count] = .{
                        .first_slot = first_slot,
                        .slot_count = slot_count,
                        .span_cells = span,
                        .text_offset = @intCast(self.canvas_text_len),
                        .text_len = @intCast(miss.text_len),
                        .flags = @intFromEnum(style_index),
                    };
                    self.canvas_request_count += 1;
                    self.canvas_text_len += miss.text_len;
                }
                for (start..end) |cell_x| {
                    if (raws[cell_x].wide == .spacer_tail) continue;
                    if (self.bitmap_slot_count >= max_glyphs) return error.GlyphCacheFull;
                    const slot = self.bitmap_slot_count;
                    self.bitmap_slot_count += 1;
                    if (self.text_backend == .kb_stb) {
                        const pixel_offset = (cell_x - start) * self.font_cell_width;
                        const pixel_width: u32 = @as(u32, self.font_cell_width) * @as(u32, raws[cell_x].gridWidth());
                        try self.bitmap_batch.append(slot, self.run_mask[0..mask_len], pixel_offset, pixel_width, self.font_cell_height, @intCast(run_width));
                    }
                    cached.slots[cell_x - start] = slot;
                    self.cells[y * cols + cell_x].glyph = slot + 1;
                }
                switch (cache_key) {
                    .ordinary => |key| try self.ordinary_glyph_cache.put(std.heap.wasm_allocator, key, first_slot),
                    .complex => |key| try self.glyph_cache.put(std.heap.wasm_allocator, key, cached),
                }
            }
            x = end;
        }
    }

    try self.bitmap_batch.pack();
    var has_text_blink = false;
    for (0..rows_count) |y| has_text_blink = has_text_blink or self.row_has_blink[y];
    const dirty_ranges_count = self.buildDirtyRanges(rows_count);
    const cursor_x: u32 = if (cursor) |pos| if (pos.wide_tail and pos.x > 0) pos.x - 1 else pos.x else std.math.maxInt(u16);
    self.frame = .{
        .magic = 0x46574342,
        .version = 3,
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
        .viewport_mode = switch (terminal.screens.active.pages.viewport) {
            .active => .active,
            .top => .top,
            .pin => .pinned,
        },
        .atlas_slots = @max(initial_atlas_slots, self.bitmap_slot_count),
    };
    if (state.cursor.visible and cursor != null) self.frame.cursor_flags |= 1;
    if (state.cursor.blinking) self.frame.cursor_flags |= 2;
    if (has_text_blink) self.frame.cursor_flags |= 4;
    const build_text_snapshot = self.text_view_enabled and
        (self.text_view.needsBuild() or dimensions_changed or state.dirty != .false);
    const snapshot = if (build_text_snapshot)
        try self.text_view.build(state)
    else
        self.text_view.inactiveSnapshot();
    const bitmap_uploads = self.bitmap_batch.uploads();
    const bitmap_upload_pixels = self.bitmap_batch.uploadPixels();
    const submission = Submission{
        .magic = 0x5355424d,
        .version = 3,
        .byte_size = @sizeOf(Submission),
        .reserved = 0,
        .frame_offset = try wasmOffset(&self.frame),
        .frame_len = @sizeOf(Frame),
        .cells_offset = try wasmOffset(self.cells[0..].ptr),
        .cells_count = @intCast(cell_count),
        .dirty_ranges_offset = try wasmOffset(self.dirty_ranges[0..].ptr),
        .dirty_ranges_count = @intCast(dirty_ranges_count),
        .styles_offset = try wasmOffset(self.styles[0..].ptr),
        .styles_first = @intCast(styles_first),
        .styles_count = @intCast(self.style_count - styles_first),
        .selections_offset = try wasmOffset(self.selections[0..].ptr),
        .selections_count = @intCast(rows_count),
        .bitmap_uploads_offset = try wasmOffset(bitmap_uploads.ptr),
        .bitmap_uploads_count = @intCast(bitmap_uploads.len),
        .bitmap_upload_pixels_offset = try wasmOffset(bitmap_upload_pixels.ptr),
        .bitmap_upload_pixels_len = @intCast(bitmap_upload_pixels.len),
        .canvas_requests_offset = try wasmOffset(self.canvas_requests[0..].ptr),
        .canvas_requests_count = @intCast(self.canvas_request_count),
        .canvas_text_offset = try wasmOffset(self.canvas_text[0..].ptr),
        .canvas_text_len = @intCast(self.canvas_text_len),
        .text_rows_offset = try wasmOffset(snapshot.rows),
        .text_cells_offset = try wasmOffset(snapshot.cells),
        .text_text_offset = try wasmOffset(snapshot.text),
        .text_text_len = @intCast(snapshot.text_len),
        .text_changed = @intFromBool(snapshot.changed),
    };
    if (gpu_submit(&submission) != 1) {
        self.bitmap_cache_reset = true;
        return error.SubmitFailed;
    }
    if (build_text_snapshot) self.text_view.commit(snapshot.hash);
    self.previous_cols = cols;
    self.previous_rows = rows_count;
    self.previous_cursor_x = current_cursor_x;
    self.previous_cursor_y = current_cursor_y;
    self.render_cache_reset = false;
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
