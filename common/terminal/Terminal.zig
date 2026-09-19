// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");
const ghostty = @import("ghostty-vt");
const RenderFrame = @import("RenderFrame.zig");
const FontEngine = @import("FontEngine.zig");

const Self = @This();

const alloc = std.heap.wasm_allocator;
const io = ghostty.TinyIo.init.io();
const Handler = ghostty.TerminalStream.Handler;
const staging_capacity = 64 * 1024;
const continuation_capacity = 1024 * 1024;
const snapshot_capacity = 16 * 1024 * 1024;
const default_selection_word_boundaries = [_]u21{ 0, ' ', '\t', '\'', '"', '│', '`', '|', ':', ';', ',', '(', ')', '[', ']', '{', '}', '<', '>', '$' };

terminal: ?ghostty.Terminal = null,
stream: ?ghostty.TerminalStream = null,
render_state: ghostty.RenderState = .empty,
staging: [staging_capacity]u8 = undefined,
snapshot_staging: ?[]u8 = null,
busy: bool = false,
replay_mode: bool = false,
deinit_pending: bool = false,
cell_width_px: u32 = 8,
cell_height_px: u32 = 16,
last_mouse_cell: ?ghostty.Coordinate = null,
// ABI staging buffer only; not authoritative theme state.
theme_staging: [18]u32 = undefined,
render_requested: bool = false,
selection_gesture: ghostty.SelectionGesture = .init,
selection_snapshot: ?[:0]const u8 = null,
hyperlink_snapshot: [4096]u8 = undefined,
hyperlink_snapshot_len: u32 = 0,
renderer: RenderFrame = .{},

extern "host" fn user_write(ptr: [*]const u8, len: usize) i32;
extern "host" fn terminal_reply(ptr: [*]const u8, len: usize) i32;
extern "host" fn set_title(ptr: [*]const u8, len: usize) void;
extern "host" fn ring_bell() void;
extern "host" fn desktop_notification(title_ptr: [*]const u8, title_len: usize, body_ptr: [*]const u8, body_len: usize) void;
extern "host" fn clipboard_write(location: i32, ptr: [*]const u8, len: usize) i32;

const ClipboardWriteFn = @typeInfo(@typeInfo(@FieldType(Handler.Effects, "clipboard_write")).optional.child).pointer.child;
const ClipboardWriteInfo = @typeInfo(ClipboardWriteFn).@"fn";
const ClipboardWrite = ClipboardWriteInfo.params[1].type.?;

pub fn bootstrap(self: *Self) void {
    self.terminal = null;
    self.stream = null;
    self.render_state = .empty;
    self.snapshot_staging = null;
    self.busy = false;
    self.replay_mode = false;
    self.deinit_pending = false;
    self.cell_width_px = 8;
    self.cell_height_px = 16;
    self.last_mouse_cell = null;
    self.render_requested = false;
    self.selection_gesture = .init;
    self.selection_snapshot = null;
    self.hyperlink_snapshot_len = 0;
    self.renderer.bootstrap();
}

pub fn bc_font_alloc(len: u32) u32 {
    const pointer = FontEngine.cAlloc(len) orelse return 0;
    return @intCast(@intFromPtr(pointer));
}

pub fn bc_font_free(ptr: u32) void {
    FontEngine.cFree(if (ptr == 0) null else @ptrFromInt(ptr));
}

pub fn term_set_font(self: *Self, font_raw: u32, ligatures_raw: u32) i32 {
    if (font_raw != 0) return 0;
    self.renderer.setFont(ligatures_raw != 0);
    return 1;
}

pub fn term_set_renderer(self: *Self, renderer_raw: u32) i32 {
    if (!self.renderer.setTextBackend(renderer_raw)) return 0;
    self.render_requested = true;
    return 1;
}

pub fn term_invalidate_text_view(self: *Self) void {
    self.renderer.invalidateTextView();
    self.render_requested = true;
}

