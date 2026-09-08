// SPDX-License-Identifier: MIT
const std = @import("std");
const pty_worker = @import("pty_worker.zig");

pub fn main(init: std.process.Init) !void {
    const arena = init.arena.allocator();
    const args = try init.minimal.args.toSlice(arena);
    if (args.len != 5 or !std.mem.eql(u8, args[1], "--session-worker")) {
        std.debug.print("usage: {s} --session-worker SHELL COLS ROWS\n", .{args[0]});
        return error.InvalidArgument;
    }
    const cols = std.fmt.parseInt(u16, args[3], 10) catch return error.InvalidArgument;
    const rows = std.fmt.parseInt(u16, args[4], 10) catch return error.InvalidArgument;
    if (cols == 0 or rows == 0) return error.InvalidArgument;
    try pty_worker.run(init.io, args[2], cols, rows, .{});
}
