// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");
const manifest = @import("session_manifest.zig");
const c = @cImport({
    @cDefine("_XOPEN_SOURCE", "600");
    @cInclude("fcntl.h");
    @cInclude("poll.h");
    @cInclude("pty.h");
    @cInclude("signal.h");
    @cInclude("stdlib.h");
    @cInclude("sys/ioctl.h");
    @cInclude("sys/socket.h");
    @cInclude("time.h");
    @cInclude("sys/wait.h");
    @cInclude("unistd.h");
});

pub const packet_capacity = 64 * 1024 + 1;
var worker_terminate_signal: std.atomic.Value(bool) = .init(false);

fn workerTerminateSignalHandler(_: std.posix.SIG) callconv(.c) void {
    worker_terminate_signal.store(true, .release);
}

pub const Kind = enum(u8) {
    input = 1,
    resize = 2,
    terminate = 3,
    output = 4,
    exited = 5,
    resize_applied = 6,
};

pub const Message = struct {
    kind: Kind,
    payload: []const u8,
};

fn decodeKind(value: u8) ?Kind {
    return switch (value) {
        1 => .input,
        2 => .resize,
        3 => .terminate,
        4 => .output,
        5 => .exited,
        6 => .resize_applied,
        else => null,
    };
}

pub const Connection = struct {
    fd: std.posix.fd_t,
    child: std.process.Child,
    send_mutex: std.Io.Mutex = .init,
    closed: std.atomic.Value(bool) = .init(false),

    pub fn send(self: *Connection, io: std.Io, kind: Kind, payload: []const u8) !void {
        if (payload.len + 1 > packet_capacity or self.closed.load(.acquire)) return error.WorkerClosed;
        try self.send_mutex.lock(io);
        defer self.send_mutex.unlock(io);
        var prefix = [_]u8{@intFromEnum(kind)};
        var iovecs = [_]c.struct_iovec{
            .{ .iov_base = &prefix, .iov_len = 1 },
            .{ .iov_base = @constCast(payload.ptr), .iov_len = payload.len },
        };
        var message: c.struct_msghdr = std.mem.zeroes(c.struct_msghdr);
        message.msg_iov = &iovecs;
        message.msg_iovlen = if (payload.len == 0) 1 else 2;
        const sent = c.sendmsg(self.fd, &message, c.MSG_NOSIGNAL | c.MSG_DONTWAIT);
        const length = payload.len + 1;
        if (sent != @as(isize, @intCast(length))) return error.WorkerWriteFailed;
    }

    pub fn receive(self: *Connection, buffer: []u8) !Message {
        if (buffer.len < 2) return error.InvalidWorkerPacket;
        const count = c.recv(self.fd, buffer.ptr, buffer.len, 0);
        if (count <= 0) return error.WorkerClosed;
        const kind = decodeKind(buffer[0]) orelse return error.InvalidWorkerPacket;
        return .{
            .kind = kind,
            .payload = buffer[1..@intCast(count)],
        };
    }

    pub fn resize(self: *Connection, io: std.Io, operation_id: u64, cols: u16, rows: u16, cell_width_px: u16, cell_height_px: u16) !void {
        var payload: [16]u8 = undefined;
        std.mem.writeInt(u64, payload[0..8], operation_id, .little);
        std.mem.writeInt(u16, payload[8..10], cols, .little);
        std.mem.writeInt(u16, payload[10..12], rows, .little);
        std.mem.writeInt(u16, payload[12..14], cell_width_px, .little);
        std.mem.writeInt(u16, payload[14..16], cell_height_px, .little);
        try self.send(io, .resize, &payload);
    }

    pub fn terminate(self: *Connection, io: std.Io) void {
        self.send(io, .terminate, &.{}) catch |err| std.log.err("session worker terminate send failed: {t}", .{err});
        if (self.child.id) |pid| {
            _ = c.kill(pid, c.SIGUSR1);
        }
    }

    pub fn close(self: *Connection) void {
        if (self.closed.swap(true, .acq_rel)) return;
        _ = c.close(self.fd);
    }
};