pub fn term_invalidate_frame_cache(self: *Self) void {
    self.renderer.invalidateFrameCache();
    self.render_requested = true;
}

pub fn term_set_glyph_partition(self: *Self, base_slot: u32, slot_capacity: u32, atlas_columns: u16, generation: u32) i32 {
    if (self.busy) return 0;
    if (!self.renderer.setGlyphPartition(base_slot, slot_capacity, atlas_columns, generation)) return 0;
    self.render_requested = true;
    return 1;
}

pub fn term_set_text_view_enabled(self: *Self, enabled_raw: u32) i32 {
    if (enabled_raw > 1) return 0;
    if (self.renderer.setTextViewEnabled(enabled_raw != 0)) self.render_requested = true;
    return 1;
}

pub fn term_init(self: *Self, cols: u16, rows: u16) i32 {
    if (self.busy or self.terminal != null or cols == 0 or rows == 0) return 0;
    self.replay_mode = false;
    self.deinit_pending = false;
    self.terminal = ghostty.Terminal.init(io, alloc, .{
        .cols = cols,
        .rows = rows,
        .default_modes = .{ .grapheme_cluster = true },
        .max_scrollback_bytes = 8 * 1024 * 1024,
    }) catch return 0;
    const value = if (self.terminal) |*t| t else return 0;
    self.stream = ghostty.TerminalStream.init(.{
        .allocator = alloc,
        .handler = configuredHandler(value),
        .continuation_max_bytes = continuation_capacity,
    });
    self.render_state.update(alloc, value) catch {
        self.term_deinit();
        return 0;
    };
    if (!self.renderer.init(value.cols, value.rows)) {
        self.term_deinit();
        return 0;
    }
    self.selection_gesture = .init;
    self.freeSelectionSnapshot();
    self.last_mouse_cell = null;
    return 1;
}

pub fn term_set_replay_mode(self: *Self, enabled_raw: u32) i32 {
    if (self.busy or enabled_raw > 1) return 0;
    self.replay_mode = enabled_raw != 0;
    return 1;
}

pub fn term_theme_ptr(self: *Self) u32 {
    return @intCast(@intFromPtr(&self.theme_staging));
}

pub fn term_apply_theme(self: *Self) i32 {
    if (self.busy or self.terminal == null) return 0;
    const value = if (self.terminal) |*t| t else return 0;
    var palette = ghostty.color.default;
    for (0..16) |i| {
        palette[i] = packedRgb(self.theme_staging[i + 2]);
    }
    value.colors.palette.changeDefault(alloc, palette) catch return 0;
    value.colors.background.default = packedRgb(self.theme_staging[0]);
    value.colors.foreground.default = packedRgb(self.theme_staging[1]);
    value.flags.dirty.palette = true;
    return 1;
}

pub fn term_deinit(self: *Self) void {
    if (self.busy) {
        self.deinit_pending = true;
        return;
    }
    self.deinit_pending = false;
    if (self.stream) |*value| value.deinit();
    self.stream = null;
    self.render_state.deinit(alloc);
    self.render_state = .empty;
    if (self.terminal) |*value| {
        self.selection_gesture.deinit(value);
        value.deinit(alloc);
    }
    self.selection_gesture = .init;
    self.freeSelectionSnapshot();
    self.hyperlink_snapshot_len = 0;
    self.terminal = null;
    self.last_mouse_cell = null;
    self.freeSnapshotStaging();
    self.renderer.deinit();
}

fn finishBusy(self: *Self) void {
    self.busy = false;
    if (self.deinit_pending) self.term_deinit();
}

pub fn term_snapshot_reserve(self: *Self, len: u32) u32 {
    if (self.busy or len == 0 or len > snapshot_capacity) return 0;
    const size: usize = len;
    if (self.snapshot_staging) |buffer| {
        if (buffer.len == size) return @intCast(@intFromPtr(buffer.ptr));
    }
    const buffer = alloc.alloc(u8, size) catch return 0;
    if (self.snapshot_staging) |old| alloc.free(old);
    self.snapshot_staging = buffer;
    return @intCast(@intFromPtr(buffer.ptr));
}

