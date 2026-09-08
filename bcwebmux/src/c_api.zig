// SPDX-License-Identifier: MIT
const std = @import("std");
const c = @cImport({
    @cInclude("bcwebmux.h");
});
const Registry = @import("SessionRegistry.zig");
const SessionSocket = @import("SessionSocket.zig");
const session_api = @import("session_api.zig");
const manifest = @import("session_manifest.zig");
const protocol = @import("protocol.zig");

const allocator = std.heap.c_allocator;
const CStatus = c.bcwebmux_status;
const abi_version = c.BCWMUX_ABI_VERSION;
const queue_default_bytes = 4 * 1024 * 1024;
const queue_default_message = protocol.max_frame_length;

const CEngineConfig = c.bcwebmux_engine_config;
const CHttpRequest = c.bcwebmux_http_request_input;
const CHttpResponse = c.bcwebmux_http_response;
const CSocketOptions = c.bcwebmux_socket_options;
const CMessage = c.bcwebmux_message;

const Engine = struct {
    threaded: std.Io.Threaded,
    io: std.Io,
    registry: Registry,
    expected_origin: []u8,
    socket_count: usize = 0,
};
const Socket = struct {
    engine: *Engine,
    queue: SessionSocket.MessageQueue,
    session: SessionSocket,
    closed: bool = false,
};

fn slice(pointer: [*c]const u8, length: usize, maximum: usize) ![]const u8 {
    if (length > maximum) return error.InputTooLarge;
    if (length == 0) return "";
    if (pointer == null) return error.InvalidArgument;
    return pointer[0..length];
}

fn mapError(err: anyerror) CStatus {
    return switch (err) {
        error.OutOfMemory => c.BCWMUX_OUT_OF_MEMORY,
        error.ShuttingDown, error.EngineClosed => c.BCWMUX_SHUTTING_DOWN,
        error.SocketClosed, error.QueueClosed, error.WorkerClosed => c.BCWMUX_CLOSED,
        error.QueueOverflow => c.BCWMUX_QUEUE_OVERFLOW,
        error.WouldBlock => c.BCWMUX_WOULD_BLOCK,
        error.MessageTooLarge, error.FrameTooLarge, error.BodyTooLarge, error.InputTooLarge => c.BCWMUX_TOO_LARGE,
        error.SessionNotFound, error.NotApi => c.BCWMUX_NOT_FOUND,
        error.InvalidArgument, error.InvalidIdempotencyKey, error.InvalidLimits, error.SessionLimitTooLarge => c.BCWMUX_INVALID_ARGUMENT,
        error.InvalidFrame, error.HelloRequired, error.InvalidClientFrame, error.ProtocolError, error.InvalidHello, error.InvalidConnectionSequence, error.InvalidAck, error.InvalidClaim, error.InvalidCredit, error.InvalidDetach, error.InvalidInput, error.InvalidPing, error.InvalidPong, error.InvalidResize, error.IncompatibleTerminalAbi, error.UnexpectedWebSocketMessage, error.BatchLimitTooSmall => c.BCWMUX_PROTOCOL_ERROR,
        error.NotReady => c.BCWMUX_NOT_READY,
        else => c.BCWMUX_INTERNAL,
    };
}

fn terminateSocket(socket: *Socket) void {
    if (socket.closed) return;
    socket.session.deinit();
    socket.queue.close();
    socket.closed = true;
}

export fn bcwebmux_engine_open(config: ?*const CEngineConfig, out: ?*?*Engine) CStatus {
    const output = out orelse return c.BCWMUX_INVALID_ARGUMENT;
    output.* = null;
    output.* = initEngine(config orelse return 1) catch |err| return mapError(err);
    return c.BCWMUX_OK;
}

fn initEngine(config: *const CEngineConfig) !*Engine {
    const raw = config.*;
    if (raw.abi_version != abi_version or raw.max_live_sessions > 64) return error.InvalidArgument;
    const worker = try slice(raw.worker_path, raw.worker_path_len, 4096);
    const shell = try slice(raw.shell, raw.shell_len, 4096);
    if (worker.len == 0 or shell.len == 0 or std.mem.indexOfScalar(u8, worker, 0) != null or std.mem.indexOfScalar(u8, shell, 0) != null) return error.InvalidArgument;
    const origin = try slice(raw.expected_origin, raw.expected_origin_len, 4096);
    var native_limits: manifest.Limits = .{};
    if (raw.max_live_sessions != 0) native_limits.max_live_sessions = raw.max_live_sessions;
    const engine = try allocator.create(Engine);
    errdefer allocator.destroy(engine);
    engine.* = .{ .threaded = undefined, .io = undefined, .registry = undefined, .expected_origin = undefined };
    // The Go entry point does not provide std.process.Init. Supply libc's
    // environment explicitly so spawned workers inherit HOME (and shell env).
    engine.threaded = std.Io.Threaded.init(allocator, .{
        .environ = .{ .block = .{ .slice = std.mem.span(std.c.environ) } },
    });
    errdefer engine.threaded.deinit();
    engine.io = engine.threaded.io();
    engine.registry = try Registry.init(allocator, engine.io, worker, shell, native_limits);
    errdefer engine.registry.deinit();
    engine.expected_origin = try allocator.dupe(u8, origin);
    return engine;
}

