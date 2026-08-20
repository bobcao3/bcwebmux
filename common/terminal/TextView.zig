// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");
const ghostty = @import("ghostty-vt");
const Self = @This();

pub const max_cells = 32 * 1024;
const max_codepoints_per_cell = 32;
const max_text_bytes = max_cells * max_codepoints_per_cell * 4;

pub const Row = extern struct {
    text_offset: u32,
    text_len: u32,
    serial: u64,
    page_y: u32,
    flags: u32,
    hash: u64,
};

pub const Cell = extern struct {
    utf16_len: u16,
    width: u8,
    flags: u8,
};

pub const Snapshot = struct {
    rows: [*]const Row,
    cells: [*]const Cell,
    text: [*]const u8,
    text_len: usize,
    changed: bool,
    hash: u64,
};

const row_wrap: u32 = 1;
const cell_text: u8 = 1;

rows: [max_cells]Row align(8) = undefined,
cells: [max_cells]Cell align(4) = undefined,
text: [max_text_bytes]u8 = undefined,
previous_hash: ?u64 = null,

comptime {
    std.debug.assert(@sizeOf(Row) == 32);
    std.debug.assert(@sizeOf(Cell) == 4);
}

pub fn bootstrap(self: *Self) void {
    self.previous_hash = null;
}

pub fn reset(self: *Self) void {
    self.previous_hash = null;
}

pub fn commit(self: *Self, hash: u64) void {
    self.previous_hash = hash;
}

pub fn needsBuild(self: *const Self) bool {
    return self.previous_hash == null;
}

pub fn inactiveSnapshot(self: *const Self) Snapshot {
    return .{
        .rows = self.rows[0..].ptr,
        .cells = self.cells[0..].ptr,
        .text = self.text[0..].ptr,
        .text_len = 0,
        .changed = false,
        .hash = 0,
    };
}

pub fn build(self: *Self, state: *const ghostty.RenderState) !Snapshot {
    const cols: usize = @intCast(state.cols);
    const row_count: usize = @intCast(state.rows);
    const cell_count = std.math.mul(usize, cols, row_count) catch return error.GridTooLarge;
    if (cell_count > self.cells.len or row_count > self.rows.len) return error.GridTooLarge;

    var text_len: usize = 0;
    var hasher = std.hash.Wyhash.init(0);
    hasher.update(std.mem.asBytes(&state.cols));
    hasher.update(std.mem.asBytes(&state.rows));

    const row_data = state.row_data.slice();
    const row_pins = row_data.items(.pin);
    const row_serials = row_data.items(.serial);
    const row_raw = row_data.items(.raw);
    const row_cells = row_data.items(.cells);

    for (row_cells, 0..) |*render_cells, y| {
        const text_start = text_len;
        var row_hasher = std.hash.Wyhash.init(0);
        const slice = render_cells.slice();
        const raw_cells = slice.items(.raw);
        const graphemes = slice.items(.grapheme);

        for (raw_cells, graphemes, 0..) |raw, extra, x| {
            var record: Cell = .{ .utf16_len = 0, .width = 0, .flags = 0 };
            if (raw.wide != .spacer_tail) {
                record.width = raw.gridWidth();
                if (raw.hasText()) {
                    record.flags |= cell_text;
                    record.utf16_len = try self.appendCodepoint(raw.codepoint(), &text_len);
                    if (raw.hasGrapheme()) for (extra) |cp| {
                        const cp_len = try self.appendCodepoint(cp, &text_len);
                        record.utf16_len = std.math.add(u16, record.utf16_len, cp_len) catch
                            return error.CellTextTooLong;
                    };
                } else {
                    if (text_len >= self.text.len) return error.TextBufferFull;
                    self.text[text_len] = ' ';
                    text_len += 1;
                    record.utf16_len = 1;
                }
            }
            self.cells[y * cols + x] = record;
            row_hasher.update(std.mem.asBytes(&record));
        }

        const row_flags: u32 = if (row_raw[y].wrap) row_wrap else 0;
        row_hasher.update(std.mem.asBytes(&row_flags));
        row_hasher.update(self.text[text_start..text_len]);
        const descriptor: Row = .{
            .text_offset = @intCast(text_start),
            .text_len = @intCast(text_len - text_start),
            .serial = row_serials[y],
            .page_y = row_pins[y].y,
            .flags = row_flags,
            .hash = row_hasher.final(),
        };
        self.rows[y] = descriptor;
        hasher.update(std.mem.asBytes(&descriptor));
    }

    const hash = hasher.final();
    return .{
        .rows = self.rows[0..].ptr,
        .cells = self.cells[0..].ptr,
        .text = self.text[0..].ptr,
        .text_len = text_len,
        .changed = self.previous_hash == null or self.previous_hash.? != hash,
        .hash = hash,
    };
}

fn appendCodepoint(self: *Self, cp: u21, text_len: *usize) !u16 {
    var encoded: [4]u8 = undefined;
    const len = std.unicode.utf8Encode(cp, &encoded) catch
        std.unicode.utf8Encode(0xfffd, &encoded) catch unreachable;
    if (text_len.* > self.text.len or len > self.text.len - text_len.*) return error.TextBufferFull;
    @memcpy(self.text[text_len.*..][0..len], encoded[0..len]);
    text_len.* += len;
    return if (cp <= 0xffff) 1 else 2;
}