pub fn spawn(io: std.Io, executable: []const u8, shell: []const u8, cols: u16, rows: u16) !Connection {
    var sockets: [2]c_int = .{ -1, -1 };
    if (c.socketpair(c.AF_UNIX, c.SOCK_SEQPACKET | c.SOCK_CLOEXEC, 0, &sockets) != 0)
        return error.SocketPairFailed;
    errdefer {
        _ = c.close(sockets[0]);
        _ = c.close(sockets[1]);
    }

    var cols_buffer: [8]u8 = undefined;
    var rows_buffer: [8]u8 = undefined;
    const cols_text = try std.fmt.bufPrint(&cols_buffer, "{d}", .{cols});
    const rows_text = try std.fmt.bufPrint(&rows_buffer, "{d}", .{rows});
    const child_file: std.Io.File = .{
        .handle = sockets[1],
        .flags = .{ .nonblocking = false },
    };
    const child = try std.process.spawn(io, .{
        .argv = &.{ executable, "--session-worker", shell, cols_text, rows_text },
        .stdin = .{ .file = child_file },
        .stdout = .{ .file = child_file },
        .stderr = .inherit,
    });
    _ = c.close(sockets[1]);
    sockets[1] = -1;
    return .{ .fd = sockets[0], .child = child };
}

pub fn run(shell: [:0]const u8, cols: u16, rows: u16, limits: manifest.Limits) !void {
    worker_terminate_signal.store(false, .release);
    const signal_action: std.posix.Sigaction = .{
        .handler = .{ .handler = workerTerminateSignalHandler },
        .mask = std.posix.sigemptyset(),
        .flags = 0,
    };
    std.posix.sigaction(.USR1, &signal_action, null);
    const channel = std.posix.STDIN_FILENO;
    var master: c_int = -1;
    var size: c.struct_winsize = std.mem.zeroes(c.struct_winsize);
    size.ws_col = cols;
    size.ws_row = rows;
    const pid = c.forkpty(&master, null, null, &size);
    if (pid < 0) return error.ForkPtyFailed;
    if (pid == 0) {
        _ = c.setenv("TERM", "xterm-256color", 1);
        _ = c.setenv("COLORTERM", "truecolor", 1);
        var argv = [_:null]?[*:0]const u8{ shell.ptr, "-l" };
        _ = c.execvp(shell.ptr, @ptrCast(&argv));
        c._exit(127);
    }
    var child_reaped = false;
    var child_status: c_int = 0;
    defer {
        if (!child_reaped) {
            _ = c.kill(-pid, c.SIGHUP);
            _ = c.kill(-pid, c.SIGTERM);
            _ = c.kill(-pid, c.SIGKILL);
            _ = c.waitpid(pid, &child_status, 0);
        }
    }
    defer _ = c.close(master);

    var terminating = false;
    var termination_started_ms: ?u64 = null;
    var packet: [packet_capacity]u8 = undefined;
    while (true) {
        if (worker_terminate_signal.swap(false, .acq_rel) and !terminating) {
            terminating = true;
            _ = c.kill(-pid, c.SIGHUP);
            _ = c.kill(-pid, c.SIGTERM);
            termination_started_ms = monotonicMs();
        }
        var drained_for_resize = false;
        var descriptors = [_]c.struct_pollfd{
            .{ .fd = if (termination_started_ms == null) channel else -1, .events = c.POLLIN, .revents = 0 },
            .{ .fd = master, .events = c.POLLIN, .revents = 0 },
        };
        const timeout: c_int = if (terminating) 100 else 500;
        const poll_result = c.poll(&descriptors, descriptors.len, timeout);
        if (poll_result < 0) continue;

        if ((descriptors[0].revents & (c.POLLIN | c.POLLHUP | c.POLLERR)) != 0) {
            const count = c.recv(channel, &packet, packet.len, 0);
            if (count <= 0) {
                if (termination_started_ms == null) {
                    _ = c.kill(-pid, c.SIGHUP);
                    _ = c.kill(-pid, c.SIGTERM);
                    termination_started_ms = monotonicMs();
                    terminating = true;
                }
            } else {
                const data = packet[0..@intCast(count)];
                const kind = decodeKind(data[0]) orelse continue;
                switch (kind) {
                    .input => writeAll(master, data[1..]),
                    .resize => if (data.len == 17) {
                        var resize_payload: [16]u8 = undefined;
                        std.mem.copyForwards(u8, &resize_payload, data[1..17]);
                        if (!drainAvailableOutput(channel, master, &packet)) return;
                        drained_for_resize = true;
                        var next_size: c.struct_winsize = std.mem.zeroes(c.struct_winsize);
                        next_size.ws_col = std.mem.readInt(u16, resize_payload[8..10], .little);
                        next_size.ws_row = std.mem.readInt(u16, resize_payload[10..12], .little);
                        const status: u8 = if (next_size.ws_col != 0 and next_size.ws_row != 0 and c.ioctl(master, c.TIOCSWINSZ, &next_size) == 0) 0 else 1;
                        var acknowledgement: [18]u8 = undefined;
                        acknowledgement[0] = @intFromEnum(Kind.resize_applied);
                        std.mem.copyForwards(u8, acknowledgement[1..17], &resize_payload);
                        acknowledgement[17] = status;
                        if (!sendPacket(channel, &acknowledgement)) return;
                    },
                    .terminate => if (!terminating) {
                        terminating = true;
                        _ = c.kill(-pid, c.SIGHUP);
                        _ = c.kill(-pid, c.SIGTERM);
                        termination_started_ms = monotonicMs();
                    },
                    .resize_applied => {},
                    else => {},
                }
            }
        }

        if (!drained_for_resize and (descriptors[1].revents & (c.POLLIN | c.POLLHUP | c.POLLERR)) != 0) {
            const count = c.read(master, packet[1..].ptr, packet.len - 1);
            if (count > 0) {
                packet[0] = @intFromEnum(Kind.output);
                if (!sendPacket(channel, packet[0 .. @as(usize, @intCast(count)) + 1])) return;
            }
        }

        const waited = c.waitpid(pid, &child_status, c.WNOHANG);
        if (waited == pid) {
            child_reaped = true;
            _ = c.kill(-pid, c.SIGHUP);
            drainOutput(channel, master, &packet);
            var exit_packet: [5]u8 = undefined;
            exit_packet[0] = @intFromEnum(Kind.exited);
            std.mem.writeInt(i32, exit_packet[1..5], child_status, .little);
            _ = sendPacket(channel, &exit_packet);
            return;
        }
        if (terminating) {
            if (termination_started_ms) |started_ms| {
                if (monotonicMs() - started_ms >= limits.termination_grace_ms)
                    _ = c.kill(-pid, c.SIGKILL);
            }
        }
    }
}

