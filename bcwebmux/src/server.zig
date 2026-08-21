// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");
const vfs = @import("vfs.zig");
const SessionRegistry = @import("SessionRegistry.zig");
const SessionSocket = @import("SessionSocket.zig");
const session_api = @import("session_api.zig");
const session_manifest = @import("session_manifest.zig");
const session_worker = @import("session_worker.zig");
const embedded_assets = @import("web_assets").data;
const c = @cImport({
    @cInclude("stdlib.h");
});

const App = struct {
    io: std.Io,
    assets: vfs.Vfs,
    asset_dir: ?std.Io.Dir,
    origin: []const u8,
    registry: *SessionRegistry,
};

const Config = struct {
    host: []const u8 = "127.0.0.1",
    port: u16 = 8080,
    web_root: ?[]const u8 = null,
    shell: ?[:0]const u8 = null,
    origin: ?[]const u8 = null,
    max_sessions: usize = 16,
};

pub fn main(init: std.process.Init) !void {
    const arena = init.arena.allocator();
    const args = try init.minimal.args.toSlice(arena);
    if (args.len == 5 and std.mem.eql(u8, args[1], "--session-worker")) {
        const cols = std.fmt.parseInt(u16, args[3], 10) catch return error.InvalidArgument;
        const rows = std.fmt.parseInt(u16, args[4], 10) catch return error.InvalidArgument;
        if (cols == 0 or rows == 0) return error.InvalidArgument;
        try session_worker.run(args[2], cols, rows, .{});
        return;
    }
    if (args.len == 2 and std.mem.eql(u8, args[1], "--help")) {
        std.debug.print(
            "usage: {s} [options]\n" ++
                "  --host HOST\n" ++
                "  --port PORT\n" ++
                "  --web-root DIR\n" ++
                "  --shell SHELL\n" ++
                "  --origin ORIGIN\n" ++
                "  --max-sessions N\n",
            .{args[0]},
        );
        return;
    }
    const config = try parseArgs(args);
    const shell = config.shell orelse defaultShell();
    var origin_buffer: [512]u8 = undefined;
    const origin = config.origin orelse try std.fmt.bufPrint(&origin_buffer, "http://{s}:{d}", .{ config.host, config.port });
    const limits: session_manifest.Limits = .{ .max_live_sessions = config.max_sessions };
    var registry = try SessionRegistry.init(std.heap.smp_allocator, init.io, args[0], shell, limits);
    defer registry.deinit();
    const assets = try vfs.Vfs.init(arena, embedded_assets);
    const asset_dir = if (config.web_root) |web_root|
        try std.Io.Dir.cwd().openDir(init.io, web_root, .{})
    else
        null;
    defer if (asset_dir) |dir| dir.close(init.io);
    var app = App{
        .io = init.io,
        .assets = assets,
        .asset_dir = asset_dir,
        .origin = origin,
        .registry = &registry,
    };
    const address = try std.Io.net.IpAddress.parse(config.host, config.port);
    var listener = try address.listen(init.io, .{ .reuse_address = true });
    defer listener.deinit(init.io);
    std.debug.print("listening http://{s}:{d} ({d} embedded assets)\n", .{ config.host, config.port, assets.count() });

    var group: std.Io.Group = .init;
    defer group.cancel(init.io);
    while (true) {
        const stream = listener.accept(init.io) catch |err| {
            std.log.err("accept failed: {t}", .{err});
            continue;
        };
        group.concurrent(init.io, handleConnection, .{ &app, stream }) catch |err| {
            std.log.err("connection task failed: {t}", .{err});
            stream.close(init.io);
        };
    }
}

fn parseArgs(args: []const [:0]const u8) !Config {
    var config: Config = .{};
    var i: usize = 1;
    while (i < args.len) : (i += 1) {
        const arg = args[i];
        if (std.mem.eql(u8, arg, "--host")) {
            i += 1;
            if (i >= args.len) return error.MissingArgument;
            config.host = args[i];
        } else if (std.mem.eql(u8, arg, "--port")) {
            i += 1;
            if (i >= args.len) return error.MissingArgument;
            config.port = try std.fmt.parseInt(u16, args[i], 10);
        } else if (std.mem.eql(u8, arg, "--web-root")) {
            i += 1;
            if (i >= args.len) return error.MissingArgument;
            config.web_root = args[i];
        } else if (std.mem.eql(u8, arg, "--shell")) {
            i += 1;
            if (i >= args.len) return error.MissingArgument;
            config.shell = args[i];
        } else if (std.mem.eql(u8, arg, "--origin")) {
            i += 1;
            if (i >= args.len) return error.MissingArgument;
            config.origin = args[i];
        } else if (std.mem.eql(u8, arg, "--max-sessions")) {
            i += 1;
            if (i >= args.len) return error.MissingArgument;
            config.max_sessions = try std.fmt.parseInt(usize, args[i], 10);
            if (config.max_sessions == 0) return error.InvalidArgument;
        } else {
            return error.UnknownArgument;
        }
    }
    return config;
}

