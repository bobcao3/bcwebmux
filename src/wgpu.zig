// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");
const ghostty = @import("ghostty-vt");
const font_engine = @import("font_engine.zig");
const text_view = @import("text_view.zig");

pub const max_cells = text_view.max_cells;
pub const max_glyphs = max_cells * 5 / 4;

const cell_shader = @embedFile("shaders/cell.wgsl");

pub const TextBackend = enum(u32) {
    kb_stb = 0,
    kb_canvas = 1,
};

var text_backend: TextBackend = .kb_stb;
var font_cell_width: u16 = 0;
var font_cell_height: u16 = 0;
var font_size_px: u16 = 0;
var selected_font: u1 = 0;
var ligatures_enabled = true;
var run_mask: [4 * 1024 * 1024]u8 align(64) = undefined;
var run_text: [max_cached_codepoints * 4]u8 = undefined;
var font_inputs: [max_cells]font_engine.Input = undefined;
const Theme = struct {
    background: ghostty.color.RGB,
    foreground: ghostty.color.RGB,
    palette: ghostty.color.Palette,
};

var theme: ?Theme = null;

pub fn setTheme(background: u32, foreground: u32, ansi: *const [16]u32) void {
    var palette = ghostty.color.default;
    for (ansi.*, 0..) |value, i| palette[i] = packedRgb(value);
    theme = .{
        .background = packedRgb(background),
        .foreground = packedRgb(foreground),
        .palette = palette,
    };
}

fn packedRgb(value: u32) ghostty.color.RGB {
    return .{
        .r = @intCast((value >> 16) & 0xff),
        .g = @intCast((value >> 8) & 0xff),
        .b = @intCast(value & 0xff),
    };
}

fn isLigatureCandidate(codepoint: u21) bool {
    return codepoint <= 0x7f and std.mem.indexOfScalar(u8, "!#%&*+-/:<=>?@\\^|~", @intCast(codepoint)) != null;
}

fn renderBackground(state: *const ghostty.RenderState) ghostty.color.RGB {
    return if (theme) |value| value.background else state.colors.background;
}

fn renderForeground(state: *const ghostty.RenderState) ghostty.color.RGB {
    return if (theme) |value| value.foreground else state.colors.foreground;
}

