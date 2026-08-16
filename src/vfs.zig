const std = @import("std");

pub const Vfs = struct {
    archive: []const u8,
    files: std.StringHashMapUnmanaged([]const u8),

    pub fn init(allocator: std.mem.Allocator, compressed: []const u8) !Vfs {
        var input: std.Io.Reader = .fixed(compressed);
        var output: std.Io.Writer.Allocating = .init(allocator);
        defer output.deinit();
        var decompressor: std.compress.zstd.Decompress = .init(&input, &.{}, .{});
        _ = decompressor.reader.streamRemaining(&output.writer) catch |err| {
            if (decompressor.err) |decompress_error| return decompressionError(decompress_error);
            return err;
        };
        const archive = try output.toOwnedSlice();
        var reader: std.Io.Reader = .fixed(archive);
        var name_buffer: [std.fs.max_path_bytes]u8 = undefined;
        var link_buffer: [std.fs.max_path_bytes]u8 = undefined;
        var iterator: std.tar.Iterator = .init(&reader, .{
            .file_name_buffer = &name_buffer,
            .link_name_buffer = &link_buffer,
        });
        var files: std.StringHashMapUnmanaged([]const u8) = .empty;
        errdefer files.deinit(allocator);
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
            try files.put(allocator, owned_name, archive[reader.seek..end]);
        }
        if (files.count() == 0) return error.EmptyVfs;
        return .{ .archive = archive, .files = files };
    }

    pub fn get(self: *const Vfs, path: []const u8) ?[]const u8 {
        return self.files.get(path);
    }

    pub fn count(self: *const Vfs) usize {
        return self.files.count();
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

fn decompressionError(err: std.compress.zstd.Decompress.Error) anyerror {
    return err;
}

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
