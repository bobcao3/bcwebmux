// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");

pub const resize_magic: u32 = 0x52574342;

pub const Resize = extern struct {
    magic: u32 = resize_magic,
    cols: u16,
    rows: u16,
    reserved: u32 = 0,
};

comptime {
    std.debug.assert(@sizeOf(Resize) == 12);
}

test "resize native layout" {
    const source = Resize{ .cols = 80, .rows = 24 };
    var target: Resize = undefined;
    @memcpy(std.mem.asBytes(&target), std.mem.asBytes(&source));
    try std.testing.expectEqual(source.magic, target.magic);
    try std.testing.expectEqual(source.cols, target.cols);
    try std.testing.expectEqual(source.rows, target.rows);
    try std.testing.expectEqual(source.reserved, target.reserved);
}
