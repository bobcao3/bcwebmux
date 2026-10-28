// SPDX-License-Identifier: MIT
const std = @import("std");
const api = @import("c_api.zig");
const c = @import("bcwebmux-c");
const posix = @import("posix-c");
const allocator = std.heap.c_allocator;
const max_frame = 1_048_640;
const max_clients = 128;
var listener_fd: std.atomic.Value(i32) = .init(-1);
var stopping: std.atomic.Value(bool) = .init(false);

fn signalHandler(_: std.posix.SIG) callconv(.c) void {
    stopping.store(true, .release);
    const fd = listener_fd.load(.acquire);
    if (fd >= 0) _ = std.os.linux.shutdown(fd, 2);
}

const State = struct {
    io: std.Io,
    engine: *api.Engine,
    mutex: std.Io.Mutex = .init,
    clients: std.atomic.Value(u32) = .init(0),
};

fn readExact(stream: std.Io.net.Stream, io: std.Io, dest: []u8) !void {
    var off: usize = 0;
    while (off < dest.len) {
        var chunks = [_][]u8{dest[off..]};
        const n = (try stream.readWithControl(io, &chunks, &.{})).data_len;
        if (n == 0) return error.EndOfStream;
        off += n;
    }
}

fn reply(stream: std.Io.net.Stream, io: std.Io, status: c.bcwebmux_status, payload: []const u8) !void {
    if (payload.len > max_frame) return error.FrameTooLarge;
    var header: [8]u8 = undefined;
    std.mem.writeInt(u32, header[0..4], @intCast(status), .big);
    std.mem.writeInt(u32, header[4..8], @intCast(payload.len), .big);
    var buf: [4096]u8 = undefined;
    var writer = stream.writer(io, &buf);
    try writer.interface.writeAll(&header);
    try writer.interface.writeAll(payload);
    try writer.interface.flush();
}

fn parseFields(payload: []const u8) ![6][]const u8 {
    var fields: [6][]const u8 = undefined;
    var offset: usize = 0;
    for (&fields) |*field| {
        if (payload.len - offset < 4) return error.InvalidFrame;
        const len = std.mem.readInt(u32, payload[offset..][0..4], .big);
        offset += 4;
        if (len > payload.len - offset) return error.InvalidFrame;
        field.* = payload[offset..][0..len];
        offset += len;
    }
    if (offset != payload.len) return error.InvalidFrame;
    return fields;
}

fn appendField(buffer: []u8, offset: *usize, bytes: []const u8) void {
    std.mem.writeInt(u32, buffer[offset.*..][0..4], @intCast(bytes.len), .big);
    offset.* += 4;
    @memcpy(buffer[offset.*..][0..bytes.len], bytes);
    offset.* += bytes.len;
}

fn rest(state: *State, stream: std.Io.net.Stream, payload: []const u8) !void {
    const f = try parseFields(payload);
    const request = c.bcwebmux_http_request_input{
        .method = f[0].ptr,
        .method_len = f[0].len,
        .target = f[1].ptr,
        .target_len = f[1].len,
        .origin = f[2].ptr,
        .origin_len = f[2].len,
        .content_type = f[3].ptr,
        .content_type_len = f[3].len,
        .idempotency_key = f[4].ptr,
        .idempotency_key_len = f[4].len,
        .body = f[5].ptr,
        .body_len = f[5].len,
    };
    var response: c.bcwebmux_http_response = undefined;
    try state.mutex.lock(state.io);
    const status = api.bcwebmux_http_request(state.engine, &request, &response);
    state.mutex.unlock(state.io);
    defer api.bcwebmux_http_response_free(&response);
    if (status != c.BCWMUX_OK) return reply(stream, state.io, status, "");
    const length = std.math.add(usize, 15, response.content_type_len) catch return error.FrameTooLarge;
    const length2 = std.math.add(usize, length, response.location_len) catch return error.FrameTooLarge;
    const total = std.math.add(usize, length2, response.body_len) catch return error.FrameTooLarge;
    if (total > max_frame) return reply(stream, state.io, c.BCWMUX_TOO_LARGE, "");
    const out = try allocator.alloc(u8, total);
    defer allocator.free(out);
    std.mem.writeInt(u16, out[0..2], response.status, .big);
    out[2] = response.replayed;
    var off: usize = 3;
    appendField(out, &off, if (response.content_type_len == 0) "" else @as([*]const u8, @ptrCast(response.content_type))[0..response.content_type_len]);
    appendField(out, &off, if (response.location_len == 0) "" else @as([*]const u8, @ptrCast(response.location))[0..response.location_len]);
    appendField(out, &off, if (response.body_len == 0) "" else response.body[0..response.body_len]);
    try reply(stream, state.io, status, out);
}

