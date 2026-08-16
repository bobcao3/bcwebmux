const std = @import("std");
const ghostty = @import("ghostty-vt");

pub const max_cells = 32 * 1024;
pub const max_glyphs = max_cells * 5 / 4;
pub const screen_text_capacity = 1024 * 1024;

const cell_shader = @embedFile("shaders/cell.wgsl");

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

const GlyphEntry = struct {
    hash: u64 = 0,
    glyph: u32 = 0,
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
var screen_text: [screen_text_capacity]u8 = undefined;
var glyph_entries: [max_glyphs]GlyphEntry = [_]GlyphEntry{.{}} ** max_glyphs;
var glyph_count: u32 = 0;

extern "host" fn gpu_submit(frame_ptr: *const Frame, cells_ptr: [*]Cell) i32;
extern "host" fn gpu_glyph(glyph: u32, text_ptr: [*]const u8, text_len: usize, flags: u32) i32;
extern "host" fn gpu_init(
    cell_ptr: [*]const u8,
    cell_len: usize,
    max_cells_value: usize,
    max_glyphs_value: usize,
    atlas_slots_value: usize,
    cell_size: usize,
) i32;

pub fn init(cols: usize, rows: usize) bool {
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
    const cols: usize = @intCast(state.cols);
    const rows_count: usize = @intCast(state.rows);
    const cell_count = cols * rows_count;
    if (cell_count > cells.len) return error.GridTooLarge;

    const rows = state.row_data.slice();
    const row_cells = rows.items(.cells);
    const selections = rows.items(.selection);
    const bar = terminal.screens.active.pages.scrollbar();
    @memset(std.mem.sliceAsBytes(cells[0..cell_count]), 0);
    var writer: std.Io.Writer = .fixed(&screen_text);

    var has_text_blink = false;
    for (row_cells, selections, 0..) |*render_cells, selection, y| {
        const slice = render_cells.slice();
        const raws = slice.items(.raw);
        const styles = slice.items(.style);
        const graphemes = slice.items(.grapheme);
        for (raws, styles, 0..) |raw, stored, x| {
            if (raw.wide == .spacer_tail) continue;
            const text_offset = writer.end;
            if (raw.hasText()) {
                var encoded: [4]u8 = undefined;
                const len = std.unicode.utf8Encode(raw.codepoint(), &encoded) catch 0;
                try writer.writeAll(encoded[0..len]);
                if (raw.hasGrapheme()) {
                    for (graphemes[x]) |cp| {
                        const grapheme_len = std.unicode.utf8Encode(cp, &encoded) catch 0;
                        try writer.writeAll(encoded[0..grapheme_len]);
                    }
                }
            } else {
                try writer.writeByte(' ');
            }
            const style = cellStyle(state, raw, stored, selection, x);
            if ((style.flags & 128) != 0) has_text_blink = true;
            cells[y * cols + x] = .{
                .x = @intCast(x),
                .y = @intCast(y),
                .width = @intCast(raw.gridWidth()),
                .flags = style.flags,
                .fg = style.fg,
                .bg = style.bg,
                .glyph = try resolveGlyph(screen_text[text_offset..writer.end], style.flags),
                .active = 1,
            };
        }
        if (y + 1 < row_cells.len) try writer.writeByte('\n');
    }

    const cursor = state.cursor.viewport;
    frame = .{
        .magic = 0x46574342,
        .version = 2,
        .cols = state.cols,
        .rows = state.rows,
        .cell_count = @intCast(cell_count),
        .reserved = 0,
        .background = rgb(state.colors.background),
        .foreground = rgb(state.colors.foreground),
        .cursor_x = if (cursor) |pos| pos.x else std.math.maxInt(u16),
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
    if (gpu_submit(&frame, cells[0..].ptr) != 1) return error.SubmitFailed;
}

fn resolveGlyph(value: []const u8, flags: u32) !u32 {
    if (value.len == 1 and value[0] == ' ') return 0;
    const key = std.hash.Wyhash.hash(@as(u64, flags), value) | 1;
    var index: usize = @intCast(key % max_glyphs);
    var probe: usize = 0;
    while (probe < max_glyphs) : (probe += 1) {
        const entry = &glyph_entries[index];
        if (entry.hash == key) return entry.glyph;
        if (entry.hash == 0) {
            if (glyph_count >= max_glyphs) return error.GlyphCacheFull;
            const slot = glyph_count;
            if (gpu_glyph(slot, value.ptr, value.len, flags) != 1) return error.GlyphFailed;
            entry.* = .{ .hash = key, .glyph = slot + 1 };
            glyph_count += 1;
            return slot + 1;
        }
        index = (index + 1) % max_glyphs;
    }
    return error.GlyphCacheFull;
}

fn cellStyle(state: *const ghostty.RenderState, raw: ghostty.page.Cell, stored: ghostty.Style, selection: ?[2]u16, x: usize) Style {
    const style: ghostty.Style = if (raw.hasStyling()) stored else .{};
    var fg = style.fg(.{
        .default = state.colors.foreground,
        .palette = &state.colors.palette,
        .bold = .bright,
    });
    var bg = style.bg(&raw, &state.colors.palette) orelse state.colors.background;
    if (style.flags.inverse) std.mem.swap(ghostty.color.RGB, &fg, &bg);
    if (style.flags.invisible) fg = bg;
    const selected = if (selection) |range| x >= range[0] and x <= range[1] else false;
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