fn monotonicMs() u64 {
    var timestamp: c.struct_timespec = undefined;
    _ = c.clock_gettime(c.CLOCK_MONOTONIC, &timestamp);
    return @as(u64, @intCast(timestamp.tv_sec)) * 1000 +
        @as(u64, @intCast(timestamp.tv_nsec)) / 1_000_000;
}

fn sendPacket(fd: c_int, packet: []const u8) bool {
    return c.send(fd, packet.ptr, packet.len, c.MSG_NOSIGNAL) == @as(isize, @intCast(packet.len));
}

fn writeAll(fd: c_int, bytes: []const u8) void {
    var remaining = bytes;
    while (remaining.len != 0) {
        if (worker_terminate_signal.load(.acquire)) return;
        const count = c.write(fd, remaining.ptr, remaining.len);
        if (count <= 0) return;
        remaining = remaining[@intCast(count)..];
    }
}

fn drainAvailableOutput(channel: c_int, master: c_int, packet: *[packet_capacity]u8) bool {
    const flags = c.fcntl(master, c.F_GETFL);
    if (flags < 0 or c.fcntl(master, c.F_SETFL, flags | c.O_NONBLOCK) < 0) return false;
    defer _ = c.fcntl(master, c.F_SETFL, flags);
    while (true) {
        const count = c.read(master, packet[1..].ptr, packet.len - 1);
        if (count <= 0) return true;
        packet[0] = @intFromEnum(Kind.output);
        if (!sendPacket(channel, packet[0 .. @as(usize, @intCast(count)) + 1])) return false;
    }
}

fn drainOutput(channel: c_int, master: c_int, packet: *[packet_capacity]u8) void {
    const flags = c.fcntl(master, c.F_GETFL);
    if (flags < 0 or c.fcntl(master, c.F_SETFL, flags | c.O_NONBLOCK) < 0) return;
    while (true) {
        const count = c.read(master, packet[1..].ptr, packet.len - 1);
        if (count <= 0) return;
        packet[0] = @intFromEnum(Kind.output);
        if (!sendPacket(channel, packet[0 .. @as(usize, @intCast(count)) + 1])) return;
    }
}