fn defaultShell() [:0]const u8 {
    const value = c.getenv("SHELL") orelse return "/bin/sh";
    return std.mem.span(value);
}

fn handleConnection(app: *App, stream: std.Io.net.Stream) void {
    defer stream.close(app.io);
    var tcp_nodelay: c_int = 1;
    std.posix.setsockopt(stream.socket.handle, std.posix.IPPROTO.TCP, std.posix.TCP.NODELAY, std.mem.asBytes(&tcp_nodelay)) catch |err| {
        std.log.warn("failed to enable TCP_NODELAY: {t}", .{err});
    };
    var send_buffer: [64 * 1024]u8 = undefined;
    var recv_buffer: [128 * 1024]u8 = undefined;
    var reader = stream.reader(app.io, &recv_buffer);
    var writer = stream.writer(app.io, &send_buffer);
    var server: std.http.Server = .init(&reader.interface, &writer.interface);

    while (true) {
        var request = server.receiveHead() catch return;
        switch (request.upgradeRequested()) {
            .websocket => |key_opt| {
                if (!std.mem.eql(u8, request.head.target, "/ws")) {
                    std.log.warn("invalid websocket target", .{});
                    return;
                }
                if (!validWebSocketOrigin(&request, app.origin)) {
                    std.log.warn("invalid websocket origin", .{});
                    request.respond("forbidden", .{ .status = .forbidden }) catch return;
                    return;
                }
                if (!validWebSocketProtocol(&request)) {
                    std.log.warn("invalid websocket subprotocol", .{});
                    request.respond("bad request", .{ .status = .bad_request }) catch return;
                    return;
                }
                const key = key_opt orelse return;
                const protocol_headers = [_]std.http.Header{
                    .{ .name = "Sec-WebSocket-Protocol", .value = session_manifest.protocol },
                };
                var websocket = request.respondWebSocket(.{
                    .key = key,
                    .extra_headers = &protocol_headers,
                }) catch return;
                websocket.flush() catch return;
                var socket = SessionSocket.init(std.heap.smp_allocator, app.io, app.registry, &websocket) catch |err| {
                    std.log.info("session socket ended: {t}", .{err});
                    return;
                };
                socket.serve() catch |err| {
                    std.log.info("session socket ended: {t}", .{err});
                };
                return;
            },
            .other => return,
            .none => {
                if (session_api.serve(app.registry, app.origin, &request) catch return) continue;
                serveAsset(app, &request) catch return;
            },
        }
    }
}

fn validWebSocketOrigin(request: *std.http.Server.Request, expected_origin: []const u8) bool {
    var headers = request.iterateHeaders();
    while (headers.next()) |header| {
        if (std.ascii.eqlIgnoreCase(header.name, "Origin")) {
            return std.mem.eql(u8, header.value, expected_origin);
        }
    }
    return false;
}

fn validWebSocketProtocol(request: *std.http.Server.Request) bool {
    var headers = request.iterateHeaders();
    while (headers.next()) |header| {
        if (!std.ascii.eqlIgnoreCase(header.name, "Sec-WebSocket-Protocol")) continue;
        var tokens = std.mem.splitScalar(u8, header.value, ',');
        while (tokens.next()) |token| {
            if (std.mem.eql(u8, std.mem.trim(u8, token, " \t"), session_manifest.protocol))
                return true;
        }
    }
    return false;
}

