// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");
const protocol = @import("protocol.zig");
const vfs = @import("vfs.zig");
const embedded_assets = @import("web_assets").data;
const c = @cImport({
    @cDefine("_XOPEN_SOURCE", "600");
    @cInclude("pty.h");
    @cInclude("signal.h");
    @cInclude("stdlib.h");
    @cInclude("sys/ioctl.h");
    @cInclude("sys/wait.h");
    @cInclude("unistd.h");
    @cInclude("zstd.h");
});

const App = struct {
    io: std.Io,
    assets: vfs.Vfs,
    asset_dir: ?std.Io.Dir,
    shell: [:0]const u8,
    origin: []const u8,
};

const Config = struct {
    host: []const u8 = "127.0.0.1",
    port: u16 = 8080,
    web_root: ?[]const u8 = null,
    shell: ?[:0]const u8 = null,
    origin: ?[]const u8 = null,
};

pub fn main(init: std.process.Init) !void {
    const arena = init.arena.allocator();
    const args = try init.minimal.args.toSlice(arena);
    const config = try parseArgs(args);
    const shell = config.shell orelse defaultShell();
    var origin_buffer: [512]u8 = undefined;
    const origin = config.origin orelse try std.fmt.bufPrint(&origin_buffer, "http://{s}:{d}", .{ config.host, config.port });
    const assets = try vfs.Vfs.init(arena, embedded_assets);
    const asset_dir = if (config.web_root) |web_root|
        try std.Io.Dir.cwd().openDir(init.io, web_root, .{})
    else
        null;
    defer if (asset_dir) |dir| dir.close(init.io);
    const app = App{
        .io = init.io,
        .assets = assets,
        .asset_dir = asset_dir,
        .shell = shell,
        .origin = origin,
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

fn handleConnection(app: *const App, stream: std.Io.net.Stream) void {
    defer stream.close(app.io);
    var tcp_nodelay: c_int = 1;
    std.posix.setsockopt(stream.socket.handle, std.posix.IPPROTO.TCP, std.posix.TCP.NODELAY, std.mem.asBytes(&tcp_nodelay)) catch |err| {
        std.log.warn("failed to enable TCP_NODELAY: {t}", .{err});
    };
    var send_buffer: [64 * 1024]u8 = undefined;
    var recv_buffer: [64 * 1024]u8 = undefined;
    var reader = stream.reader(app.io, &recv_buffer);
    var writer = stream.writer(app.io, &send_buffer);
    var server: std.http.Server = .init(&reader.interface, &writer.interface);

    while (true) {
        var request = server.receiveHead() catch return;
        switch (request.upgradeRequested()) {
            .websocket => |key_opt| {
                if (!std.mem.eql(u8, request.head.target, "/ws")) return;
                if (!validWebSocketOrigin(&request, app.origin)) {
                    request.respond("forbidden", .{ .status = .forbidden }) catch return;
                    return;
                }
                if (!validWebSocketProtocol(&request)) {
                    request.respond("bad request", .{ .status = .bad_request }) catch return;
                    return;
                }
                const key = key_opt orelse return;
                const protocol_headers = [_]std.http.Header{
                    .{ .name = "Sec-WebSocket-Protocol", .value = "bcw.zstd.v1" },
                };
                var websocket = request.respondWebSocket(.{
                    .key = key,
                    .extra_headers = &protocol_headers,
                }) catch return;
                serveTerminal(app, &websocket) catch |err| {
                    std.log.info("terminal session ended: {t}", .{err});
                };
                return;
            },
            .other => return,
            .none => serveAsset(app, &request) catch return,
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
            if (std.mem.eql(u8, std.mem.trim(u8, token, " \t"), "bcw.zstd.v1"))
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
    const data = app.assets.get(path) orelse return request.respond("not found", .{ .status = .not_found });
    const headers = assetHeaders(content_type);
    return request.respond(data, .{ .extra_headers = &headers });
}

fn serveDiskAsset(app: *const App, request: *std.http.Server.Request, file: std.Io.File, content_type: []const u8) !void {
    defer file.close(app.io);
    const stat = try file.stat(app.io);
    if (stat.size > 16 * 1024 * 1024) return error.AssetTooLarge;
    const size: usize = @intCast(stat.size);
    var response_buffer: [16 * 1024]u8 = undefined;
    const headers = assetHeaders(content_type);
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

fn assetHeaders(content_type: []const u8) [4]std.http.Header {
    return .{
        .{ .name = "Content-Type", .value = content_type },
        .{ .name = "Cache-Control", .value = "no-store" },
        .{ .name = "Content-Security-Policy", .value = "default-src 'self'; connect-src 'self' ws: wss:; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'" },
        .{ .name = "X-Content-Type-Options", .value = "nosniff" },
    };
}

const mime_types = std.StaticStringMap([]const u8).initComptime(.{
    .{ ".html", "text/html; charset=utf-8" },
    .{ ".js", "text/javascript; charset=utf-8" },
    .{ ".css", "text/css; charset=utf-8" },
    .{ ".wasm", "application/wasm" },
    .{ ".woff2", "font/woff2" },
    .{ ".txt", "text/plain; charset=utf-8" },
});

fn contentType(path: []const u8) []const u8 {
    return mime_types.get(std.fs.path.extension(path)) orelse "application/octet-stream";
}

const PtySession = struct {
    master: std.posix.fd_t,
    pid: c.pid_t,
    mutex: std.Io.Mutex = .init,
    stopped: std.atomic.Value(bool) = .init(false),

    fn send(self: *PtySession, io: std.Io, websocket: *std.http.Server.WebSocket, data: []const u8, opcode: std.http.Server.WebSocket.Opcode) !void {
        try self.mutex.lock(io);
        defer self.mutex.unlock(io);
        try websocket.writeMessage(data, opcode);
    }

    fn stop(self: *PtySession) void {
        if (self.stopped.swap(true, .acq_rel)) return;
        _ = c.kill(-self.pid, c.SIGHUP);
        _ = c.close(self.master);
    }

    fn reap(self: *PtySession) void {
        self.stop();
        var status: c_int = 0;
        _ = c.waitpid(self.pid, &status, 0);
    }

    fn resize(self: *PtySession, cols: u16, rows: u16) void {
        if (cols == 0 or rows == 0 or self.stopped.load(.acquire)) return;
        var size: c.struct_winsize = std.mem.zeroes(c.struct_winsize);
        size.ws_col = cols;
        size.ws_row = rows;
        _ = c.ioctl(self.master, c.TIOCSWINSZ, &size);
    }
};

const ZstdOutputStream = struct {
    context: *c.ZSTD_CCtx,
    output_buffer: [64 * 1024]u8 = undefined,

    fn init() !ZstdOutputStream {
        const context = c.ZSTD_createCCtx() orelse return error.ZstdInitializationFailed;
        errdefer _ = c.ZSTD_freeCCtx(context);
        if (c.ZSTD_isError(c.ZSTD_CCtx_setParameter(context, c.ZSTD_c_compressionLevel, 1)) != 0)
            return error.ZstdInitializationFailed;
        if (c.ZSTD_isError(c.ZSTD_CCtx_setParameter(context, c.ZSTD_c_windowLog, 17)) != 0)
            return error.ZstdInitializationFailed;
        if (c.ZSTD_isError(c.ZSTD_CCtx_setParameter(context, c.ZSTD_c_checksumFlag, 0)) != 0)
            return error.ZstdInitializationFailed;
        return .{ .context = context };
    }

    fn deinit(self: *ZstdOutputStream) void {
        _ = c.ZSTD_freeCCtx(self.context);
    }

    fn send(self: *ZstdOutputStream, io: std.Io, session: *PtySession, websocket: *std.http.Server.WebSocket, data: []const u8) !void {
        var input = c.ZSTD_inBuffer{
            .src = @ptrCast(data.ptr),
            .size = data.len,
            .pos = 0,
        };
        while (input.pos < input.size) {
            var output = c.ZSTD_outBuffer{
                .dst = @ptrCast(self.output_buffer[0..].ptr),
                .size = self.output_buffer.len,
                .pos = 0,
            };
            const result = c.ZSTD_compressStream2(self.context, &output, &input, c.ZSTD_e_continue);
            if (c.ZSTD_isError(result) != 0) return error.ZstdCompressionFailed;
            if (output.pos > 0)
                try session.send(io, websocket, self.output_buffer[0..output.pos], .binary);
        }

        var flush_input = c.ZSTD_inBuffer{
            .src = @ptrCast(data.ptr),
            .size = 0,
            .pos = 0,
        };
        while (true) {
            var output = c.ZSTD_outBuffer{
                .dst = @ptrCast(self.output_buffer[0..].ptr),
                .size = self.output_buffer.len,
                .pos = 0,
            };
            const result = c.ZSTD_compressStream2(self.context, &output, &flush_input, c.ZSTD_e_flush);
            if (c.ZSTD_isError(result) != 0) return error.ZstdCompressionFailed;
            if (output.pos > 0)
                try session.send(io, websocket, self.output_buffer[0..output.pos], .binary);
            if (result == 0) break;
        }
    }
};

fn spawnPty(shell: [:0]const u8) !PtySession {
    var master: c_int = -1;
    var size: c.struct_winsize = std.mem.zeroes(c.struct_winsize);
    size.ws_col = 80;
    size.ws_row = 24;
    const pid = c.forkpty(&master, null, null, &size);
    if (pid < 0) return error.ForkPtyFailed;
    if (pid == 0) {
        _ = c.setenv("TERM", "xterm-256color", 1);
        _ = c.setenv("COLORTERM", "truecolor", 1);
        var argv = [_:null]?[*:0]const u8{ shell.ptr, "-l" };
        _ = c.execvp(shell.ptr, @ptrCast(&argv));
        c._exit(127);
    }
    return .{ .master = master, .pid = pid };
}

fn serveTerminal(app: *const App, websocket: *std.http.Server.WebSocket) !void {
    var session = try spawnPty(app.shell);
    defer session.reap();
    var compressor = try ZstdOutputStream.init();
    defer compressor.deinit();
    var receiver = try app.io.concurrent(receiveClient, .{ websocket, &session, app.io });
    defer receiver.cancel(app.io);

    var buffer: [32 * 1024]u8 = undefined;
    while (!session.stopped.load(.acquire)) {
        const count = c.read(session.master, &buffer, buffer.len);
        if (count <= 0) break;
        const count_usize: usize = @intCast(count);
        try compressor.send(app.io, &session, websocket, buffer[0..count_usize]);
    }
}

fn receiveClient(websocket: *std.http.Server.WebSocket, session: *PtySession, io: std.Io) void {
    defer session.stop();
    while (true) {
        const message = websocket.readSmallMessage() catch return;
        switch (message.opcode) {
            .ping => session.send(io, websocket, message.data, .pong) catch return,
            .pong => {},
            .binary => {
                if (message.data.len == @sizeOf(protocol.Resize)) {
                    var resize: protocol.Resize = undefined;
                    @memcpy(std.mem.asBytes(&resize), message.data);
                    if (resize.magic == protocol.resize_magic and resize.reserved == 0) {
                        session.resize(resize.cols, resize.rows);
                        continue;
                    }
                }
                writePty(session, message.data);
            },
            .text => {
                if (message.data.len <= 64 and std.mem.startsWith(u8, message.data, "BCWP:"))
                    session.send(io, websocket, message.data, .text) catch return;
            },
            else => {},
        }
    }
}

fn writePty(session: *PtySession, data: []const u8) void {
    var remaining = data;
    while (remaining.len > 0 and !session.stopped.load(.acquire)) {
        const count = c.write(session.master, remaining.ptr, remaining.len);
        if (count <= 0) return;
        const count_usize: usize = @intCast(count);
        remaining = remaining[count_usize..];
    }
}
