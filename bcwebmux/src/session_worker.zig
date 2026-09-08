// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");
const c = @cImport({
    @cDefine("_XOPEN_SOURCE", "600");
    @cInclude("signal.h");
    @cInclude("sys/socket.h");
});

pub const packet_capacity = 64 * 1024 + 1;

pub const Kind = enum(u8) {
    input = 1,
    resize = 2,
    terminate = 3,
    output = 4,
    exited = 5,
    resize_applied = 6,
    ready = 7,
};

pub const Message = struct {
    kind: Kind,
    payload: []const u8,
};

pub fn decodeKind(value: u8) ?Kind {
    return std.enums.fromInt(Kind, value);
}

pub const Connection = struct {
    channel: std.Io.File,
    child: std.process.Child,
    send_mutex: std.Io.Mutex = .init,
    closed: bool = false,

    pub fn send(self: *Connection, io: std.Io, kind: Kind, payload: []const u8) !void {
        if (payload.len >= packet_capacity) return error.WorkerClosed;
        try self.send_mutex.lock(io);
        defer self.send_mutex.unlock(io);
        if (self.closed) return error.WorkerClosed;
        var prefix = [_]u8{@intFromEnum(kind)};
        var iovecs = [_]c.struct_iovec{
            .{ .iov_base = &prefix, .iov_len = 1 },
            .{ .iov_base = @constCast(payload.ptr), .iov_len = payload.len },
        };
        var message: c.struct_msghdr = std.mem.zeroes(c.struct_msghdr);
        message.msg_iov = &iovecs;
        message.msg_iovlen = if (payload.len == 0) 1 else 2;
        // Atomic nonblocking vectored packet sends with MSG_NOSIGNAL are not supported by
        // std.Io socket send (IP destinations only).
        var sent = c.sendmsg(self.channel.handle, &message, c.MSG_NOSIGNAL | c.MSG_DONTWAIT);
        while (sent == -1 and std.c.errno(sent) == .INTR) {
            try io.checkCancel();
            sent = c.sendmsg(self.channel.handle, &message, c.MSG_NOSIGNAL | c.MSG_DONTWAIT);
        }
        const length = payload.len + 1;
        if (sent != @as(isize, @intCast(length))) return error.WorkerWriteFailed;
    }

    pub fn receive(self: *Connection, io: std.Io, buffer: []u8) !Message {
        if (buffer.len < packet_capacity + 1) return error.InvalidWorkerPacket;
        // One unbuffered readv preserves packet boundaries and is cancelable through std.Io.
        // The extra byte detects oversized packets; Socket.receive currently decodes IP
        // source addresses and cannot receive from an unnamed Unix socketpair.
        const count = self.channel.readStreaming(io, &.{buffer}) catch |err| switch (err) {
            error.EndOfStream => return error.WorkerClosed,
            else => return err,
        };
        if (count == 0 or count > packet_capacity) return error.InvalidWorkerPacket;
        const kind = decodeKind(buffer[0]) orelse return error.InvalidWorkerPacket;
        return .{
            .kind = kind,
            .payload = buffer[1..count],
        };
    }

    fn awaitReady(self: *Connection, io: std.Io) !void {
        var buffer: [packet_capacity + 1]u8 = undefined;
        const message = try self.receive(io, &buffer);
        if (message.kind != .ready or message.payload.len != 0) return error.InvalidWorkerReady;
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
        self.send_mutex.lockUncancelable(io);
        defer self.send_mutex.unlock(io);
        if (self.closed) return;
        var packet = [_]u8{@intFromEnum(Kind.terminate)};
        // Do not block on a full input queue; the signal fallback wakes the worker.
        _ = c.send(self.channel.handle, &packet, packet.len, c.MSG_NOSIGNAL | c.MSG_DONTWAIT);
        if (self.child.id) |pid| {
            _ = c.kill(pid, c.SIGUSR1);
        }
    }

    // Only the receive owner may close, or close may be called after the receive owner finishes.
    pub fn close(self: *Connection, io: std.Io) void {
        self.send_mutex.lockUncancelable(io);
        defer self.send_mutex.unlock(io);
        if (self.closed) return;
        self.closed = true;
        self.channel.close(io);
    }

    pub fn finish(self: *Connection, io: std.Io) void {
        const previous = io.swapCancelProtection(.blocked);
        defer _ = io.swapCancelProtection(previous);
        self.close(io);
        if (self.child.id != null) {
            // The worker must clean up its PTY process group before it is reaped.
            // closed also guards readers of child.id.
            _ = self.child.wait(io) catch {
                self.child.kill(io);
                return;
            };
        }
    }
};

