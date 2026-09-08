// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");
const config = @import("config");

pub fn main(init: std.process.Init) !void {
    const arena = init.arena.allocator();
    const args = try init.minimal.args.toSlice(arena);

    var child_args = std.array_list.Managed([]const u8).init(arena);
    try child_args.append(config.zig_exe);
    try child_args.append("cc");
    try child_args.append("-target");
    try child_args.append(config.target);
    try child_args.append(try std.fmt.allocPrint(arena, "-mcpu={s}", .{config.cpu}));
    if (args.len > 1) try child_args.appendSlice(args[1..]);

    return std.process.replace(init.io, .{
        .argv = child_args.items,
        .environ_map = init.environ_map,
    });
}
