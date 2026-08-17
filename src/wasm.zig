// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");
const ghostty = @import("ghostty-vt");
const wgpu = @import("wgpu.zig");

pub const std_options_debug_io: std.Io = std.Io.failing;

const alloc = std.heap.wasm_allocator;
const io = ghostty.TinyIo.init.io();
const Handler = ghostty.TerminalStream.Handler;
const staging_capacity = 64 * 1024;

var terminal: ?ghostty.Terminal = null;
var stream: ?ghostty.TerminalStream = null;
var render_state: ghostty.RenderState = .empty;
var staging: [staging_capacity]u8 = undefined;
var busy = false;
var cell_width_px: u32 = 8;
var cell_height_px: u32 = 16;
var last_mouse_cell: ?ghostty.Coordinate = null;
// ABI staging buffer only; not authoritative theme state.
var theme_staging: [18]u32 = undefined;
var render_requested = false;
var selection_gesture: ghostty.SelectionGesture = .init;
var selection_snapshot: ?[:0]const u8 = null;

extern "host" fn pty_write(ptr: [*]const u8, len: usize) i32;
extern "host" fn set_title(ptr: [*]const u8, len: usize) void;
extern "host" fn ring_bell() void;

export fn bc_font_alloc(len: u32) u32 {
    const total = std.math.add(usize, @as(usize, len), 16) catch return 0;
    const memory = alloc.alignedAlloc(u8, .@"16", total) catch return 0;
    const header: *usize = @ptrCast(@alignCast(memory.ptr));
    header.* = total;
    return @intCast(@intFromPtr(memory.ptr) + 16);
}

export fn bc_font_free(ptr: u32) void {
    if (ptr == 0) return;
    const base: [*]align(16) u8 = @ptrFromInt(@as(usize, ptr) - 16);
    const header: *usize = @ptrCast(@alignCast(base));
    alloc.free(base[0..header.*]);
}

export fn term_set_font(font_raw: u32, ligatures_raw: u32) i32 {
    if (font_raw != 0) return 0;
    wgpu.setFont(ligatures_raw != 0);
    return 1;
}

export fn term_set_renderer(renderer_raw: u32) i32 {
    if (!wgpu.setTextBackend(renderer_raw)) return 0;
    render_requested = true;
    return 1;
}

export fn term_invalidate_glyph_cache() void {
    wgpu.invalidateGlyphCache();
    render_requested = true;
}

export fn term_invalidate_text_view() void {
    wgpu.invalidateTextView();
    render_requested = true;
}

export fn term_set_text_view_enabled(enabled_raw: u32) i32 {
    if (enabled_raw > 1) return 0;
    if (wgpu.setTextViewEnabled(enabled_raw != 0)) render_requested = true;
    return 1;
}

export fn term_init(cols: u16, rows: u16) i32 {
    if (busy or terminal != null or cols == 0 or rows == 0) return 0;
    terminal = ghostty.Terminal.init(io, alloc, .{
        .cols = cols,
        .rows = rows,
        .default_modes = .{ .grapheme_cluster = true },
        .max_scrollback_bytes = 8 * 1024 * 1024,
    }) catch return 0;
    const value = if (terminal) |*t| t else return 0;
    var handler = value.vtHandler();
    handler.terminfo_name = "xterm-256color";
    handler.effects.write_pty = effectWritePty;
    handler.effects.bell = effectBell;
    handler.effects.title_changed = effectTitle;
    handler.effects.size = effectSize;
    handler.effects.enquiry = effectEnquiry;
    handler.effects.xtversion = effectVersion;
    stream = ghostty.TerminalStream.init(.{ .allocator = alloc, .handler = handler });
    render_state.update(alloc, value) catch {
        term_deinit();
        return 0;
    };
    if (!wgpu.init(value.cols, value.rows)) {
        term_deinit();
        return 0;
    }
    selection_gesture = .init;
    freeSelectionSnapshot();
    last_mouse_cell = null;
    return 1;
}

export fn term_theme_ptr() u32 {
    return @intCast(@intFromPtr(&theme_staging));
}

export fn term_apply_theme() i32 {
    if (busy or terminal == null) return 0;
    const value = if (terminal) |*t| t else return 0;
    var palette = ghostty.color.default;
    for (0..16) |i| {
        palette[i] = packedRgb(theme_staging[i + 2]);
    }
    value.colors.palette.changeDefault(palette);
    value.colors.background.default = packedRgb(theme_staging[0]);
    value.colors.foreground.default = packedRgb(theme_staging[1]);
    value.flags.dirty.palette = true;
    return 1;
}