fn client(state: *State, stream: std.Io.net.Stream) std.Io.Cancelable!void {
    defer stream.close(state.io);
    defer _ = state.clients.fetchSub(1, .acq_rel);
    var socket: ?*api.Socket = null;
    var opened = false;
    defer if (socket) |s| {
        state.mutex.lockUncancelable(state.io);
        _ = api.bcwebmux_socket_close(s);
        state.mutex.unlock(state.io);
    };
    while (true) {
        var header: [5]u8 = undefined;
        readExact(stream, state.io, &header) catch return;
        const len = std.mem.readInt(u32, header[1..5], .big);
        if (len > max_frame) return;
        const data = allocator.alloc(u8, len) catch return;
        defer allocator.free(data);
        readExact(stream, state.io, data) catch return;
        const op = header[0];
        if (op == 1) {
            if (opened) return;
            rest(state, stream, data) catch return;
            continue;
        }
        if (op < 2 or op > 6 or (op != 3 and len != 0)) return;
        if (op == 2) {
            if (opened) return;
            opened = true;
            state.mutex.lock(state.io) catch return;
            var status = api.bcwebmux_socket_open(state.engine, null, &socket);
            if (status == c.BCWMUX_OK) {
                status = api.bcwebmux_socket_set_transport_managed(socket, 1);
                if (status != c.BCWMUX_OK) {
                    _ = api.bcwebmux_socket_close(socket);
                    socket = null;
                }
            }
            state.mutex.unlock(state.io);
            reply(stream, state.io, status, "") catch return;
            continue;
        }
        const s = socket orelse return;
        state.mutex.lock(state.io) catch return;
        var message: c.bcwebmux_message = std.mem.zeroes(c.bcwebmux_message);
        const status = switch (op) {
            3 => api.bcwebmux_socket_receive_binary(s, data.ptr, data.len),
            4 => api.bcwebmux_socket_tick(s),
            5 => api.bcwebmux_socket_drain(s, &message),
            6 => blk: {
                socket = null;
                break :blk api.bcwebmux_socket_close(s);
            },
            else => unreachable,
        };
        state.mutex.unlock(state.io);
        const bytes: []const u8 = if (message.len == 0) "" else message.data[0..message.len];
        reply(stream, state.io, status, bytes) catch {
            api.bcwebmux_message_free(&message);
            return;
        };
        api.bcwebmux_message_free(&message);
        if (op == 6) return;
    }
}

fn statPath(path: [:0]const u8, follow: bool, st: *std.os.linux.Statx) std.posix.E {
    const result = std.os.linux.statx(std.os.linux.AT.FDCWD, path, if (follow) 0 else std.os.linux.AT.SYMLINK_NOFOLLOW, .BASIC_STATS, st);
    const status = std.os.linux.errno(result);
    if (status != .SUCCESS) return status;
    if (!st.mask.TYPE or !st.mask.MODE or !st.mask.UID or !st.mask.INO) return .OPNOTSUPP;
    return .SUCCESS;
}

fn checkedParent(path: []const u8) !void {
    const dir = std.fs.path.dirname(path) orelse ".";
    const zdir = try allocator.dupeSentinel(u8, dir, 0);
    defer allocator.free(zdir);
    var st: std.os.linux.Statx = undefined;
    if (statPath(zdir, true, &st) != .SUCCESS or (st.mode & posix.S_IFMT) != posix.S_IFDIR or st.uid != posix.geteuid() or (st.mode & 0o022) != 0) return error.InsecureSocketDirectory;
}

fn sameSocket(path: [:0]const u8, original: std.os.linux.Statx) bool {
    var st: std.os.linux.Statx = undefined;
    return statPath(path, false, &st) == .SUCCESS and (st.mode & posix.S_IFMT) == posix.S_IFSOCK and st.dev_major == original.dev_major and st.dev_minor == original.dev_minor and st.ino == original.ino;
}