pub fn term_snapshot_restore(self: *Self, len: u32) i32 {
    if (self.busy or len == 0 or len > snapshot_capacity) return 0;
    const staged = self.snapshot_staging orelse return 0;
    if (staged.len != len) return 0;
    defer self.freeSnapshotStaging();

    self.busy = true;
    defer self.finishBusy();
    var source: std.Io.Reader = .fixed(staged);
    var decoded = ghostty.snapshot.decodeExact(alloc, io, &source, .{
        .max_continuation_bytes = continuation_capacity,
    }) catch return 0;
    defer decoded.deinit(alloc);
    var replacement_terminal: ghostty.Terminal = decoded.toOwned();
    var replacement_render_state: ghostty.RenderState = .empty;
    replacement_render_state.update(alloc, &replacement_terminal) catch {
        replacement_render_state.deinit(alloc);
        replacement_terminal.deinit(alloc);
        return 0;
    };

    if (self.stream) |*value| value.deinit();
    self.stream = null;
    self.render_state.deinit(alloc);
    self.render_state = .empty;
    if (self.terminal) |*value| {
        self.selection_gesture.deinit(value);
        value.deinit(alloc);
    }

    self.terminal = replacement_terminal;
    replacement_terminal = undefined;
    self.selection_gesture = .init;
    self.freeSelectionSnapshot();
    self.hyperlink_snapshot_len = 0;
    self.last_mouse_cell = null;
    if (self.terminal) |*value| {
        self.stream = ghostty.TerminalStream.init(.{
            .allocator = alloc,
            .handler = configuredHandler(value),
            .continuation_max_bytes = continuation_capacity,
        });
        switch (decoded.continuation) {
            .ground => {},
            .bytes => |bytes| self.stream.?.nextSlice(bytes),
        }
    }
    self.render_state = replacement_render_state;
    self.renderer.invalidateRenderCache();
    self.renderer.invalidateGlyphCache();
    self.renderer.invalidateTextView();
    self.render_requested = true;
    return 1;
}

pub fn term_reserve(self: *Self, len: u32) u32 {
    if (self.busy or len == 0 or len > self.staging.len) return 0;
    return @intCast(@intFromPtr(&self.staging));
}

pub fn term_feed(self: *Self, len: u32) i32 {
    if (self.busy or len > self.staging.len) return 0;
    const value = if (self.stream) |*s| s else return 0;
    self.busy = true;
    defer self.finishBusy();
    value.nextSlice(self.staging[0..len]);
    return 1;
}

pub fn term_resize(self: *Self, cols: u16, rows: u16, cell_width: u16, cell_height: u16, glyph_cell_width: u16, glyph_cell_height: u16, glyph_font_size_px: u16) i32 {
    if (self.term_set_render_metrics(
        cell_width,
        cell_height,
        glyph_cell_width,
        glyph_cell_height,
        glyph_font_size_px,
    ) == 0) return 0;
    return self.term_resize_canonical(cols, rows, cell_width, cell_height);
}

pub fn term_set_render_metrics(self: *Self, cell_width: u16, cell_height: u16, glyph_cell_width: u16, glyph_cell_height: u16, glyph_font_size_px: u16) i32 {
    if (self.busy) return 0;
    self.busy = true;
    defer self.finishBusy();
    self.cell_width_px = @max(1, cell_width);
    self.cell_height_px = @max(1, cell_height);
    self.renderer.setFontMetrics(
        @max(1, glyph_cell_width),
        @max(1, glyph_cell_height),
        @max(1, glyph_font_size_px),
    );
    return 1;
}

