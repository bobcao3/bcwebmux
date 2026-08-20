// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");
const Terminal = @import("Terminal.zig");

pub const std_options_debug_io: std.Io = std.Io.failing;

// A WebAssembly instance exposes one terminal through this C-shaped ABI.
// Each new WebAssembly instance calls term_bootstrap exactly once before any terminal method.
var terminal: Terminal = undefined;

export fn bc_font_alloc(len: u32) u32 {
    return Terminal.bc_font_alloc(len);
}

export fn bc_font_free(ptr: u32) void {
    Terminal.bc_font_free(ptr);
}

export fn term_set_font(font_raw: u32, ligatures_raw: u32) i32 {
    return terminal.term_set_font(font_raw, ligatures_raw);
}

export fn term_set_renderer(renderer_raw: u32) i32 {
    return terminal.term_set_renderer(renderer_raw);
}

export fn term_invalidate_glyph_cache() void {
    terminal.term_invalidate_glyph_cache();
}

export fn term_invalidate_text_view() void {
    terminal.term_invalidate_text_view();
}

export fn term_invalidate_render_cache() void {
    terminal.term_invalidate_render_cache();
}

export fn term_set_text_view_enabled(enabled_raw: u32) i32 {
    return terminal.term_set_text_view_enabled(enabled_raw);
}

export fn term_bootstrap() void {
    terminal.bootstrap();
}

export fn term_init(cols: u16, rows: u16) i32 {
    return terminal.term_init(cols, rows);
}

export fn term_theme_ptr() u32 {
    return terminal.term_theme_ptr();
}

export fn term_apply_theme() i32 {
    return terminal.term_apply_theme();
}

export fn term_deinit() void {
    terminal.term_deinit();
}

export fn term_snapshot_reserve(len: u32) u32 {
    return terminal.term_snapshot_reserve(len);
}

export fn term_snapshot_restore(len: u32) i32 {
    return terminal.term_snapshot_restore(len);
}

export fn term_reserve(len: u32) u32 {
    return terminal.term_reserve(len);
}

export fn term_feed(len: u32) i32 {
    return terminal.term_feed(len);
}

export fn term_resize(cols: u16, rows: u16, cell_width: u16, cell_height: u16, glyph_cell_width: u16, glyph_cell_height: u16, glyph_font_size_px: u16, atlas_columns: u16) i32 {
    return terminal.term_resize(cols, rows, cell_width, cell_height, glyph_cell_width, glyph_cell_height, glyph_font_size_px, atlas_columns);
}

export fn term_scroll_row(row: u32) i32 {
    return terminal.term_scroll_row(row);
}

export fn term_text(len: u32, paste_mode: u32) i32 {
    return terminal.term_text(len, paste_mode);
}

export fn term_key(action_raw: u8, mods_raw: u16, consumed_raw: u16, code_len: u16, text_len: u16) i32 {
    return terminal.term_key(action_raw, mods_raw, consumed_raw, code_len, text_len);
}

export fn term_mouse(action_raw: u8, button_raw: u8, mods_raw: u16, x: f32, y: f32, any_button_pressed: u32) i32 {
    return terminal.term_mouse(action_raw, button_raw, mods_raw, x, y, any_button_pressed);
}

export fn term_selection(action_raw: u8, x: f32, y: f32) i32 {
    return terminal.term_selection(action_raw, x, y);
}

export fn term_selection_clear() i32 {
    return terminal.term_selection_clear();
}

export fn term_selection_set_range(start_row: u32, start_col: u32, end_row: u32, end_col: u32) i32 {
    return terminal.term_selection_set_range(start_row, start_col, end_row, end_col);
}

export fn term_selection_snapshot() i32 {
    return terminal.term_selection_snapshot();
}

export fn term_selection_snapshot_ptr() u32 {
    return terminal.term_selection_snapshot_ptr();
}

export fn term_selection_snapshot_len() u32 {
    return terminal.term_selection_snapshot_len();
}

export fn term_selection_snapshot_release() void {
    terminal.term_selection_snapshot_release();
}

export fn term_hyperlink_at(x: f32, y: f32) i32 {
    return terminal.term_hyperlink_at(x, y);
}

export fn term_hyperlink_ptr() u32 {
    return terminal.term_hyperlink_ptr();
}

export fn term_hyperlink_len() u32 {
    return terminal.term_hyperlink_len();
}

export fn term_focus(focused: u32) i32 {
    return terminal.term_focus(focused);
}

export fn term_frame() i32 {
    return terminal.term_frame();
}