export fn term_deinit() void {
    if (busy) return;
    if (stream) |*value| value.deinit();
    stream = null;
    render_state.deinit(alloc);
    render_state = .empty;
    if (terminal) |*value| {
        selection_gesture.deinit(value);
        value.deinit(alloc);
    }
    selection_gesture = .init;
    freeSelectionSnapshot();
    terminal = null;
    last_mouse_cell = null;
}

export fn term_reserve(len: u32) u32 {
    if (busy or len == 0 or len > staging.len) return 0;
    return @intCast(@intFromPtr(&staging));
}

export fn term_feed(len: u32) i32 {
    if (busy or len > staging.len) return 0;
    const terminal_value = if (terminal) |*t| t else return 0;
    const value = if (stream) |*s| s else return 0;
    const bar = terminal_value.screens.active.pages.scrollbar();
    const follow_output = bar.offset >= bar.total -| bar.len;
    busy = true;
    defer busy = false;
    value.nextSlice(staging[0..len]);
    if (follow_output) terminal_value.scrollViewport(.bottom);
    return 1;
}

export fn term_resize(cols: u16, rows: u16, cell_width: u16, cell_height: u16, glyph_cell_width: u16, glyph_cell_height: u16, glyph_font_size_px: u16, atlas_columns: u16) i32 {
    if (busy or cols == 0 or rows == 0 or atlas_columns == 0) return 0;
    const value = if (stream) |*s| s else return 0;
    busy = true;
    defer busy = false;
    cell_width_px = @max(1, cell_width);
    cell_height_px = @max(1, cell_height);
    wgpu.setFontMetrics(
        @max(1, glyph_cell_width),
        @max(1, glyph_cell_height),
        @max(1, glyph_font_size_px),
        atlas_columns,
    );
    value.handler.resize(.{
        .cols = cols,
        .rows = rows,
        .cell_size_px = .{ .width = cell_width_px, .height = cell_height_px },
    }) catch return 0;
    last_mouse_cell = null;
    return 1;
}

export fn term_scroll_row(row: u32) i32 {
    if (busy) return 0;
    const value = if (terminal) |*t| t else return 0;
    const bar = value.screens.active.pages.scrollbar();
    const max_row = bar.total -| bar.len;
    value.scrollViewport(.{ .row = @intCast(@min(row, max_row)) });
    return 1;
}

export fn term_text(len: u32, paste_mode: u32) i32 {
    if (busy or len > staging.len) return 0;
    const value = if (terminal) |*t| t else return 0;
    busy = true;
    defer busy = false;
    scrollBottom(value);
    const data = staging[0..len];
    if (paste_mode == 0) {
        if (data.len == 0) return 1;
        return pty_write(data.ptr, data.len);
    }
    const slices = ghostty.input.encodePaste(data, .fromTerminal(value));
    for (slices) |slice| {
        if (slice.len == 0) continue;
        if (pty_write(slice.ptr, slice.len) != 1) return 0;
    }
    return 1;
}

export fn term_key(action_raw: u8, mods_raw: u16, consumed_raw: u16, code_len: u16, text_len: u16) i32 {
    const total_len = @as(usize, code_len) + @as(usize, text_len);
    if (busy or action_raw > 2 or total_len > staging.len) return 0;
    const value = if (terminal) |*t| t else return 0;
    const code = staging[0..code_len];
    const text = staging[code_len..total_len];
    const key = ghostty.input.Key.fromW3C(code) orelse .unidentified;
    const action: ghostty.input.KeyAction = @enumFromInt(action_raw);
    const mods: ghostty.input.KeyMods = @bitCast(mods_raw & 0x3f);
    const consumed: ghostty.input.KeyMods = @bitCast(consumed_raw & 0x3f);
    busy = true;
    defer busy = false;
    scrollBottom(value);
    var encoded: [256]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&encoded);
    ghostty.input.encodeKey(&writer, .{
        .action = action,
        .key = key,
        .mods = mods,
        .consumed_mods = consumed,
        .utf8 = text,
        .unshifted_codepoint = key.codepoint() orelse 0,
    }, .fromTerminal(value)) catch return 0;
    const data = writer.buffered();
    if (data.len == 0) return 1;
    return pty_write(data.ptr, data.len);
}