pub fn term_resize_canonical(self: *Self, cols: u16, rows: u16, cell_width: u16, cell_height: u16) i32 {
    if (self.busy or cols == 0 or rows == 0) return 0;
    const stream_value = if (self.stream) |*s| s else return 0;
    if (self.terminal == null) return 0;
    self.busy = true;
    defer self.finishBusy();
    stream_value.handler.resize(.{
        .cols = cols,
        .rows = rows,
        .cell_size_px = .{ .width = @max(1, @as(u32, cell_width)), .height = @max(1, @as(u32, cell_height)) },
    }) catch return 0;
    self.last_mouse_cell = null;
    return 1;
}

pub fn term_scroll_row(self: *Self, row: u32) i32 {
    if (self.busy) return 0;
    const value = if (self.terminal) |*t| t else return 0;
    const bar = value.screens.active.pages.scrollbar();
    const max_row = bar.total -| bar.len;
    const clamped = @min(row, max_row);
    value.scrollViewport(if (clamped == max_row) .bottom else .{ .row = @intCast(clamped) });
    return 1;
}

pub fn term_scroll_delta(self: *Self, rows: i32) i32 {
    if (self.busy) return 0;
    const value = if (self.terminal) |*t| t else return 0;
    value.scrollViewport(.{ .delta = @intCast(rows) });
    return 1;
}

// Return values: viewport=1, mouse-report=2, alternate-scroll=3.
pub fn term_scroll_input(self: *Self, rows: i32, mods_raw: u16, x: f32, y: f32) i32 {
    if (self.busy) return 0;
    const value = if (self.terminal) |*t| t else return 0;
    if (rows == 0) return 1;

    self.busy = true;
    defer self.finishBusy();

    const direction: i32 = if (rows > 0) 1 else -1;
    var remaining: u32 = if (rows > 0)
        @intCast(rows)
    else
        @as(u32, @intCast(-(rows + 1))) + 1;

    if (value.screens.active_key == .alternate and
        value.flags.mouse_event == .none and
        value.modes.get(.mouse_alternate_scroll))
    {
        self.selection_gesture.reset(value);
        value.screens.active.clearSelection();
        const sequence = if (value.modes.get(.cursor_keys))
            (if (direction > 0) "\x1bOB" else "\x1bOA")
        else
            (if (direction > 0) "\x1b[B" else "\x1b[A");
        while (remaining != 0) : (remaining -= 1) {
            if (user_write(sequence.ptr, sequence.len) != 1) return 0;
        }
        return 3;
    }

    if (value.flags.mouse_event != .none) {
        self.selection_gesture.reset(value);
        value.screens.active.clearSelection();
        var options = ghostty.input.MouseEncodeOptions.fromTerminal(value, .{
            .screen = .{
                .width = value.cols * self.cell_width_px,
                .height = value.rows * self.cell_height_px,
            },
            .cell = .{ .width = self.cell_width_px, .height = self.cell_height_px },
            .padding = .{},
        });
        options.last_cell = &self.last_mouse_cell;
        while (remaining != 0) : (remaining -= 1) {
            var encoded: [128]u8 = undefined;
            var writer: std.Io.Writer = .fixed(&encoded);
            ghostty.input.encodeMouse(&writer, .{
                .action = .press,
                .button = if (direction < 0) .four else .five,
                .mods = @bitCast(mods_raw & 0x3f),
                .pos = .{ .x = x, .y = y },
            }, options) catch return 0;
            const data = writer.buffered();
            if (user_write(data.ptr, data.len) != 1) return 0;
        }
        return 2;
    }

    value.scrollViewport(.{ .delta = @intCast(rows) });
    return 1;
}

pub fn term_scroll_bottom(self: *Self) i32 {
    if (self.busy) return 0;
    const value = if (self.terminal) |*t| t else return 0;
    value.scrollViewport(.bottom);
    return 1;
}