fn serveAsset(app: *const App, request: *std.http.Server.Request) !void {
    if (request.head.method != .GET and request.head.method != .HEAD) {
        return request.respond("method not allowed", .{ .status = .method_not_allowed });
    }
    const target = request.head.target[0 .. std.mem.indexOfScalar(u8, request.head.target, '?') orelse request.head.target.len];
    const path = if (std.mem.eql(u8, target, "/"))
        "index.html"
    else blk: {
        if (target.len == 0 or target[0] != '/' or !vfs.Vfs.validPath(target[1..]))
            return request.respond("not found", .{ .status = .not_found });
        break :blk target[1..];
    };
    const content_type = contentType(path);
    if (app.asset_dir) |asset_dir| {
        const file = asset_dir.openFile(app.io, path, .{}) catch |err| switch (err) {
            error.FileNotFound => null,
            else => return err,
        };
        if (file) |disk_file| return serveDiskAsset(app, request, disk_file, content_type);
    }
    const asset = app.assets.get(path) orelse return request.respond("not found", .{ .status = .not_found });
    const headers = assetHeaders(content_type, &asset.etag);
    if (ifNoneMatch(request, &asset.etag))
        return request.respond("", .{ .status = .not_modified, .extra_headers = &headers });
    return request.respond(asset.data, .{ .extra_headers = &headers });
}

fn serveDiskAsset(app: *const App, request: *std.http.Server.Request, file: std.Io.File, content_type: []const u8) !void {
    defer file.close(app.io);
    const stat = try file.stat(app.io);
    if (stat.size > 16 * 1024 * 1024) return error.AssetTooLarge;
    const size: usize = @intCast(stat.size);
    const etag = try diskAssetEtag(file, app.io, stat.size);
    var response_buffer: [16 * 1024]u8 = undefined;
    const headers = assetHeaders(content_type, &etag);
    if (ifNoneMatch(request, &etag))
        return request.respond("", .{ .status = .not_modified, .extra_headers = &headers });
    var response = try request.respondStreaming(&response_buffer, .{
        .content_length = stat.size,
        .respond_options = .{ .extra_headers = &headers },
    });
    if (request.head.method == .HEAD) return response.end();
    var read_buffer: [16 * 1024]u8 = undefined;
    var file_reader = std.Io.File.Reader.initSize(file, app.io, &read_buffer, stat.size);
    const sent = try response.writer.sendFileAll(&file_reader, .limited(size));
    if (sent != size) return error.UnexpectedEndOfStream;
    try response.end();
}

fn diskAssetEtag(file: std.Io.File, io: std.Io, size: u64) ![66]u8 {
    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    var buffer: [16 * 1024]u8 = undefined;
    var offset: u64 = 0;
    while (offset < size) {
        const length: usize = @intCast(@min(size - offset, @as(u64, buffer.len)));
        const iovec = [_][]u8{buffer[0..length]};
        const count = try file.readPositional(io, &iovec, offset);
        if (count == 0) return error.UnexpectedEndOfStream;
        hasher.update(buffer[0..count]);
        offset += count;
    }
    var digest: [32]u8 = undefined;
    hasher.final(&digest);
    return vfs.digestEtag(digest);
}

fn ifNoneMatch(request: *std.http.Server.Request, etag: []const u8) bool {
    var headers = request.iterateHeaders();
    while (headers.next()) |header| {
        if (!std.ascii.eqlIgnoreCase(header.name, "If-None-Match")) continue;
        var validators = std.mem.splitScalar(u8, header.value, ',');
        while (validators.next()) |validator| {
            const value = std.mem.trim(u8, validator, " \t");
            if (std.mem.eql(u8, value, "*")) return true;
            const candidate = if (std.mem.startsWith(u8, value, "W/")) value[2..] else value;
            if (std.mem.eql(u8, candidate, etag)) return true;
        }
    }
    return false;
}

fn assetHeaders(content_type: []const u8, etag: []const u8) [5]std.http.Header {
    return .{
        .{ .name = "Content-Type", .value = content_type },
        .{ .name = "Cache-Control", .value = "public, no-cache, must-revalidate" },
        .{ .name = "ETag", .value = etag },
        .{ .name = "Content-Security-Policy", .value = "default-src 'self'; connect-src 'self' ws: wss:; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com" },
        .{ .name = "X-Content-Type-Options", .value = "nosniff" },
    };
}

const mime_types = std.StaticStringMap([]const u8).initComptime(.{
    .{ ".html", "text/html; charset=utf-8" },
    .{ ".js", "text/javascript; charset=utf-8" },
    .{ ".css", "text/css; charset=utf-8" },
    .{ ".webmanifest", "application/manifest+json" },
    .{ ".svg", "image/svg+xml" },
    .{ ".png", "image/png" },
    .{ ".wasm", "application/wasm" },
    .{ ".woff2", "font/woff2" },
    .{ ".txt", "text/plain; charset=utf-8" },
});

fn contentType(path: []const u8) []const u8 {
    return mime_types.get(std.fs.path.extension(path)) orelse "application/octet-stream";
}