pub fn main(init: std.process.Init) !void {
    const args = try init.minimal.args.toSlice(init.arena.allocator());
    const a = init.arena.allocator();
    var socket_path: ?[]const u8 = null;
    var shell: []const u8 = init.environ_map.get("SHELL") orelse "/bin/sh";
    if (shell.len == 0) shell = "/bin/sh";
    const executable = try std.process.executablePathAlloc(init.io, a);
    var worker: []const u8 = try std.fs.path.join(a, &.{ std.fs.path.dirname(executable) orelse ".", "bcwebmux-worker" });
    var term: []const u8 = "xterm-ghostty";
    var max_sessions: u32 = 16;
    var kitty = true;
    var quality: u32 = 90;
    var i: usize = 1;
    while (i < args.len) : (i += 2) {
        if (i + 1 >= args.len) return error.InvalidArgument;
        const key = args[i];
        const value = args[i + 1];
        if (std.mem.eql(u8, key, "--socket")) socket_path = value else if (std.mem.eql(u8, key, "--shell")) shell = value else if (std.mem.eql(u8, key, "--worker")) worker = value else if (std.mem.eql(u8, key, "--term")) term = value else if (std.mem.eql(u8, key, "--max-sessions")) max_sessions = try std.fmt.parseInt(u32, value, 10) else if (std.mem.eql(u8, key, "--webp-quality")) quality = try std.fmt.parseInt(u32, value, 10) else if (std.mem.eql(u8, key, "--kitty-graphics")) {
            if (std.mem.eql(u8, value, "true") or std.mem.eql(u8, value, "1")) kitty = true else if (std.mem.eql(u8, value, "false") or std.mem.eql(u8, value, "0")) kitty = false else return error.InvalidArgument;
        } else return error.InvalidArgument;
    }
    if (socket_path == null) {
        const dir = try std.fmt.allocPrintSentinel(a, "/tmp/bcwebmux-{d}", .{posix.geteuid()}, 0);
        if (posix.mkdir(dir, 0o700) != 0 and std.posix.errno(-1) != .EXIST) return error.CreateSocketDirectory;
        socket_path = try std.fs.path.join(a, &.{ dir, "session.sock" });
    }
    const path = socket_path.?;
    if (path.len == 0 or path[0] == 0 or std.mem.indexOfScalar(u8, path, 0) != null) return error.InvalidArgument;
    try checkedParent(path);
    const zpath = try a.dupeSentinel(u8, path, 0);
    const lock_path = try std.fmt.allocPrintSentinel(a, "{s}.lock", .{path}, 0);
    const lock_fd = posix.open(lock_path, posix.O_CREAT | posix.O_RDWR | posix.O_CLOEXEC | posix.O_NOFOLLOW, @as(c_uint, 0o600));
    if (lock_fd < 0) return error.LockFailed;
    defer _ = posix.close(lock_fd);
    if (posix.flock(lock_fd, posix.LOCK_EX | posix.LOCK_NB) != 0) return error.AlreadyRunning;
    const address = try std.Io.net.UnixAddress.init(path);
    var old: std.os.linux.Statx = undefined;
    const old_status = statPath(zpath, false, &old);
    if (old_status == .SUCCESS) {
        if ((old.mode & posix.S_IFMT) != posix.S_IFSOCK or old.uid != posix.geteuid()) return error.UnsafeExistingSocket;
        if (address.connect(init.io)) |active| {
            active.close(init.io);
            return error.AlreadyRunning;
        } else |err| switch (err) {
            error.ConnectionRefused => {},
            else => return err,
        }
        if (!sameSocket(zpath, old) or posix.unlink(zpath) != 0) return error.UnsafeExistingSocket;
    } else if (old_status != .NOENT) return error.SocketStatFailed;
    const config = c.bcwebmux_engine_config{
        .abi_version = c.BCWMUX_ABI_VERSION,
        .worker_path = worker.ptr,
        .worker_path_len = worker.len,
        .shell = shell.ptr,
        .shell_len = shell.len,
        .term = term.ptr,
        .term_len = term.len,
        .disable_kitty_graphics = @intFromBool(!kitty),
        .expected_origin = null,
        .expected_origin_len = 0,
        .max_live_sessions = max_sessions,
        .webp_quality = quality,
    };
    var engine: ?*api.Engine = null;
    if (api.bcwebmux_engine_open(&config, &engine) != c.BCWMUX_OK) return error.EngineOpenFailed;
    defer _ = api.bcwebmux_engine_close(engine);
    const prev_mask = posix.umask(0o077);
    var server = address.listen(init.io, .{}) catch |err| {
        _ = posix.umask(prev_mask);
        return err;
    };
    _ = posix.umask(prev_mask);
    var created: std.os.linux.Statx = undefined;
    if (statPath(zpath, false, &created) != .SUCCESS) {
        server.deinit(init.io);
        return error.SocketStatFailed;
    }
    defer if (sameSocket(zpath, created)) {
        _ = posix.unlink(zpath);
    };
    defer server.deinit(init.io);
    listener_fd.store(server.socket.handle, .release);
    const action = std.posix.Sigaction{ .handler = .{ .handler = signalHandler }, .mask = std.posix.sigemptyset(), .flags = 0 };
    var old_int: std.posix.Sigaction = undefined;
    var old_term: std.posix.Sigaction = undefined;
    std.posix.sigaction(.INT, &action, &old_int);
    std.posix.sigaction(.TERM, &action, &old_term);
    defer {
        listener_fd.store(-1, .release);
        std.posix.sigaction(.INT, &old_int, null);
        std.posix.sigaction(.TERM, &old_term, null);
    }
    var state = State{ .io = init.io, .engine = engine.? };
    var group: std.Io.Group = .init;
    defer group.cancel(init.io);
    while (!stopping.load(.acquire)) {
        const stream = server.accept(init.io) catch |err| {
            if (stopping.load(.acquire)) break;
            return err;
        };
        if (state.clients.fetchAdd(1, .acq_rel) >= max_clients) {
            _ = state.clients.fetchSub(1, .acq_rel);
            stream.close(init.io);
            continue;
        }
        group.concurrent(init.io, client, .{ &state, stream }) catch {
            _ = state.clients.fetchSub(1, .acq_rel);
            stream.close(init.io);
        };
    }
}
