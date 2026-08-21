// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

pub const protocol = "bcw.sessions";
pub const checkpoint_codec = "ghostty-snapshot";
pub const ghostty_commit = "f4f9991d2c188b7c1f364ed9e44b92dd3356bb2a";
pub const terminal_abi = "bcwebmux-ghostty-f4f9991-snapshot-8m-continuation-1m";
pub const terminal_config = "xterm-256color;grapheme-cluster=1;scrollback=8388608;continuation=1048576";
pub const command_profile = "shell";

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
        rows >= limits.min_rows and rows <= limits.max_rows;
}