fn renderPalette(state: *const ghostty.RenderState) *const ghostty.color.Palette {
    if (theme) |*value| return &value.palette;
    return &state.colors.palette;
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

pub const Cell = extern struct {
    x: u32,
    y: u32,
    width: u32,
    flags: u32,
    fg: u32,
    bg: u32,
    glyph: u32,
    active: u32,
};

const CanvasRequest = extern struct {
    first_slot: u32,
    slot_count: u32,
    span_cells: u32,
    text_offset: u32,
    text_len: u32,
    flags: u32,
};

const max_cached_codepoints = 32;
const max_cached_span = 16;

// Ordinary graphemes are cached independently; contextual punctuation runs use exact source-sequence keys.
const CacheKey = struct {
    style: u32,
    span: u32,
    codepoint_count: u32,
    codepoints: [max_cached_codepoints]u32 = [_]u32{0} ** max_cached_codepoints,
};

const CacheValue = struct {
    slots: [max_cached_span]u32 = [_]u32{std.math.maxInt(u32)} ** max_cached_span,
};

const Style = struct {
    fg: u32,
    bg: u32,
    flags: u32,
};

comptime {
    std.debug.assert(@sizeOf(Frame) == 64);
    std.debug.assert(@sizeOf(Cell) == 32);
}

var frame: Frame = undefined;
var cells: [max_cells]Cell align(4) = undefined;
var glyph_cache: std.AutoHashMapUnmanaged(CacheKey, CacheValue) = .empty;
var bitmap_slot_count: u32 = 0;
var bitmap_cache_reset = true;
var canvas_requests: [max_cells]CanvasRequest = undefined;
var canvas_text: [max_cells * max_cached_codepoints * 4]u8 = undefined;
var canvas_request_count: usize = 0;
var canvas_text_len: usize = 0;

extern "host" fn gpu_submit(
    frame_ptr: *const Frame,
    cells_ptr: [*]Cell,
    text_rows_ptr: [*]const text_view.Row,
    text_cells_ptr: [*]const text_view.Cell,
    text_bytes_ptr: [*]const u8,
    text_bytes_len: usize,
    text_changed: u32,
) i32;
extern "host" fn gpu_glyph_canvas_batch(
    requests_ptr: [*]const CanvasRequest,
    request_count: usize,
    text_ptr: [*]const u8,
    text_len: usize,
) i32;
extern "host" fn gpu_text_backend() u32;
extern "host" fn gpu_glyph_bitmap(slot: u32, pixels_ptr: [*]const u8, width: u32, height: u32, stride: u32) i32;
extern "host" fn gpu_init(
    cell_ptr: [*]const u8,
    cell_len: usize,
    max_cells_value: usize,
    max_glyphs_value: usize,
    atlas_slots_value: usize,
    cell_size: usize,
) i32;

pub fn setFontMetrics(cell_width: u16, cell_height: u16, font_size_px_value: u16) void {
    if (font_cell_width != cell_width or font_cell_height != cell_height or font_size_px != font_size_px_value)
        bitmap_cache_reset = true;
    font_cell_width = cell_width;
    font_cell_height = cell_height;
    font_size_px = font_size_px_value;
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

pub fn setFont(font: u1, ligatures: bool) void {
    if (selected_font != font or ligatures_enabled != ligatures) bitmap_cache_reset = true;
    selected_font = font;
    ligatures_enabled = ligatures;
}

pub fn invalidateGlyphCache() void {
    bitmap_cache_reset = true;
}

pub fn init(cols: usize, rows: usize) bool {
    const backend_value = gpu_text_backend();
    if (backend_value > 1) return false;
    text_backend = @enumFromInt(backend_value);
    font_engine.init() catch return false;
    text_view.reset();
    // Reserve beyond the visible grid so an adversarial screen with a unique shape in every cell cannot exhaust the atlas.
    const atlas_slots = (cols * rows * 5 + 3) / 4;
    return gpu_init(
        cell_shader.ptr,
        cell_shader.len,
        max_cells,
        max_glyphs,
        atlas_slots,
        @sizeOf(Cell),
    ) == 1;
}

pub fn submit(state: *ghostty.RenderState, terminal: *ghostty.Terminal) !void {
    return switch (text_backend) {
        .kb_stb, .kb_canvas => submitCached(state, terminal),
    };
}

fn submitCached(state: *ghostty.RenderState, terminal: *ghostty.Terminal) !void {
    if (text_backend == .kb_canvas) {
        canvas_request_count = 0;
        canvas_text_len = 0;
    }
    if (font_cell_width == 0 or font_cell_height == 0 or font_size_px == 0) return error.FontMetricsMissing;
    const cols: usize = @intCast(state.cols);
    const rows_count: usize = @intCast(state.rows);
    const cell_count = cols * rows_count;
    if (cell_count > cells.len) return error.GridTooLarge;
    // Bulk reset is bounded eviction performed before constructing a frame, so no referenced slot is reused.
    if (bitmap_cache_reset or glyph_cache.count() + cell_count > max_cells or bitmap_slot_count + cell_count > max_glyphs) {
        glyph_cache.clearRetainingCapacity();
        bitmap_slot_count = 0;
        bitmap_cache_reset = false;
    }
    const rows = state.row_data.slice();
    const row_cells = rows.items(.cells);
    const selections = rows.items(.selection);
    const bar = terminal.screens.active.pages.scrollbar();
    @memset(std.mem.sliceAsBytes(cells[0..cell_count]), 0);
    var has_text_blink = false;

    for (row_cells, selections, 0..) |*render_cells, selection, y| {
        const slice = render_cells.slice();
        const raws = slice.items(.raw);
        const styles = slice.items(.style);
        for (raws, styles, 0..) |raw, stored, x| {
            if (raw.wide == .spacer_tail) continue;
            const style = cellStyle(state, raw, stored, selection, x);
            if ((style.flags & 128) != 0) has_text_blink = true;
            cells[y * cols + x] = .{
                .x = @intCast(x),
                .y = @intCast(y),
                .width = @intCast(raw.gridWidth()),
                .flags = style.flags,
                .fg = style.fg,
                .bg = style.bg,
                .glyph = 0,
                .active = 1,
            };
        }
    }

    const cursor = state.cursor.viewport;
    var cache_hits: u32 = 0;
    var cache_misses: u32 = 0;
    for (row_cells, 0..) |*render_cells, y| {
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
            var end = @min(cols, x + @as(usize, raw.gridWidth()));
            if (ligatures_enabled and raw.wide == .narrow and !raw.hasGrapheme() and isLigatureCandidate(raw.codepoint())) {
                const first = cells[y * cols + start];
                const cursor_x: ?usize = if (cursor != null and cursor.?.y == y) cursor.?.x else null;
                if (cursor_x != start) {
                    while (end < cols and end - start < max_cached_span) : (end += 1) {
                        const next_raw = raws[end];
                        if (next_raw.wide != .narrow or next_raw.hasGrapheme() or !next_raw.hasText() or
                            !isLigatureCandidate(next_raw.codepoint())) break;
                        if (next_raw.codepoint() == raw.codepoint()) break;
                        const next = cells[y * cols + end];
                        if (next.fg != first.fg or next.bg != first.bg or (next.flags & 67) != (first.flags & 67)) break;
                        if (cursor_x != null and end == cursor_x.?) break;
                    }
                }
            }

            const span: u16 = @intCast(end - start);
            const first = cells[y * cols + start];
            const style_index: u2 = @intCast((first.flags & 1) | ((first.flags & 2)));
            var cache_key: CacheKey = .{ .style = style_index, .span = span, .codepoint_count = 0 };
            var input_count: usize = 0;
            var run_text_len: usize = 0;
            for (start..end) |cell_x| {
                const run_raw = raws[cell_x];
                if (run_raw.wide == .spacer_tail) continue;
                if (input_count >= max_cached_codepoints) return error.RunTooLarge;
                font_inputs[input_count] = .{ .codepoint = run_raw.codepoint(), .cell = @intCast(cell_x - start) };
                cache_key.codepoints[input_count] = run_raw.codepoint();
                input_count += 1;
                var encoded: [4]u8 = undefined;
                const len = std.unicode.utf8Encode(run_raw.codepoint(), &encoded) catch 0;
                @memcpy(run_text[run_text_len..][0..len], encoded[0..len]);
                run_text_len += len;
                if (run_raw.hasGrapheme()) for (graphemes[cell_x]) |cp| {
                    if (input_count >= max_cached_codepoints) return error.RunTooLarge;
                    font_inputs[input_count] = .{ .codepoint = cp, .cell = @intCast(cell_x - start) };
                    cache_key.codepoints[input_count] = cp;
                    input_count += 1;
                    const grapheme_len = std.unicode.utf8Encode(cp, &encoded) catch 0;
                    @memcpy(run_text[run_text_len..][0..grapheme_len], encoded[0..grapheme_len]);
                    run_text_len += grapheme_len;
                };
            }
            cache_key.codepoint_count = @intCast(input_count);
            const run_width: usize = @as(usize, font_cell_width) * span;
            const mask_len = run_width * font_cell_height;
            if (mask_len > run_mask.len) return error.RunMaskTooSmall;
            if (glyph_cache.get(cache_key)) |cached| {
                cache_hits += 1;
                for (start..end) |cell_x| {
                    if (raws[cell_x].wide == .spacer_tail) continue;
                    const slot = cached.slots[cell_x - start];
                    if (slot == std.math.maxInt(u32)) return error.GlyphCacheFull;
                    cells[y * cols + cell_x].glyph = slot + 1;
                }
            } else {
                cache_misses += 1;
                if (text_backend == .kb_stb) {
                    _ = try font_engine.render(selected_font, style_index, ligatures_enabled, font_inputs[0..input_count], span, .{
                        .cell_width = font_cell_width,
                        .cell_height = font_cell_height,
                        .font_size_px = font_size_px,
                    }, run_mask[0..mask_len]);
                }
                var cached: CacheValue = .{};
                const first_slot = bitmap_slot_count;
                var slot_count: u32 = 0;
                for (start..end) |cell_x| {
                    if (raws[cell_x].wide != .spacer_tail) slot_count += 1;
                }
                if (text_backend == .kb_canvas) {
                    _ = try font_engine.shape(selected_font, style_index, ligatures_enabled, font_inputs[0..input_count]);
                }
                if (bitmap_slot_count + slot_count > max_glyphs) return error.GlyphCacheFull;
                if (text_backend == .kb_canvas) {
                    if (canvas_request_count >= canvas_requests.len or canvas_text_len + run_text_len > canvas_text.len)
                        return error.CanvasBatchFull;
                    @memcpy(canvas_text[canvas_text_len..][0..run_text_len], run_text[0..run_text_len]);
                    canvas_requests[canvas_request_count] = .{
                        .first_slot = first_slot,
                        .slot_count = slot_count,
                        .span_cells = span,
                        .text_offset = @intCast(canvas_text_len),
                        .text_len = @intCast(run_text_len),
                        .flags = style_index,
                    };
                    canvas_request_count += 1;
                    canvas_text_len += run_text_len;
                }
                for (start..end) |cell_x| {
                    if (raws[cell_x].wide == .spacer_tail) continue;
                    if (bitmap_slot_count >= max_glyphs) return error.GlyphCacheFull;
                    const slot = bitmap_slot_count;
                    bitmap_slot_count += 1;
                    if (text_backend == .kb_stb) {
                        const pixel_offset = (cell_x - start) * font_cell_width;
                        const pixel_width: u32 = @as(u32, font_cell_width) * cells[y * cols + cell_x].width;
                        if (gpu_glyph_bitmap(slot, run_mask[pixel_offset..].ptr, pixel_width, font_cell_height, @intCast(run_width)) != 1)
                            return error.GlyphFailed;
                    }
                    cached.slots[cell_x - start] = slot;
                    cells[y * cols + cell_x].glyph = slot + 1;
                }
                try glyph_cache.put(std.heap.wasm_allocator, cache_key, cached);
            }
            x = end;
        }
    }

    const cursor_x: u32 = if (cursor) |pos| if (pos.wide_tail and pos.x > 0) pos.x - 1 else pos.x else std.math.maxInt(u16);
    frame = .{
        .magic = 0x46574342,
        .version = 2,
        .cols = state.cols,
        .rows = state.rows,
        .cell_count = @intCast(cell_count),
        .reserved = (@as(u32, @intCast(@min(cache_hits, 0xffff))) << 16) | @as(u32, @intCast(@min(cache_misses, 0xffff))),
        .background = rgb(renderBackground(state)),
        .foreground = rgb(renderForeground(state)),
        .cursor_x = cursor_x,
        .cursor_y = if (cursor) |pos| pos.y else std.math.maxInt(u16),
        .cursor_flags = 0,
        .cursor_style = @intFromEnum(state.cursor.visual_style),
        .scroll_total = @intCast(bar.total),
        .scroll_offset = @intCast(bar.offset),
        .scroll_length = @intCast(bar.len),
        .atlas_slots = @intCast((cell_count * 5 + 3) / 4),
    };
    if (state.cursor.visible and cursor != null) frame.cursor_flags |= 1;
    if (state.cursor.blinking) frame.cursor_flags |= 2;
    if (has_text_blink) frame.cursor_flags |= 4;
    if (text_backend == .kb_canvas and canvas_request_count > 0 and
        gpu_glyph_canvas_batch(
            canvas_requests[0..canvas_request_count].ptr,
            canvas_request_count,
            canvas_text[0..canvas_text_len].ptr,
            canvas_text_len,
        ) != 1)
    {
        bitmap_cache_reset = true;
        return error.GlyphFailed;
    }
    const snapshot = try text_view.build(state);
    if (gpu_submit(
        &frame,
        cells[0..].ptr,
        snapshot.rows,
        snapshot.cells,
        snapshot.text,
        snapshot.text_len,
        @intFromBool(snapshot.changed),
    ) != 1) return error.SubmitFailed;
    text_view.commit(snapshot.hash);
}

fn cellStyle(state: *const ghostty.RenderState, raw: ghostty.page.Cell, stored: ghostty.Style, selection: ?[2]u16, x: usize) Style {
    const style: ghostty.Style = if (raw.hasStyling()) stored else .{};
    var fg = style.fg(.{
        .default = renderForeground(state),
        .palette = renderPalette(state),
        .bold = .bright,
    });
    var bg = style.bg(&raw, renderPalette(state)) orelse renderBackground(state);
    if (style.flags.inverse) std.mem.swap(ghostty.color.RGB, &fg, &bg);
    if (style.flags.invisible) fg = bg;
    const cell_end = std.math.add(usize, x, @as(usize, raw.gridWidth())) catch std.math.maxInt(usize);
    const selected = if (selection) |range|
        x <= @as(usize, range[1]) and cell_end > @as(usize, range[0])
    else
        false;
    var flags: u32 = 0;
    if (style.flags.bold) flags |= 1;
    if (style.flags.italic) flags |= 2;
    if (style.flags.faint) flags |= 4;
    if (style.flags.underline != .none) flags |= 8;
    if (style.flags.strikethrough) flags |= 16;
    if (style.flags.overline) flags |= 32;
    if (selected) flags |= 64;
    if (style.flags.blink) flags |= 128;
    return .{ .fg = rgb(fg), .bg = rgb(bg), .flags = flags };
}

fn rgb(value: ghostty.color.RGB) u32 {
    return (@as(u32, value.r) << 16) | (@as(u32, value.g) << 8) | value.b;
}