pub fn term_text(self: *Self, len: u32, paste_mode: u32) i32 {
    if (self.busy or len > self.staging.len) return 0;
    const value = if (self.terminal) |*t| t else return 0;
    self.busy = true;
    defer self.finishBusy();
    const data = self.staging[0..len];
    if (paste_mode == 0) {
        if (data.len == 0) return 1;
        scrollBottom(value);
        return user_write(data.ptr, data.len);
    }
    if (data.len == 0) return 1;
    scrollBottom(value);
    const slices = ghostty.input.encodePaste(data, .fromTerminal(value));
    for (slices) |slice| {
        if (slice.len == 0) continue;
        if (user_write(slice.ptr, slice.len) != 1) return 0;
    }
    return 1;
}

pub fn term_key(self: *Self, action_raw: u8, mods_raw: u16, consumed_raw: u16, code_len: u16, text_len: u16) i32 {
    const total_len = @as(usize, code_len) + @as(usize, text_len);
    if (self.busy or action_raw > 2 or total_len > self.staging.len) return 0;
    const value = if (self.terminal) |*t| t else return 0;
    const code = self.staging[0..code_len];
    const text = self.staging[code_len..total_len];
    const key = ghostty.input.Key.fromW3C(code) orelse .unidentified;
    const action: ghostty.input.KeyAction = @enumFromInt(action_raw);
    const mods: ghostty.input.KeyMods = @bitCast(mods_raw & 0x3f);
    const consumed: ghostty.input.KeyMods = @bitCast(consumed_raw & 0x3f);
    self.busy = true;
    defer self.finishBusy();
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
    scrollBottom(value);
    return user_write(data.ptr, data.len);
}

pub fn term_mouse(self: *Self, action_raw: u8, button_raw: u8, mods_raw: u16, x: f32, y: f32, any_button_pressed: u32) i32 {
    if (action_raw > 2 or (button_raw != 0xff and button_raw > 11) or self.busy) return 0;
    const value = if (self.terminal) |*t| t else return 0;
    self.busy = true;
    defer self.finishBusy();
    var options = ghostty.input.MouseEncodeOptions.fromTerminal(value, .{
        .screen = .{
            .width = value.cols * self.cell_width_px,
            .height = value.rows * self.cell_height_px,
        },
        .cell = .{ .width = self.cell_width_px, .height = self.cell_height_px },
        .padding = .{},
    });
    options.any_button_pressed = any_button_pressed != 0;
    options.last_cell = &self.last_mouse_cell;
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
    return user_write(data.ptr, data.len);
}

fn freeSelectionSnapshot(self: *Self) void {
    if (self.selection_snapshot) |snapshot| alloc.free(snapshot);
    self.selection_snapshot = null;
}

fn freeSnapshotStaging(self: *Self) void {
    if (self.snapshot_staging) |staging_buffer| alloc.free(staging_buffer);
    self.snapshot_staging = null;
}

fn configuredHandler(value: *ghostty.Terminal) Handler {
    var handler = value.vtHandler();
    handler.terminfo_name = "xterm-256color";
    handler.effects.write_pty = effectWritePty;
    handler.effects.bell = effectBell;
    handler.effects.title_changed = effectTitle;
    handler.effects.size = effectSize;
    handler.effects.enquiry = effectEnquiry;
    handler.effects.xtversion = effectVersion;
    handler.effects.desktop_notification = effectDesktopNotification;
    handler.effects.clipboard_write = effectClipboardWrite;
    return handler;
}

fn packedRgb(value: u32) ghostty.color.RGB {
    return .{
        .r = @truncate(value >> 16),
        .g = @truncate(value >> 8),
        .b = @truncate(value),
    };
}