export fn term_mouse(action_raw: u8, button_raw: u8, mods_raw: u16, x: f32, y: f32, any_button_pressed: u32) i32 {
    if (action_raw > 2 or (button_raw != 0xff and button_raw > 11) or busy) return 0;
    const value = if (terminal) |*t| t else return 0;
    busy = true;
    defer busy = false;
    var options = ghostty.input.MouseEncodeOptions.fromTerminal(value, .{
        .screen = .{
            .width = value.cols * cell_width_px,
            .height = value.rows * cell_height_px,
        },
        .cell = .{ .width = cell_width_px, .height = cell_height_px },
        .padding = .{},
    });
    options.any_button_pressed = any_button_pressed != 0;
    options.last_cell = &last_mouse_cell;
    var encoded: [128]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&encoded);
    ghostty.input.encodeMouse(&writer, .{
        .action = @enumFromInt(action_raw),
        .button = if (button_raw == 0xff) null else @enumFromInt(button_raw),
        .mods = @bitCast(mods_raw & 0x3f),
        .pos = .{ .x = x, .y = y },
    }, options) catch return 0;
    const data = writer.buffered();
    if (data.len == 0) return 0;
    return pty_write(data.ptr, data.len);
}

fn freeSelectionSnapshot() void {
    if (selection_snapshot) |snapshot| alloc.free(snapshot);
    selection_snapshot = null;
}

fn packedRgb(value: u32) ghostty.color.RGB {
    return .{
        .r = @truncate(value >> 16),
        .g = @truncate(value >> 8),
        .b = @truncate(value),
    };
}

fn selectionPin(value: *ghostty.Terminal, x: f32, y: f32) ?ghostty.Pin {
    if (!std.math.isFinite(x) or !std.math.isFinite(y)) return null;
    const screen = value.screens.active;
    const px_float = @min(
        @as(f32, @floatFromInt(value.cols - 1)),
        @max(0, @floor(x / @as(f32, @floatFromInt(cell_width_px)))),
    );
    const py_float = @min(
        @as(f32, @floatFromInt(value.rows - 1)),
        @max(0, @floor(y / @as(f32, @floatFromInt(cell_height_px)))),
    );
    const px: u16 = @intFromFloat(px_float);
    const py: u16 = @intFromFloat(py_float);
    return screen.pages.pin(.{ .viewport = .{ .x = px, .y = py } });
}

export fn term_selection(action_raw: u8, x: f32, y: f32) i32 {
    if (busy or action_raw > 3) return 0;
    const value = if (terminal) |*t| t else return 0;
    if (action_raw == 3) {
        busy = true;
        defer busy = false;
        selection_gesture.reset(value);
        return 1;
    }
    const pin = selectionPin(value, x, y) orelse return 0;
    const screen = value.screens.active;
    busy = true;
    defer busy = false;
    switch (action_raw) {
        0 => {
            const selection = (selection_gesture.press(value, .{
                .time = null,
                .pin = pin,
                .xpos = x,
                .ypos = y,
                .max_distance = @floatFromInt(cell_width_px),
                .repeat_interval = 500 * std.time.ns_per_ms,
                .word_boundary_codepoints = &.{},
            }) catch return 0) orelse {
                screen.clearSelection();
                return 1;
            };
            screen.select(selection) catch return 0;
        },
        1 => selection_gesture.release(value, .{ .pin = pin }),
        2 => {
            const selection = selection_gesture.drag(value, .{
                .pin = pin,
                .xpos = x,
                .ypos = y,
                .rectangle = false,
                .word_boundary_codepoints = &.{},
                .geometry = .{
                    .columns = @intCast(value.cols),
                    .cell_width = cell_width_px,
                    .padding_left = 0,
                    .screen_height = value.rows * cell_height_px,
                },
            });
            screen.select(selection) catch return 0;
        },
        else => unreachable,
    }
    return 1;
}

export fn term_selection_clear() i32 {
    if (busy) return 0;
    const value = if (terminal) |*t| t else return 0;
    busy = true;
    defer busy = false;
    selection_gesture.reset(value);
    value.screens.active.clearSelection();
    return 1;
}

