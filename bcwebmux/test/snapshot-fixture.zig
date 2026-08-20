// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");
const ghostty = @import("ghostty-vt");

pub fn main(init: std.process.Init) !void {
    const args = try init.minimal.args.toSlice(init.arena.allocator());
    if (args.len != 3) return error.ExpectedOutputPathAndMode;

    const csi_mode = if (std.mem.eql(u8, args[2], "csi"))
        true
    else if (std.mem.eql(u8, args[2], "utf8"))
        false
    else
        return error.UnknownMode;

    const alloc = std.heap.smp_allocator;
    const io = init.io;
    var terminal = try ghostty.Terminal.init(io, alloc, .{
        .cols = 40,
        .rows = 8,
        .default_modes = .{ .grapheme_cluster = true },
        .max_scrollback_bytes = 8 * 1024 * 1024,
    });
    defer terminal.deinit(alloc);

    var stream = ghostty.TerminalStream.init(.{
        .allocator = alloc,
        .handler = .init(&terminal),
        .continuation_max_bytes = 4096,
    });
    defer stream.deinit();

    stream.nextSlice("\x1b]2;native snapshot fixture\x1b\\");
    stream.nextSlice("\x1b[2J\x1b[H\x1b[1;34mNATIVE SNAPSHOT\x1b[0m\r\n");
    var line_buffer: [64]u8 = undefined;
    for (0..48) |index| {
        const line = try std.fmt.bufPrint(&line_buffer, "history-{d:0>2} λ界\r\n", .{index});
        stream.nextSlice(line);
    }
    stream.nextSlice("\x1b[1;35mThis styled line intentionally wraps across the primary grid\x1b[0m\r\n");
    stream.nextSlice("\x1b]8;;https://example.com/native\x1b\\native hyperlink\x1b]8;;\x1b\\\r\n");
    stream.nextSlice("\x1b[2J\x1b[HPRIMARY SNAPSHOT READY\r\n");

    if (csi_mode) {
        stream.nextSlice("\x1b[?1049h\x1b[2J\x1b[H");
        stream.nextSlice("\x1b[1;32mALTERNATE SNAPSHOT READY\x1b[0m\r\n");
        stream.nextSlice("\x1b]8;;https://example.com/alternate\x1b\\alternate hyperlink\x1b]8;;\x1b\\ 界界\r\n");
        stream.nextSlice("\x1b[?25l");
    } else {
        stream.nextSlice("\x1b[2J\x1b[HUTF8 SNAPSHOT READY\r\n");
        stream.nextSlice("\xF0\x9F");
    }

    const expected_continuation = if (csi_mode) "\x1b[31" else "\xF0\x9F";
    if (csi_mode) stream.nextSlice("\x1b[31");

    var continuation_buffer: [4096]u8 = undefined;
    var continuation_writer: std.Io.Writer = .fixed(&continuation_buffer);
    try stream.writeContinuation(&continuation_writer);
    if (!std.mem.eql(u8, continuation_writer.buffered(), expected_continuation)) {
        return error.UnexpectedContinuation;
    }

    var snapshot: std.Io.Writer.Allocating = .init(alloc);
    defer snapshot.deinit();
    try ghostty.snapshot.encode(alloc, &snapshot.writer, &terminal, .{
        .continuation = .{ .bytes = continuation_writer.buffered() },
    });
    try std.Io.Dir.cwd().writeFile(init.io, .{
        .sub_path = args[1],
        .data = snapshot.written(),
    });
}
