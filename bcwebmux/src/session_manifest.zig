// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

pub const protocol = "bcw.sessions";
pub const checkpoint_codec = "ghostty-snapshot";
pub const ghostty_commit = "f4f9991d2c188b7c1f364ed9e44b92dd3356bb2a";
pub const terminal_abi = "bcwebmux-ghostty-f4f9991-snapshot-8m-continuation-1m-glyph-cell-partitions-pty-zstd-stream";
pub const terminal_config = "xterm-256color;grapheme-cluster=1;scrollback=8388608;continuation=1048576";
pub const command_profile = "shell";
pub const max_connection_attachments: usize = 8;
pub const max_credit_bytes: usize = 32 * 1024 * 1024;
pub const initial_credit_bytes: usize = 32 * 1024 * 1024;
pub const checkpoint_chunk_bytes: usize = 256 * 1024;
pub const event_batch_bytes: usize = 256 * 1024;
pub const heartbeat_interval_ms: i64 = 5_000;
pub const heartbeat_timeout_ms: i64 = 15_000;
pub const publish_interval_ms: i64 = 10;
pub const terminal_cell_protocol_limit: usize = 0xffff;

pub const Limits = struct {
    max_live_sessions: usize = 16,
    max_exited_sessions: usize = 64,
    max_attachments_per_session: usize = 8,
    max_name_bytes: usize = 80,
    max_request_bytes: usize = 4096,
    max_input_bytes: usize = 64 * 1024,
    max_frame_bytes: usize = 1024 * 1024,
    max_checkpoint_bytes: usize = 16 * 1024 * 1024,
    scrollback_bytes: usize = 8 * 1024 * 1024,
    journal_bytes: usize = 8 * 1024 * 1024,
    checkpoint_output_bytes: usize = 2 * 1024 * 1024,
    checkpoint_interval_ms: i64 = 30_000,
    termination_grace_ms: i64 = 2_000,
    exited_retention_ms: i64 = 24 * 60 * 60 * 1000,
    min_cols: u16 = 20,
    max_cols: u16 = 500,
    min_rows: u16 = 5,
    max_rows: u16 = 200,
};

pub fn validGeometry(limits: Limits, cols: u16, rows: u16) bool {
    return cols >= limits.min_cols and cols <= limits.max_cols and
        rows >= limits.min_rows and rows <= limits.max_rows and
        @as(usize, cols) * @as(usize, rows) <= terminal_cell_protocol_limit;
}

pub fn validCellGeometry(cell_width_px: u16, cell_height_px: u16) bool {
    return cell_width_px >= 1 and cell_width_px <= 256 and
        cell_height_px >= 1 and cell_height_px <= 256;
}