fn selectionPin(self: *Self, value: *ghostty.Terminal, x: f32, y: f32) ?ghostty.Pin {
    if (!std.math.isFinite(x) or !std.math.isFinite(y)) return null;
    const screen = value.screens.active;
    const px_float = @min(
        @as(f32, @floatFromInt(value.cols - 1)),
        @max(0, @floor(x / @as(f32, @floatFromInt(self.cell_width_px)))),
    );
    const py_float = @min(
        @as(f32, @floatFromInt(value.rows - 1)),
        @max(0, @floor(y / @as(f32, @floatFromInt(self.cell_height_px)))),
    );
    const px: u16 = @intFromFloat(px_float);
    const py: u16 = @intFromFloat(py_float);
    return screen.pages.pin(.{ .viewport = .{ .x = px, .y = py } });
}

pub fn term_selection(self: *Self, action_raw: u8, x: f32, y: f32) i32 {
    if (self.busy or action_raw > 3) return 0;
    const value = if (self.terminal) |*t| t else return 0;
    if (action_raw == 3) {
        self.busy = true;
        defer self.finishBusy();
        self.selection_gesture.reset(value);
        return 1;
    }
    const pin = self.selectionPin(value, x, y) orelse return 0;
    const screen = value.screens.active;
    self.busy = true;
    defer self.finishBusy();
    switch (action_raw) {
        0 => {
            const selection = (self.selection_gesture.press(value, .{
                .time = null,
                .pin = pin,
                .xpos = x,
                .ypos = y,
                .max_distance = @floatFromInt(self.cell_width_px),
                .repeat_interval = 500 * std.time.ns_per_ms,
                .word_boundary_codepoints = &.{},
            }) catch return 0) orelse {
                screen.clearSelection();
                return 1;
            };
            screen.select(selection) catch return 0;
        },
        1 => self.selection_gesture.release(value, .{ .pin = pin }),
        2 => {
            const selection = self.selection_gesture.drag(value, .{
                .pin = pin,
                .xpos = x,
                .ypos = y,
                .rectangle = false,
                .word_boundary_codepoints = &.{},
                .geometry = .{
                    .columns = @intCast(value.cols),
                    .cell_width = self.cell_width_px,
                    .padding_left = 0,
                    .screen_height = value.rows * self.cell_height_px,
                },
            });
            screen.select(selection) catch return 0;
        },
        else => unreachable,
    }
    return 1;
}

pub fn term_selection_word(self: *Self, x: f32, y: f32) i32 {
    if (self.busy) return 0;
    const value = if (self.terminal) |*t| t else return 0;
    const pin = self.selectionPin(value, x, y) orelse return 0;
    const screen = value.screens.active;
    self.busy = true;
    defer self.finishBusy();
    self.selection_gesture.reset(value);
    const selection = screen.selectWord(pin, &default_selection_word_boundaries) orelse {
        screen.clearSelection();
        return 0;
    };
    screen.select(selection) catch return 0;
    return 1;
}

pub fn term_selection_clear(self: *Self) i32 {
    if (self.busy) return 0;
    const value = if (self.terminal) |*t| t else return 0;
    const had_selection = value.screens.active.selection != null;
    self.busy = true;
    defer self.finishBusy();
    self.selection_gesture.reset(value);
    value.screens.active.clearSelection();
    return if (had_selection) 1 else 0;
}

