// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");

// Build-owned host runner. Source staging, toolchain, and caches are separate:
// changing one Go source file must not copy or rebuild the whole Go toolchain.
pub fn main(init: std.process.Init) !void {
    const arena = init.arena.allocator();
    const args = try init.minimal.args.toSlice(arena);
    if (args.len < 9) return error.InvalidArguments;
    const goroot = try std.Io.Dir.cwd().realPathFileAlloc(init.io, args[1], arena);
    const cc = try std.Io.Dir.cwd().realPathFileAlloc(init.io, args[2], arena);
    const header = try std.Io.Dir.cwd().realPathFileAlloc(init.io, args[3], arena);
    const core = try std.Io.Dir.cwd().realPathFileAlloc(init.io, args[4], arena);
    const zstd = try std.Io.Dir.cwd().realPathFileAlloc(init.io, args[5], arena);
    const arch = args[6];
    const cache = args[7];

    var env = std.process.Environ.Map.init(arena);
    // Keep only host process essentials. Ambient Go/cgo/compiler flags cannot
    // override the target, dependency resolution, or pinned compiler.
    for ([_][]const u8{ "PATH", "HOME", "ZIG_GLOBAL_CACHE_DIR" }) |key| {
        if (init.environ_map.get(key)) |value| try env.put(key, value);
    }
    for ([_][2][]const u8{
        .{ "GOROOT", goroot },       .{ "GOOS", "linux" },      .{ "GOARCH", arch },
        .{ "GOAMD64", "v1" },        .{ "GOARM64", "v8.0" },    .{ "GOENV", "off" },
        .{ "GOTOOLCHAIN", "local" }, .{ "GOWORK", "off" },      .{ "GOPROXY", "off" },
        .{ "GOSUMDB", "off" },       .{ "GOVCS", "*:off" },     .{ "CGO_ENABLED", "1" },
        .{ "GOFLAGS", "" },          .{ "GOTELEMETRY", "off" },
    }) |entry| try env.put(entry[0], entry[1]);
    try env.put("CC", try quote(arena, cc));
    try env.put("CGO_CFLAGS", try quote(arena, try std.fmt.allocPrint(arena, "-I{s}", .{std.fs.path.dirname(header).?})));
    try env.put("CGO_LDFLAGS", try std.fmt.allocPrint(arena, "{s} {s}", .{ try quote(arena, core), try quote(arena, zstd) }));
    for ([_][2][]const u8{ .{ "GOCACHE", "build" }, .{ "GOMODCACHE", "modules" }, .{ "GOPATH", "path" }, .{ "TMPDIR", "tmp" } }) |entry| {
        const path = try std.fs.path.join(arena, &.{ cache, entry[1] });
        try std.Io.Dir.cwd().createDirPath(init.io, path);
        try env.put(entry[0], path);
    }

    if (std.mem.eql(u8, args[8], "deps")) {
        try env.put("GOPROXY", "https://proxy.golang.org");
        try env.put("GOSUMDB", "sum.golang.org");
        const go = try std.fs.path.join(arena, &.{ goroot, "bin", "go" });
        for ([_][]const u8{ "tidy", "vendor" }) |command| {
            var child = try std.process.spawn(init.io, .{ .argv = &.{ go, "mod", command }, .environ_map = &env });
            const term = try child.wait(init.io);
            switch (term) {
                .exited => |code| if (code != 0) return error.DependencyMaintenanceFailed,
                else => return error.DependencyMaintenanceFailed,
            }
        }
        return;
    }

    var argv: std.array_list.Managed([]const u8) = .init(arena);
    try argv.append(try std.fs.path.join(arena, &.{ goroot, "bin", "go" }));
    try argv.appendSlice(args[8..]);
    return std.process.replace(init.io, .{ .argv = argv.items, .environ_map = &env });
}

// cmd/go's quoted flag syntax supports surrounding quotes, not shell escapes.
fn quote(arena: std.mem.Allocator, value: []const u8) ![]const u8 {
    if (std.mem.indexOfScalar(u8, value, '"') == null)
        return std.fmt.allocPrint(arena, "\"{s}\"", .{value});
    if (std.mem.indexOfScalar(u8, value, '\'') == null)
        return std.fmt.allocPrint(arena, "'{s}'", .{value});
    return error.PathContainsBothQuoteStyles;
}
