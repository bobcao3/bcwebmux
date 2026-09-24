// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");

pub const Etag = [66]u8;

pub const Asset = struct {
    data: []const u8,
    etag: Etag,
};

pub fn contentEtag(data: []const u8) Etag {
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(data, &digest, .{});
    return digestEtag(digest);
}

pub fn digestEtag(digest: [32]u8) Etag {
    return .{'"'} ++ std.fmt.bytesToHex(digest, .lower) ++ .{'"'};
}

pub const Vfs = struct {
    archive: []const u8,
    files: std.StringHashMapUnmanaged(Asset),

    pub fn init(allocator: std.mem.Allocator, compressed: []const u8) !Vfs {
        var input: std.Io.Reader = .fixed(compressed);
        var output: std.Io.Writer.Allocating = .init(allocator);
        defer output.deinit();
        var decompressor: std.compress.zstd.Decompress = .init(&input, &.{}, .{});
        _ = decompressor.reader.streamRemaining(&output.writer) catch |err| {
            if (decompressor.err) |decompress_error| return decompress_error;
            return err;
        };
        const archive = try output.toOwnedSlice();
        errdefer allocator.free(archive);
        var reader: std.Io.Reader = .fixed(archive);
        var name_buffer: [std.Io.Dir.max_path_bytes]u8 = undefined;
        var link_buffer: [std.Io.Dir.max_path_bytes]u8 = undefined;
        var iterator: std.tar.Iterator = .init(&reader, .{
            .file_name_buffer = &name_buffer,
            .link_name_buffer = &link_buffer,
        });
        var files: std.StringHashMapUnmanaged(Asset) = .empty;
        errdefer {
            var key_iterator = files.keyIterator();
            while (key_iterator.next()) |key| allocator.free(key.*);
            files.deinit(allocator);
        }
        while (try iterator.next()) |file| {
            if (file.kind != .file) continue;
            var name = file.name;
            if (std.mem.startsWith(u8, name, "./")) name = name[2..];
            if (!validPath(name)) return error.InvalidAssetPath;
            const size = std.math.cast(usize, file.size) orelse return error.AssetTooLarge;
            const end = std.math.add(usize, reader.seek, size) catch return error.InvalidTar;
            if (end > archive.len) return error.InvalidTar;
            if (files.contains(name)) return error.DuplicateAsset;
            const owned_name = try allocator.dupe(u8, name);
            errdefer allocator.free(owned_name);
            const data = archive[reader.seek..end];
            try files.put(allocator, owned_name, .{
                .data = data,
                .etag = contentEtag(data),
            });
        }
        if (files.count() == 0) return error.EmptyVfs;
        return .{ .archive = archive, .files = files };
    }

    pub fn get(self: *const Vfs, path: []const u8) ?Asset {
        return self.files.get(path);
    }

    pub fn count(self: *const Vfs) usize {
        return self.files.count();
    }

    pub fn deinit(self: *Vfs, allocator: std.mem.Allocator) void {
        var key_iterator = self.files.keyIterator();
        while (key_iterator.next()) |key| allocator.free(key.*);
        self.files.deinit(allocator);
        allocator.free(self.archive);
        self.* = undefined;
    }

    pub fn validPath(path: []const u8) bool {
        if (path.len == 0 or path[0] == '/' or path[path.len - 1] == '/') return false;
        var components = std.mem.splitScalar(u8, path, '/');
        while (components.next()) |component| {
            if (component.len == 0 or std.mem.eql(u8, component, ".") or std.mem.eql(u8, component, "..")) return false;
            if (std.mem.indexOfScalar(u8, component, '\\') != null) return false;
        }
        return true;
    }
};

test "valid asset paths" {
    try std.testing.expect(Vfs.validPath("index.html"));
    try std.testing.expect(Vfs.validPath("fonts/font.woff2"));
    try std.testing.expect(!Vfs.validPath(""));
    try std.testing.expect(!Vfs.validPath("/index.html"));
    try std.testing.expect(!Vfs.validPath("assets/"));
    try std.testing.expect(!Vfs.validPath("assets//index.html"));
    try std.testing.expect(!Vfs.validPath("."));
    try std.testing.expect(!Vfs.validPath("assets/./index.html"));
    try std.testing.expect(!Vfs.validPath(".."));
    try std.testing.expect(!Vfs.validPath("assets/../index.html"));
    try std.testing.expect(!Vfs.validPath("assets\\index.html"));
}

test "Vfs owns archive and cleans up duplicate assets" {
    var tar_buffer: [4096]u8 = undefined;
    var tar_output: std.Io.Writer = .fixed(&tar_buffer);
    var tar: std.tar.Writer = .{ .underlying_writer = &tar_output };
    try tar.writeFileBytes("index.html", "hello", .{});

    var frame_buffer: [8192]u8 = undefined;
    var frame: std.Io.Writer = .fixed(&frame_buffer);
    // Single raw-block Zstandard frame keeps this ownership test independent of libzstd.
    try frame.writeAll("\x28\xb5\x2f\xfd\xa0");
    try frame.writeInt(u32, @intCast(tar_output.buffered().len), .little);
    try frame.writeInt(u24, @intCast((tar_output.buffered().len << 3) | 1), .little);
    try frame.writeAll(tar_output.buffered());
    var assets = try Vfs.init(std.testing.allocator, frame.buffered());
    defer assets.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("hello", assets.get("index.html").?.data);

    try tar.writeFileBytes("index.html", "duplicate", .{});
    frame = .fixed(&frame_buffer);
    try frame.writeAll("\x28\xb5\x2f\xfd\xa0");
    try frame.writeInt(u32, @intCast(tar_output.buffered().len), .little);
    try frame.writeInt(u24, @intCast((tar_output.buffered().len << 3) | 1), .little);
    try frame.writeAll(tar_output.buffered());
    try std.testing.expectError(error.DuplicateAsset, Vfs.init(std.testing.allocator, frame.buffered()));
}