pub fn term_selection_set_range(self: *Self, start_row: u32, start_col: u32, end_row: u32, end_col: u32) i32 {
    if (self.busy) return 0;
    const value = if (self.terminal) |*t| t else return 0;
    if (start_row >= @as(u32, value.rows) or end_row >= @as(u32, value.rows) or
        start_col > @as(u32, value.cols) or end_col > @as(u32, value.cols))
        return 0;

    const columns: u64 = value.cols;
    const total_cells: u64 = @as(u64, value.rows) * columns;
    const start_boundary: u64 = @as(u64, start_row) * columns + start_col;
    const end_boundary: u64 = @as(u64, end_row) * columns + end_col;
    if (start_boundary >= end_boundary) {
        self.busy = true;
        defer self.finishBusy();
        self.selection_gesture.reset(value);
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
    self.busy = true;
    defer self.finishBusy();
    self.selection_gesture.reset(value);
    screen.select(ghostty.Selection.init(start_pin, end_pin, false)) catch return 0;
    return 1;
}

pub fn term_selection_snapshot(self: *Self) i32 {
    if (self.busy) return -1;
    self.freeSelectionSnapshot();
    const value = if (self.terminal) |*t| t else return -1;
    const screen = value.screens.active;
    const selection = screen.selection orelse return 0;
    self.busy = true;
    defer self.finishBusy();
    const snapshot = screen.selectionString(alloc, .{ .sel = selection, .trim = true }) catch return -2;
    if (snapshot.len == 0) {
        alloc.free(snapshot);
        return 2;
    }
    self.selection_snapshot = snapshot;
    return 1;
}

pub fn term_selection_snapshot_ptr(self: *Self) u32 {
    return if (self.selection_snapshot) |snapshot| @intCast(@intFromPtr(snapshot.ptr)) else 0;
}

pub fn term_selection_snapshot_len(self: *Self) u32 {
    return if (self.selection_snapshot) |snapshot| @intCast(snapshot.len) else 0;
}

pub fn term_selection_snapshot_release(self: *Self) void {
    self.freeSelectionSnapshot();
}

pub fn term_hyperlink_at(self: *Self, x: f32, y: f32) i32 {
    if (self.busy) return 0;
    const value = if (self.terminal) |*t| t else return 0;
    if (!std.math.isFinite(x) or !std.math.isFinite(y) or x < 0 or y < 0) return 0;
    if (x >= @as(f32, @floatFromInt(value.cols)) * @as(f32, @floatFromInt(self.cell_width_px)) or
        y >= @as(f32, @floatFromInt(value.rows)) * @as(f32, @floatFromInt(self.cell_height_px)))
        return 0;

    self.busy = true;
    defer self.finishBusy();
    self.hyperlink_snapshot_len = 0;
    const pin = value.screens.active.pages.pin(.{
        .viewport = .{
            .x = @intFromFloat(@floor(x / @as(f32, @floatFromInt(self.cell_width_px)))),
            .y = @intFromFloat(@floor(y / @as(f32, @floatFromInt(self.cell_height_px)))),
        },
    }) orelse return 0;
    const rac = pin.rowAndCell();
    if (!rac.cell.hyperlink) return 0;
    const page = pin.node.page();
    const id = page.lookupHyperlink(rac.cell) orelse return 0;
    const entry = page.hyperlink_set.get(page.memory, id);
    const uri = entry.uri.slice(page.memory);
    if (uri.len > self.hyperlink_snapshot.len) return -1;
    @memcpy(self.hyperlink_snapshot[0..uri.len], uri);
    self.hyperlink_snapshot_len = @intCast(uri.len);
    return 1;
}

pub fn term_hyperlink_ptr(self: *Self) u32 {
    return @intCast(@intFromPtr(&self.hyperlink_snapshot));
}

pub fn term_hyperlink_len(self: *Self) u32 {
    return self.hyperlink_snapshot_len;
}

pub fn term_focus(self: *Self, focused: u32) i32 {
    if (self.busy) return 0;
    const value = if (self.terminal) |*t| t else return 0;
    self.busy = true;
    defer self.finishBusy();
    value.flags.focused = focused != 0;
    if (!value.modes.get(.focus_event)) return 1;
    var encoded: [ghostty.input.max_focus_encode_size]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&encoded);
    ghostty.input.encodeFocus(&writer, if (focused != 0) .gained else .lost) catch return 0;
    const data = writer.buffered();
    if (data.len == 0) return 1;
    return user_write(data.ptr, data.len);
}