pub fn spawn(io: std.Io, executable: []const u8, shell: []const u8, cols: u16, rows: u16) !Connection {
    if (executable.len == 0 or shell.len == 0 or std.mem.indexOfScalar(u8, executable, 0) != null or std.mem.indexOfScalar(u8, shell, 0) != null) return error.InvalidArgument;
    var sockets: [2]c_int = .{ -1, -1 };
    // std.Io Socket.createPair only supports IP families.
    if (c.socketpair(c.AF_UNIX, c.SOCK_SEQPACKET | c.SOCK_CLOEXEC, 0, &sockets) != 0)
        return error.SocketPairFailed;
    const files = [_]std.Io.File{
        .{ .handle = sockets[0], .flags = .{ .nonblocking = false } },
        .{ .handle = sockets[1], .flags = .{ .nonblocking = false } },
    };
    const child = blk: {
        errdefer files[0].close(io);
        defer files[1].close(io);

        var cols_buffer: [8]u8 = undefined;
        var rows_buffer: [8]u8 = undefined;
        const cols_text = try std.fmt.bufPrint(&cols_buffer, "{d}", .{cols});
        const rows_text = try std.fmt.bufPrint(&rows_buffer, "{d}", .{rows});
        break :blk try std.process.spawn(io, .{
            .argv = &.{ executable, "--session-worker", shell, cols_text, rows_text },
            .stdin = .{ .file = files[1] },
            .stdout = .{ .file = files[1] },
            .stderr = .inherit,
        });
    };
    // Do not publish the connection until the worker has installed its signal handler and PTY cleanup.
    // Close and reap failed or canceled startup.
    var connection: Connection = .{ .channel = files[0], .child = child };
    errdefer connection.finish(io);
    try connection.awaitReady(io);
    return connection;
}

test "seqpacket boundaries, readiness, validation, close, and receive cancellation" {
    if (!@import("builtin").link_libc) return error.SkipZigTest;
    const io = std.testing.io;
    var sockets: [2]c_int = .{ -1, -1 };
    if (c.socketpair(c.AF_UNIX, c.SOCK_SEQPACKET | c.SOCK_CLOEXEC, 0, &sockets) != 0)
        return error.SocketPairFailed;
    const files = [_]std.Io.File{
        .{ .handle = sockets[0], .flags = .{ .nonblocking = false } },
        .{ .handle = sockets[1], .flags = .{ .nonblocking = false } },
    };
    var a = Connection{ .channel = files[0], .child = undefined };
    var b = Connection{ .channel = files[1], .child = undefined };
    defer a.close(io);
    defer b.close(io);

    var buffer: [packet_capacity + 1]u8 = undefined;
    try a.send(io, .output, "");
    try std.testing.expectError(error.InvalidWorkerReady, b.awaitReady(io));
    try a.send(io, .ready, "unexpected");
    try std.testing.expectError(error.InvalidWorkerReady, b.awaitReady(io));
    try a.send(io, .ready, "");
    try a.send(io, .output, "after ready");
    try b.awaitReady(io);
    const after_ready = try b.receive(io, &buffer);
    try std.testing.expectEqual(.output, after_ready.kind);
    try std.testing.expectEqualSlices(u8, "after ready", after_ready.payload);

    try a.send(io, .input, "first");
    try a.send(io, .resize, "");
    const first = try b.receive(io, &buffer);
    try std.testing.expectEqual(.input, first.kind);
    try std.testing.expectEqualSlices(u8, "first", first.payload);

    const second = try b.receive(io, &buffer);
    try std.testing.expectEqual(.resize, second.kind);
    try std.testing.expectEqual(@as(usize, 0), second.payload.len);

    var maximum: [packet_capacity - 1]u8 = undefined;
    @memset(&maximum, 0x5a);
    try a.send(io, .output, &maximum);
    const full = try b.receive(io, &buffer);
    try std.testing.expectEqual(.output, full.kind);
    try std.testing.expectEqualSlices(u8, &maximum, full.payload);

    var oversized: [packet_capacity + 1]u8 = undefined;
    oversized[0] = @intFromEnum(Kind.output);
    @memset(oversized[1..], 0);
    const oversized_sent = c.send(a.channel.handle, &oversized, oversized.len, c.MSG_NOSIGNAL);
    try std.testing.expectEqual(@as(isize, oversized.len), oversized_sent);
    try std.testing.expectError(error.InvalidWorkerPacket, b.receive(io, &buffer));

    var invalid = [_]u8{255};
    const invalid_sent = c.send(a.channel.handle, &invalid, invalid.len, c.MSG_NOSIGNAL);
    try std.testing.expectEqual(@as(isize, 1), invalid_sent);
    try std.testing.expectError(error.InvalidWorkerPacket, b.receive(io, &buffer));

    var future = try io.concurrent(Connection.awaitReady, .{ &b, io });
    try std.testing.expectError(error.Canceled, future.cancel(io));

    a.close(io);
    a.close(io);
    try std.testing.expectError(error.WorkerClosed, a.send(io, .input, ""));
    try std.testing.expectError(error.WorkerClosed, b.receive(io, &buffer));
    try std.testing.expectError(error.WorkerClosed, b.awaitReady(io));

    if (@import("builtin").os.tag == .linux) {
        try std.testing.expectError(error.WorkerClosed, spawn(io, "/bin/true", "/bin/sh", 80, 24));
    }
}