export fn bcwebmux_engine_close(engine: ?*Engine) CStatus {
    const value = engine orelse return c.BCWMUX_INVALID_ARGUMENT;
    if (value.socket_count != 0) return c.BCWMUX_BUSY;
    value.registry.deinit();
    value.threaded.deinit();
    allocator.free(value.expected_origin);
    allocator.destroy(value);
    return c.BCWMUX_OK;
}

export fn bcwebmux_http_request(engine: ?*Engine, request: ?*const CHttpRequest, response: ?*CHttpResponse) CStatus {
    const output = response orelse return c.BCWMUX_INVALID_ARGUMENT;
    output.* = std.mem.zeroes(CHttpResponse);
    const value = engine orelse return c.BCWMUX_INVALID_ARGUMENT;
    const raw = request orelse return c.BCWMUX_INVALID_ARGUMENT;
    const method_bytes = slice(raw.method, raw.method_len, 32) catch |err| return mapError(err);
    const method = std.meta.stringToEnum(std.http.Method, method_bytes) orelse return c.BCWMUX_INVALID_ARGUMENT;
    const input = session_api.MemoryInput{
        .method = method,
        .target = slice(raw.target, raw.target_len, 8192) catch |err| return mapError(err),
        .origin = slice(raw.origin, raw.origin_len, 4096) catch |err| return mapError(err),
        .content_type = slice(raw.content_type, raw.content_type_len, 1024) catch |err| return mapError(err),
        .idempotency_key = slice(raw.idempotency_key, raw.idempotency_key_len, 128) catch |err| return mapError(err),
        .body = slice(raw.body, raw.body_len, value.registry.limits.max_request_bytes + 1) catch |err| return mapError(err),
    };
    const result = session_api.serveMemory(&value.registry, value.expected_origin, allocator, input) catch |err| return mapError(err);
    output.status = @intFromEnum(result.status);
    output.replayed = @intFromBool(result.replayed);
    output.body_len = result.body.len;
    output.body = if (result.body.len == 0) null else result.body.ptr;
    output.content_type_len = result.content_type.len;
    output.content_type = if (result.content_type.len == 0) null else @ptrCast(result.content_type.ptr);
    if (result.location) |location| {
        output.location_len = location.len;
        output.location = if (location.len == 0) null else @ptrCast(location.ptr);
    }
    return c.BCWMUX_OK;
}

export fn bcwebmux_http_response_free(response: ?*CHttpResponse) void {
    const value = response orelse return;
    if (value.body_len != 0) allocator.free(value.body[0..value.body_len]);
    if (value.content_type_len != 0) allocator.free(@as([*]u8, @ptrCast(value.content_type))[0..value.content_type_len]);
    if (value.location_len != 0) allocator.free(@as([*]u8, @ptrCast(value.location))[0..value.location_len]);
    value.* = std.mem.zeroes(CHttpResponse);
}

export fn bcwebmux_socket_open(engine: ?*Engine, options: ?*const CSocketOptions, out: ?*?*Socket) CStatus {
    if (out == null) return c.BCWMUX_INVALID_ARGUMENT;
    out.?.* = null;
    const value = engine orelse return c.BCWMUX_INVALID_ARGUMENT;
    const raw = options orelse &CSocketOptions{ .abi_version = abi_version, .max_queue_bytes = 0, .max_message_bytes = 0 };
    if (raw.abi_version != abi_version) return c.BCWMUX_INVALID_ARGUMENT;
    const max_queue = if (raw.max_queue_bytes == 0) queue_default_bytes else raw.max_queue_bytes;
    const max_message = if (raw.max_message_bytes == 0) queue_default_message else raw.max_message_bytes;
    if (max_queue == 0 or max_message == 0 or max_message > protocol.max_frame_length or max_queue > 64 * 1024 * 1024) return c.BCWMUX_INVALID_ARGUMENT;
    const socket = allocator.create(Socket) catch return c.BCWMUX_OUT_OF_MEMORY;
    socket.* = .{ .engine = value, .queue = SessionSocket.MessageQueue.init(allocator, max_queue, max_message), .session = undefined };
    socket.session = SessionSocket.initBuffered(allocator, value.io, &value.registry, &socket.queue) catch |err| {
        socket.queue.deinit();
        allocator.destroy(socket);
        return mapError(err);
    };
    value.socket_count += 1;
    out.?.* = socket;
    return c.BCWMUX_OK;
}

