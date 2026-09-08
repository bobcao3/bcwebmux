// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao
//
// This is intentionally a small host-side helper. It is run by build.zig via
// the exact Zig executable which is running the build, so provisioning does
// not depend on an installed Go command or a host scripting runtime.

const std = @import("std");
const builtin = @import("builtin");

const Sha256 = std.crypto.hash.sha2.Sha256;
const log = std.log.scoped(.go_toolchain);

const ArchivePin = struct {
    filename: []const u8,
    sha256: []const u8,
};

const Pin = struct {
    version: []const u8,
    archives: std.json.ArrayHashMap(ArchivePin),
};

const Args = struct {
    manifest: []const u8,
    output: []const u8,
};

pub fn main(init: std.process.Init) !void {
    const io = init.io;
    const arena = init.arena.allocator();
    const argv = try init.minimal.args.toSlice(arena);
    const args = try parseArgs(argv);

    const pin_bytes = try std.Io.Dir.cwd().readFileAlloc(io, args.manifest, arena, .limited(128 * 1024));
    const pin = try std.json.parseFromSliceLeaky(Pin, arena, pin_bytes, .{
        .ignore_unknown_fields = true,
        .allocate = .alloc_if_needed,
    });

    const host_os = hostOs() orelse return error.UnsupportedHost;
    const host_arch = hostArch() orelse return error.UnsupportedHost;
    const host_key = try std.fmt.allocPrint(arena, "{s}-{s}", .{ host_os, host_arch });
    const pinned_archive = pin.archives.map.get(host_key) orelse {
        log.err("the pinned Go release has no archive for host {s}", .{host_key});
        return error.UnsupportedHost;
    };

    const filename_prefix = try std.fmt.allocPrint(arena, "{s}.", .{pin.version});
    if (std.mem.indexOfAny(u8, pinned_archive.filename, "/\\") != null or
        !std.mem.startsWith(u8, pinned_archive.filename, filename_prefix) or
        !std.mem.endsWith(u8, pinned_archive.filename, ".tar.gz"))
    {
        return error.InvalidGoArchive;
    }

    var client = std.http.Client{ .io = io, .allocator = arena };
    defer client.deinit();

    const output = std.Io.Dir.cwd();

    const archive_url = try std.fmt.allocPrint(arena, "https://dl.google.com/go/{s}", .{pinned_archive.filename});
    defer arena.free(archive_url);
    log.info("fetching {s} ({s})", .{ archive_url, pinned_archive.sha256 });

    const archive_bytes = try fetch(arena, &client, archive_url);
    try verifySha256(archive_bytes, pinned_archive.sha256);

    var out_dir = try output.openDir(io, args.output, .{ .iterate = true });
    defer out_dir.close(io);
    // Build outputs must be empty; never remove pre-existing files on failure.
    var entries = out_dir.iterate();
    if (try entries.next(io) != null) return error.OutputDirectoryNotEmpty;
    errdefer out_dir.deleteTree(io, ".") catch {};
    try extractArchive(io, out_dir, archive_bytes);
    out_dir.access(io, "bin/go", .{}) catch |err| {
        log.err("Go archive extracted without bin/go: {t}", .{err});
        return error.InvalidGoArchive;
    };
}

fn parseArgs(argv: []const []const u8) !Args {
    var manifest: ?[]const u8 = null;
    var output: ?[]const u8 = null;
    var i: usize = 1;
    while (i < argv.len) : (i += 1) {
        const name = argv[i];
        if (std.mem.eql(u8, name, "--manifest") or std.mem.eql(u8, name, "--output")) {
            if (i + 1 >= argv.len) return error.InvalidArguments;
            const value = argv[i + 1];
            if (std.mem.eql(u8, name, "--manifest")) {
                manifest = value;
            } else {
                output = value;
            }
            i += 1;
        } else {
            return error.InvalidArguments;
        }
    }
    return .{
        .manifest = manifest orelse return error.InvalidArguments,
        .output = output orelse return error.InvalidArguments,
    };
}

fn hostOs() ?[]const u8 {
    return switch (builtin.os.tag) {
        .linux => "linux",
        .macos => "darwin",
        .freebsd => "freebsd",
        else => null,
    };
}

fn hostArch() ?[]const u8 {
    return switch (builtin.cpu.arch) {
        .x86_64 => "amd64",
        .aarch64 => "arm64",
        else => null,
    };
}

fn fetch(arena: std.mem.Allocator, client: *std.http.Client, url: []const u8) ![]const u8 {
    var body = std.Io.Writer.Allocating.init(arena);
    const result = try client.fetch(.{
        .location = .{ .url = url },
        .redirect_behavior = .init(8),
        .response_writer = &body.writer,
    });
    if (result.status != .ok) {
        log.err("GET {s} returned HTTP {t}", .{ url, result.status });
        return error.HttpRequestFailed;
    }
    return body.written();
}

fn verifySha256(bytes: []const u8, expected_hex: []const u8) !void {
    var actual: [Sha256.digest_length]u8 = undefined;
    Sha256.hash(bytes, &actual, .{});

    var expected: [Sha256.digest_length]u8 = undefined;
    const decoded = std.fmt.hexToBytes(&expected, expected_hex) catch return error.InvalidSha256;
    if (decoded.len != expected.len or !std.mem.eql(u8, &actual, &expected)) {
        log.err("Go archive SHA-256 mismatch (got {x}, expected {s})", .{ actual, expected_hex });
        return error.Sha256Mismatch;
    }
}

fn extractArchive(io: std.Io, output: std.Io.Dir, archive: []const u8) !void {
    var input: std.Io.Reader = .fixed(archive);
    var buffer: [std.compress.flate.max_window_len]u8 = undefined;
    var decompress: std.compress.flate.Decompress = .init(&input, .gzip, &buffer);
    try std.tar.extract(io, output, &decompress.reader, .{ .strip_components = 1 });
}
