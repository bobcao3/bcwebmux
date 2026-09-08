// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");
// Only the compression algorithm uses C; host file operations use std.Io.
const c = @cImport({
    @cInclude("zstd.h");
});

pub fn main(init: std.process.Init) !void {
    const arena = init.arena.allocator();
    const args = try init.minimal.args.toSlice(arena);
    if (args.len != 3) return error.InvalidArguments; // OUTPUT INPUT
    const cwd = std.Io.Dir.cwd();
    const source = try cwd.readFileAlloc(init.io, args[2], arena, .unlimited);
    const compressed = try arena.alloc(u8, c.ZSTD_compressBound(source.len));
    const size = c.ZSTD_compress(compressed.ptr, compressed.len, source.ptr, source.len, 19);
    if (c.ZSTD_isError(size) != 0) {
        std.log.err("zstd compression failed: {s}", .{c.ZSTD_getErrorName(size)});
        return error.CompressionFailed;
    }
    const output = try cwd.createFile(init.io, args[1], .{});
    defer output.close(init.io);
    errdefer cwd.deleteFile(init.io, args[1]) catch {};
    var buffer: [64 * 1024]u8 = undefined;
    var writer = output.writer(init.io, &buffer);
    try writer.interface.writeAll(compressed[0..size]);
    try writer.interface.flush();
}