export fn bcwebmux_socket_receive_binary(socket: ?*Socket, data: ?[*]const u8, length: usize) CStatus {
    const value = socket orelse return c.BCWMUX_INVALID_ARGUMENT;
    if (value.closed) return c.BCWMUX_CLOSED;
    if (length != 0 and data == null) return c.BCWMUX_INVALID_ARGUMENT;
    value.session.receiveBinary(if (length == 0) "" else data.?[0..length]) catch |err| {
        terminateSocket(value);
        return mapError(err);
    };
    return c.BCWMUX_OK;
}

export fn bcwebmux_socket_set_transport_managed(socket: ?*Socket, managed: u8) CStatus {
    const value = socket orelse return c.BCWMUX_INVALID_ARGUMENT;
    if (value.closed) return c.BCWMUX_CLOSED;
    if (managed > 1 or value.session.negotiated) return c.BCWMUX_INVALID_ARGUMENT;
    value.session.transport_managed = managed == 1;
    return c.BCWMUX_OK;
}

export fn bcwebmux_socket_tick(socket: ?*Socket) CStatus {
    const value = socket orelse return c.BCWMUX_INVALID_ARGUMENT;
    if (value.closed) return c.BCWMUX_CLOSED;
    value.session.tick() catch |err| {
        // Negotiation pending is nonfatal.
        if (err == error.NotReady) return c.BCWMUX_NOT_READY;
        terminateSocket(value);
        return mapError(err);
    };
    return c.BCWMUX_OK;
}

export fn bcwebmux_socket_drain(socket: ?*Socket, output: ?*CMessage) CStatus {
    const message = output orelse return c.BCWMUX_INVALID_ARGUMENT;
    message.* = std.mem.zeroes(CMessage);
    const value = socket orelse return c.BCWMUX_INVALID_ARGUMENT;
    if (value.queue.pop()) |item| {
        message.data = item.data.ptr;
        message.len = item.data.len;
        return c.BCWMUX_OK;
    }
    if (value.closed or value.queue.isClosed()) return c.BCWMUX_CLOSED;
    return c.BCWMUX_WOULD_BLOCK;
}

export fn bcwebmux_socket_close(socket: ?*Socket) CStatus {
    const value = socket orelse return c.BCWMUX_INVALID_ARGUMENT;
    terminateSocket(value);
    value.engine.socket_count -= 1;
    value.queue.deinit();
    allocator.destroy(value);
    return c.BCWMUX_OK;
}

export fn bcwebmux_message_free(message: ?*CMessage) void {
    const value = message orelse return;
    if (value.len != 0) allocator.free(value.data[0..value.len]);
    value.* = std.mem.zeroes(CMessage);
}

export fn bcwebmux_status_name(status: CStatus) [*:0]const u8 {
    return switch (status) {
        c.BCWMUX_OK => "ok",
        c.BCWMUX_INVALID_ARGUMENT => "invalid_argument",
        c.BCWMUX_OUT_OF_MEMORY => "out_of_memory",
        c.BCWMUX_CLOSED => "closed",
        c.BCWMUX_BUSY => "busy",
        c.BCWMUX_PROTOCOL_ERROR => "protocol_error",
        c.BCWMUX_QUEUE_OVERFLOW => "queue_overflow",
        c.BCWMUX_NOT_READY => "not_ready",
        c.BCWMUX_SHUTTING_DOWN => "shutting_down",
        c.BCWMUX_INTERNAL => "internal",
        c.BCWMUX_TOO_LARGE => "too_large",
        c.BCWMUX_NOT_FOUND => "not_found",
        c.BCWMUX_WOULD_BLOCK => "would_block",
        else => "unknown",
    };
}