export fn term_selection_set_range(start_row: u32, start_col: u32, end_row: u32, end_col: u32) i32 {
    if (busy) return 0;
    const value = if (terminal) |*t| t else return 0;
    if (start_row >= @as(u32, value.rows) or end_row >= @as(u32, value.rows) or
        start_col > @as(u32, value.cols) or end_col > @as(u32, value.cols))
        return 0;

    const columns: u64 = value.cols;
    const total_cells: u64 = @as(u64, value.rows) * columns;
    const start_boundary: u64 = @as(u64, start_row) * columns + start_col;
    const end_boundary: u64 = @as(u64, end_row) * columns + end_col;
    if (start_boundary >= end_boundary) {
        busy = true;
        defer busy = false;
        selection_gesture.reset(value);
        value.screens.active.clearSelection();
        return 1;
    }
    if (start_boundary >= total_cells) return 0;

    const end_cell = end_boundary - 1;
    const screen = value.screens.active;
    const start_pin = screen.pages.pin(.{ .viewport = .{
        .x = @intCast(start_boundary % columns),
        .y = @intCast(start_boundary / columns),
    } }) orelse return 0;
    const end_pin = screen.pages.pin(.{ .viewport = .{
        .x = @intCast(end_cell % columns),
        .y = @intCast(end_cell / columns),
    } }) orelse return 0;
    busy = true;
    defer busy = false;
    selection_gesture.reset(value);
    screen.select(ghostty.Selection.init(start_pin, end_pin, false)) catch return 0;
    return 1;
}

export fn term_selection_snapshot() i32 {
    if (busy) return -1;
    freeSelectionSnapshot();
    const value = if (terminal) |*t| t else return -1;
    const screen = value.screens.active;
    const selection = screen.selection orelse return 0;
    busy = true;
    defer busy = false;
    const snapshot = screen.selectionString(alloc, .{ .sel = selection, .trim = true }) catch return -2;
    if (snapshot.len == 0) {
        alloc.free(snapshot);
        return 2;
    }
    selection_snapshot = snapshot;
    return 1;
}

export fn term_selection_snapshot_ptr() u32 {
    return if (selection_snapshot) |snapshot| @intCast(@intFromPtr(snapshot.ptr)) else 0;
}

export fn term_selection_snapshot_len() u32 {
    return if (selection_snapshot) |snapshot| @intCast(snapshot.len) else 0;
}

export fn term_selection_snapshot_release() void {
    freeSelectionSnapshot();
}

export fn term_focus(focused: u32) i32 {
    if (busy) return 0;
    const value = if (terminal) |*t| t else return 0;
    busy = true;
    defer busy = false;
    value.flags.focused = focused != 0;
    if (!value.modes.get(.focus_event)) return 1;
    var encoded: [ghostty.input.max_focus_encode_size]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&encoded);
    ghostty.input.encodeFocus(&writer, if (focused != 0) .gained else .lost) catch return 0;
    const data = writer.buffered();
    if (data.len == 0) return 1;
    return pty_write(data.ptr, data.len);
}

export fn term_frame() i32 {
    if (busy) return -2;
    const value = if (terminal) |*t| t else return 0;
    busy = true;
    defer busy = false;
    const previous_cursor_viewport = render_state.cursor.viewport;
    const previous_cursor_visible = render_state.cursor.visible;
    const previous_cursor_blinking = render_state.cursor.blinking;
    const previous_cursor_style = render_state.cursor.visual_style;
    render_state.update(alloc, value) catch return -1;
    const cursor_changed =
        !cursorViewportEqual(previous_cursor_viewport, render_state.cursor.viewport) or
        previous_cursor_visible != render_state.cursor.visible or
        previous_cursor_blinking != render_state.cursor.blinking or
        previous_cursor_style != render_state.cursor.visual_style;
    if (render_state.dirty == .false and !cursor_changed and !render_requested) return 0;
    wgpu.submit(&render_state, value) catch return -1;
    render_requested = false;
    render_state.clean();
    return 1;
}

fn cursorViewportEqual(a: anytype, b: anytype) bool {
    if (a == null or b == null) return a == null and b == null;
    return a.?.x == b.?.x and a.?.y == b.?.y;
}

fn scrollBottom(value: *ghostty.Terminal) void {
    const bar = value.screens.active.pages.scrollbar();
    value.scrollViewport(.{ .row = @intCast(bar.total -| bar.len) });
}

fn effectWritePty(_: *Handler, data: [:0]const u8) void {
    if (data.len != 0) _ = pty_write(data.ptr, data.len);
}

fn effectBell(_: *Handler) void {
    ring_bell();
}

fn effectTitle(handler: *Handler) void {
    const title = handler.terminal.getTitle() orelse return;
    set_title(title.ptr, title.len);
}

fn effectSize(_: *Handler) ?ghostty.size_report.Size {
    const value = if (terminal) |*t| t else return null;
    return .{
        .rows = value.rows,
        .columns = value.cols,
        .cell_width = cell_width_px,
        .cell_height = cell_height_px,
    };
}

fn effectEnquiry(_: *Handler) []const u8 {
    return "bcwebmux";
}

fn effectVersion(_: *Handler) []const u8 {
    return "bcwebmux 0.1.0";
}
