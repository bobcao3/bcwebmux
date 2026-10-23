// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");
const config = @import("config");

pub fn main(init: std.process.Init) !void {
    const arena = init.arena.allocator();
    const args = try init.minimal.args.toSlice(arena);

    var child_args: std.ArrayList([]const u8) = .empty;
    try child_args.appendSlice(arena, &.{ config.zig_exe, "cc", "-target", config.target });
    try child_args.append(arena, try arena.print("-mcpu={s}", .{config.cpu}));
    if (args.len > 1) try child_args.appendSlice(arena, args[1..]);

    return std.process.replace(init.io, .{
        .argv = child_args.items,
        .environ_map = init.environ_map,
    });
}