test "bounded C transport queue reports overflow and preserves ownership" {
    var queue = SessionSocket.MessageQueue.init(std.testing.allocator, 4, 4);
    defer queue.deinit();
    try queue.push("1234");
    try std.testing.expectError(error.QueueOverflow, queue.push("x"));
    try std.testing.expect(queue.isOverflowed());
    const first = queue.pop().?;
    defer std.testing.allocator.free(first.data);
    try std.testing.expectEqualStrings("1234", first.data);
}

test "transport managed heartbeat is observational and standalone policy remains explicit" {
    var config = std.mem.zeroes(CEngineConfig);
    config.abi_version = abi_version;
    config.worker_path = "/bin/true";
    config.worker_path_len = "/bin/true".len;
    config.shell = "/bin/sh";
    config.shell_len = "/bin/sh".len;
    var engine: ?*Engine = null;
    try std.testing.expectEqual(@as(CStatus, c.BCWMUX_OK), bcwebmux_engine_open(&config, &engine));
    defer _ = bcwebmux_engine_close(engine);

    var managed: ?*Socket = null;
    try std.testing.expectEqual(@as(CStatus, c.BCWMUX_OK), bcwebmux_socket_open(engine, null, &managed));
    defer _ = bcwebmux_socket_close(managed);
    try std.testing.expectEqual(@as(CStatus, c.BCWMUX_INVALID_ARGUMENT), bcwebmux_socket_set_transport_managed(managed, 2));
    try std.testing.expectEqual(@as(CStatus, c.BCWMUX_OK), bcwebmux_socket_set_transport_managed(managed, 1));
    // Inject elapsed native time, not a sleep or a dependency on machine uptime.
    // Negotiation framing is covered by the Go cgo ownership tests.
    managed.?.session.negotiated = true;
    managed.?.session.last_pong_ms -= manifest.heartbeat_timeout_ms + 1;
    managed.?.session.last_ping_ms -= manifest.heartbeat_interval_ms + 1;
    try std.testing.expectEqual(@as(CStatus, c.BCWMUX_OK), bcwebmux_socket_tick(managed));
    try std.testing.expectEqual(@as(CStatus, c.BCWMUX_INVALID_ARGUMENT), bcwebmux_socket_set_transport_managed(managed, 0));
    var message: CMessage = std.mem.zeroes(CMessage);
    try std.testing.expectEqual(@as(CStatus, c.BCWMUX_OK), bcwebmux_socket_drain(managed, &message));
    const ping = try protocol.decodeFrame(message.data[0..message.len]);
    try std.testing.expectEqual(protocol.FrameType.ping, ping.frame_type);
    var pong_payload: [8]u8 = undefined;
    @memcpy(&pong_payload, ping.payload);
    bcwebmux_message_free(&message);
    // A second interval cannot supersede an outstanding nonce, even when the
    // old fatal native response window has elapsed on a Go-managed transport.
    managed.?.session.last_ping_ms -= manifest.heartbeat_interval_ms + 1;
    try std.testing.expectEqual(@as(CStatus, c.BCWMUX_OK), bcwebmux_socket_tick(managed));
    try std.testing.expectEqual(@as(CStatus, c.BCWMUX_WOULD_BLOCK), bcwebmux_socket_drain(managed, &message));
    var wire: [protocol.header_length + 8]u8 = undefined;
    const pong = try protocol.encodeFrame(.{ .frame_type = .pong, .connection_sequence = 1, .payload = &pong_payload }, &wire);
    try std.testing.expectEqual(@as(CStatus, c.BCWMUX_OK), bcwebmux_socket_receive_binary(managed, pong.ptr, pong.len));
    // Duplicate/old responses remain structurally valid and are not fatal.
    const old_pong = try protocol.encodeFrame(.{ .frame_type = .pong, .connection_sequence = 2, .payload = &pong_payload }, &wire);
    try std.testing.expectEqual(@as(CStatus, c.BCWMUX_OK), bcwebmux_socket_receive_binary(managed, old_pong.ptr, old_pong.len));

    var standalone: ?*Socket = null;
    try std.testing.expectEqual(@as(CStatus, c.BCWMUX_OK), bcwebmux_socket_open(engine, null, &standalone));
    defer _ = bcwebmux_socket_close(standalone);
    try std.testing.expect(!standalone.?.session.transport_managed);
    standalone.?.session.negotiated = true;
    standalone.?.session.last_pong_ms -= manifest.heartbeat_timeout_ms + 1;
    try std.testing.expectEqual(@as(CStatus, c.BCWMUX_INTERNAL), bcwebmux_socket_tick(standalone));
    try std.testing.expectEqual(@as(CStatus, c.BCWMUX_CLOSED), bcwebmux_socket_tick(standalone));
}