pub fn term_frame(self: *Self) i32 {
    if (self.busy) return -2;
    const value = if (self.terminal) |*t| t else return 0;
    self.busy = true;
    defer self.finishBusy();
    const previous_cursor_viewport = self.render_state.cursor.viewport;
    const previous_cursor_visible = self.render_state.cursor.visible;
    const previous_cursor_blinking = self.render_state.cursor.blinking;
    const previous_cursor_style = self.render_state.cursor.visual_style;
    self.render_state.update(alloc, value) catch return -1;
    const cursor_changed =
        !cursorViewportEqual(previous_cursor_viewport, self.render_state.cursor.viewport) or
        previous_cursor_visible != self.render_state.cursor.visible or
        previous_cursor_blinking != self.render_state.cursor.blinking or
        previous_cursor_style != self.render_state.cursor.visual_style;
    if (self.render_state.dirty == .false and !cursor_changed and !self.render_requested) return 0;
    self.renderer.submit(&self.render_state, value) catch return -1;
    self.render_requested = false;
    self.render_state.clean();
    return 1;
}

fn cursorViewportEqual(a: anytype, b: anytype) bool {
    if (a == null or b == null) return a == null and b == null;
    return a.?.x == b.?.x and a.?.y == b.?.y;
}

fn scrollBottom(value: *ghostty.Terminal) void {
    value.scrollViewport(.bottom);
}

fn owner(handler: *Handler) *Self {
    const terminal_ptr: *?ghostty.Terminal = @ptrCast(handler.terminal);
    return @alignCast(@fieldParentPtr("terminal", terminal_ptr));
}

fn effectWritePty(handler: *Handler, data: []const u8) void {
    if (owner(handler).replay_mode) return;
    if (data.len != 0) _ = terminal_reply(data.ptr, data.len);
}

fn effectBell(handler: *Handler) void {
    if (owner(handler).replay_mode) return;
    ring_bell();
}

fn effectTitle(handler: *Handler) void {
    const title = handler.terminal.getTitle() orelse return;
    set_title(title.ptr, title.len);
}

fn effectDesktopNotification(handler: *Handler, notification: ghostty.TerminalStream.Action.ShowDesktopNotification) void {
    if (owner(handler).replay_mode) return;
    desktop_notification(
        notification.title.ptr,
        notification.title.len,
        notification.body.ptr,
        notification.body.len,
    );
}

fn effectClipboardWrite(handler: *Handler, write: ClipboardWrite) void {
    if (owner(handler).replay_mode) return write.reply(.unsupported);
    if (write.location != .standard) return write.reply(.unsupported);

    var data: []const u8 = &.{};
    if (write.contents.len != 0) {
        if (write.contents.len != 1) return write.reply(.unsupported);
        const content = write.contents[0];
        if (!std.mem.eql(u8, content.mime, "text/plain")) return write.reply(.unsupported);
        if (!std.unicode.utf8ValidateSlice(content.data)) return write.reply(.invalid_data);
        data = content.data;
    }

    write.reply(switch (clipboard_write(@intCast(@intFromEnum(write.location)), data.ptr, data.len)) {
        0 => .{ .success = .{} },
        1 => .denied,
        2 => .unsupported,
        3 => .busy,
        4 => .invalid_data,
        else => .io_error,
    });
}

fn effectSize(handler: *Handler) ?ghostty.size_report.Size {
    const value = handler.terminal;
    const cell_width = if (value.width_px != 0 and value.cols != 0)
        @max(1, value.width_px / value.cols)
    else
        8;
    const cell_height = if (value.height_px != 0 and value.rows != 0)
        @max(1, value.height_px / value.rows)
    else
        16;
    return .{
        .rows = value.rows,
        .columns = value.cols,
        .cell_width = cell_width,
        .cell_height = cell_height,
    };
}

fn effectEnquiry(_: *Handler) []const u8 {
    return "bcwebmux";
}

fn effectVersion(_: *Handler) []const u8 {
    return "bcwebmux 0.1.0";
}
