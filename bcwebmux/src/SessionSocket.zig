// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");
const protocol = @import("protocol.zig");
const Session = @import("Session.zig");
const Registry = @import("SessionRegistry.zig");
const realtime = @import("session_realtime.zig");
const manifest = @import("session_manifest.zig");
const c = @cImport(@cInclude("zstd.h"));

const Self = @This();
const zero_id: Session.Id = .{0} ** 16;
const event_prefix_length = 32;
const checkpoint_chunk_prefix_length = 16;

const ErrorCode = enum(u16) {
    protocol_error = 1,
    incompatible_abi = 2,
    session_not_found = 3,
    attachment_limit = 4,
    invalid_attachment = 5,
    replay_unavailable = 6,
    flow_control = 7,
    lease_lost = 8,
    stale_terminal = 9,
    invalid_input = 10,
    internal = 11,
};

const InputStatus = enum(u16) { accepted = 0, duplicate = 1, lease_lost = 2, stale = 3, not_running = 4, invalid = 5 };

// Private, bounded per-connection bookkeeping; wire identity is session_id plus
// attachment key/epoch, never the array index.
const ConnectionAttachment = struct {
    active: bool = false,
    live: bool = false,
    exit_sent: bool = false,
    session_id: Session.Id = zero_id,
    key: Session.AttachmentKey = .{ .connection_id = 0, .attachment_id = 0, .epoch = 0 },
    event_seq: u64 = 0,
    output_offset: u64 = 0,
    credit: usize = 0,
    lease_seen: u64 = 0,
    last_claim_request: u64 = 0,
    last_resize_request: u64 = 0,
    last_resize_operation: u64 = 0,
    last_resize_payload: [24]u8 = .{0} ** 24,
};

allocator: std.mem.Allocator,
io: std.Io,
registry: *Registry,
websocket: *std.http.Server.WebSocket,
connection_id: u64,
client_id: Session.Id = zero_id,
state_mutex: std.Io.Mutex = .init,
send_mutex: std.Io.Mutex = .init,
attachments: [manifest.max_connection_attachments]ConnectionAttachment = [_]ConnectionAttachment{.{}} ** manifest.max_connection_attachments,
sender_sequence: u64 = 0,
receiver_sequence: u64 = 0,
last_pong_ms: i64,
last_ping_ms: i64,
revision_seen: u64,
stopped: std.atomic.Value(bool) = .init(false),

pub fn init(
    allocator: std.mem.Allocator,
    io: std.Io,
    registry: *Registry,
    websocket: *std.http.Server.WebSocket,
) !Self {
    var random: [8]u8 = undefined;
    try io.randomSecure(&random);
    var connection_id = std.mem.readInt(u64, &random, .little);
    if (connection_id == 0) connection_id = 1;
    const now = monotonicMs(io);
    return .{
        .allocator = allocator,
        .io = io,
        .registry = registry,
        .websocket = websocket,
        .connection_id = connection_id,
        .last_pong_ms = now,
        .last_ping_ms = now,
        .revision_seen = registry.currentRevision(),
    };
}

pub fn serve(self: *Self) !void {
    defer self.stopAndDetach();
    try self.negotiate();
    var publisher = try self.io.concurrent(publishLoop, .{self});
    defer publisher.cancel(self.io);
    while (!self.stopped.load(.acquire)) {
        const message = self.websocket.readSmallMessage() catch return;
        switch (message.opcode) {
            .ping => try self.sendWebSocketControl(message.data, .pong),
            .binary => try self.receiveFrame(message.data),
            else => return error.UnexpectedWebSocketMessage,
        }
    }
}

fn negotiate(self: *Self) !void {
    const message = try self.websocket.readSmallMessage();
    if (message.opcode != .binary) return error.HelloRequired;
    const frame = protocol.decodeFrame(message.data) catch return error.InvalidFrame;
    try self.acceptSequence(frame.connection_sequence);
    if (frame.frame_type != .hello or frame.request_id == 0 or frame.payload.len != 56 or frame.attachment_id != 0 or
        frame.attachment_epoch != 0 or !std.mem.eql(u8, &frame.session_id, &zero_id)) return error.HelloRequired;
    @memcpy(&self.client_id, frame.payload[0..16]);
    if (idIsZero(self.client_id)) return error.InvalidHello;
    var expected_abi: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(manifest.terminal_abi, &expected_abi, .{});
    if (!std.mem.eql(u8, frame.payload[16..48], &expected_abi)) {
        try self.sendError(.incompatible_abi, true, frame.request_id, zero_id, 0, 0, "terminal ABI mismatch; reload/update required");
        return error.IncompatibleTerminalAbi;
    }
    const requested_credit = protocol.readU32LE(frame.payload, 48);
    const requested_frame = protocol.readU32LE(frame.payload, 52);
    if (requested_credit == 0 or requested_credit > manifest.max_credit_bytes or
        requested_frame < protocol.header_length or requested_frame > protocol.max_frame_length) return error.InvalidHello;
    try self.sendWelcome(frame.request_id);
}

fn receiveFrame(self: *Self, bytes: []const u8) !void {
    const frame = protocol.decodeFrame(bytes) catch {
        try self.sendError(.protocol_error, true, 0, zero_id, 0, 0, "invalid frame");
        return error.InvalidFrame;
    };
    try self.acceptSequence(frame.connection_sequence);
    switch (frame.frame_type) {
        .attach => try self.receiveAttach(frame),
        .detach => try self.receiveDetach(frame),
        .ack => try self.receiveAck(frame),
        .credit => try self.receiveCredit(frame),
        .claim_control => try self.receiveClaim(frame),
        .input => try self.receiveInput(frame),
        .resize_request => try self.receiveResize(frame),
        .pong => try self.receivePong(frame),
        .ping => try self.receivePing(frame),
        else => {
            try self.sendError(.protocol_error, true, frame.request_id, frame.session_id, frame.attachment_id, frame.attachment_epoch, "client frame type is not allowed");
            return error.InvalidClientFrame;
        },
    }
}

fn receiveAttach(self: *Self, frame: protocol.Frame) !void {
    if (frame.payload.len != 40 or frame.request_id == 0 or frame.attachment_id == 0 or frame.attachment_epoch != 0 or idIsZero(frame.session_id))
        return self.sendError(.invalid_attachment, false, frame.request_id, frame.session_id, frame.attachment_id, 0, "invalid attach");
    var generation: Session.Id = undefined;
    @memcpy(&generation, frame.payload[0..16]);
    const event_seq = protocol.readU64LE(frame.payload, 16);
    const output_offset = protocol.readU64LE(frame.payload, 24);
    const credit: usize = protocol.readU32LE(frame.payload, 32);
    if (credit == 0 or credit > manifest.max_credit_bytes or protocol.readU32LE(frame.payload, 36) != 0)
        return self.sendError(.flow_control, false, frame.request_id, frame.session_id, frame.attachment_id, 0, "invalid attachment credit");
    var replay = self.registry.realtimeAttach(
        self.connection_id,
        self.client_id,
        frame.session_id,
        frame.attachment_id,
        generation,
        event_seq,
        output_offset,
    ) catch |err| {
        const code: ErrorCode = switch (err) {
            error.SessionNotFound => .session_not_found,
            error.AttachmentLimit => .attachment_limit,
            error.ReplayUnavailable => .replay_unavailable,
            else => .invalid_attachment,
        };
        return self.sendError(code, false, frame.request_id, frame.session_id, frame.attachment_id, 0, @errorName(err));
    };
    defer replay.deinit();
    const index = self.reserveAttachment(frame.session_id, replay.key, credit, replay.lease.epoch) catch |err| {
        _ = self.registry.realtimeDetach(frame.session_id, replay.key) catch {};
        return self.sendError(.attachment_limit, false, frame.request_id, frame.session_id, frame.attachment_id, replay.key.epoch, @errorName(err));
    };
    errdefer self.detachIndex(index);
    const replay_credit_cost = replayCreditCost(&replay);
    if (replay_credit_cost > credit) {
        self.detachIndex(index);
        return self.sendError(.flow_control, false, frame.request_id, frame.session_id, frame.attachment_id, replay.key.epoch, "initial credit is insufficient for replay");
    }
    try self.sendReplay(index, frame.request_id, &replay);
    self.state_mutex.lockUncancelable(self.io);
    if (self.attachments[index].active and self.attachments[index].key.epoch == replay.key.epoch) {
        self.attachments[index].event_seq = replay.high_event_seq;
        self.attachments[index].output_offset = replay.high_output_offset;
        self.attachments[index].live = true;
    }
    self.state_mutex.unlock(self.io);
}

fn receiveDetach(self: *Self, frame: protocol.Frame) !void {
    if (frame.payload.len != 0 or frame.request_id == 0) return error.InvalidDetach;
    const index = self.findSlot(frame.session_id, frame.attachment_id, frame.attachment_epoch) orelse return;
    self.detachIndex(index);
}

fn receiveAck(self: *Self, frame: protocol.Frame) !void {
    if (frame.payload.len != 24 or frame.request_id != 0 or protocol.readU32LE(frame.payload, 20) != 0) return error.InvalidAck;
    const event_seq = protocol.readU64LE(frame.payload, 0);
    const output_offset = protocol.readU64LE(frame.payload, 8);
    const credit: usize = protocol.readU32LE(frame.payload, 16);
    if (credit > manifest.max_credit_bytes) return error.InvalidAck;
    const index = self.findSlot(frame.session_id, frame.attachment_id, frame.attachment_epoch) orelse return;
    const slot = self.slotSnapshot(index) orelse return;
    if (event_seq > slot.event_seq or (event_seq == slot.event_seq and output_offset > slot.output_offset)) {
        try self.sendError(.protocol_error, false, frame.request_id, frame.session_id, frame.attachment_id, frame.attachment_epoch, "acknowledges unsent data");
        return;
    }
    self.registry.realtimeAck(slot.session_id, slot.key, event_seq, output_offset) catch return;
    self.addCredit(index, credit);
}

fn receiveCredit(self: *Self, frame: protocol.Frame) !void {
    if (frame.payload.len != 8 or frame.request_id != 0 or protocol.readU32LE(frame.payload, 4) != 0) return error.InvalidCredit;
    const credit: usize = protocol.readU32LE(frame.payload, 0);
    if (credit == 0 or credit > manifest.max_credit_bytes) return error.InvalidCredit;
    const index = self.findSlot(frame.session_id, frame.attachment_id, frame.attachment_epoch) orelse return;
    self.addCredit(index, credit);
}

fn receiveClaim(self: *Self, frame: protocol.Frame) !void {
    if (frame.payload.len != 0 or frame.request_id == 0) return error.InvalidClaim;
    const index = self.findSlot(frame.session_id, frame.attachment_id, frame.attachment_epoch) orelse return;
    const slot = self.slotSnapshot(index) orelse return;
    if (slot.last_claim_request == frame.request_id) {
        const lease = self.registry.realtimeLease(slot.session_id, slot.key) catch |err| {
            return self.sendError(.invalid_attachment, false, frame.request_id, frame.session_id, frame.attachment_id, frame.attachment_epoch, @errorName(err));
        };
        try self.sendLease(frame.request_id, slot, lease);
        return;
    }
    const lease = self.registry.realtimeClaim(slot.session_id, slot.key) catch |err| {
        return self.sendError(.invalid_attachment, false, frame.request_id, frame.session_id, frame.attachment_id, frame.attachment_epoch, @errorName(err));
    };
    self.setClaimRequest(index, slot.key.epoch, frame.request_id);
    self.setLeaseSeen(index, lease.epoch);
    try self.sendLease(frame.request_id, slot, lease);
}

fn receiveInput(self: *Self, frame: protocol.Frame) !void {
    if (frame.payload.len < 25 or frame.request_id == 0) return error.InvalidInput;
    const index = self.findSlot(frame.session_id, frame.attachment_id, frame.attachment_epoch) orelse return;
    const slot = self.slotSnapshot(index) orelse return;
    const lease_epoch = protocol.readU64LE(frame.payload, 0);
    const based_event_seq = protocol.readU64LE(frame.payload, 8);
    const input_seq = protocol.readU64LE(frame.payload, 16);
    const result = self.registry.realtimeInput(slot.session_id, slot.key, lease_epoch, based_event_seq, input_seq, frame.payload[24..]);
    const status: InputStatus = if (result) |accepted|
        if (accepted == .accepted) .accepted else .duplicate
    else |err| switch (err) {
        error.LeaseLost => .lease_lost,
        error.StaleTerminal, error.StaleInput => .stale,
        error.SessionNotRunning => .not_running,
        else => .invalid,
    };
    var payload: [12]u8 = .{0} ** 12;
    protocol.writeU64LE(&payload, 0, input_seq);
    protocol.writeU16LE(&payload, 8, @intFromEnum(status));
    try self.sendParts(.input_ack, 0, frame.request_id, frame.attachment_id, frame.attachment_epoch, frame.session_id, &.{&payload});
}

fn receiveResize(self: *Self, frame: protocol.Frame) !void {
    if (frame.payload.len != 24 or frame.request_id == 0) return error.InvalidResize;
    const index = self.findSlot(frame.session_id, frame.attachment_id, frame.attachment_epoch) orelse return;
    const slot = self.slotSnapshot(index) orelse return;
    if (slot.last_resize_request == frame.request_id) {
        if (!std.mem.eql(u8, slot.last_resize_payload[0..], frame.payload)) {
            try self.sendError(.protocol_error, false, frame.request_id, frame.session_id, frame.attachment_id, frame.attachment_epoch, "idempotency conflict");
            return;
        }
        try self.sendResizeAccepted(frame, slot.last_resize_operation, readGeometry(slot.last_resize_payload[16..24]));
        return;
    }
    const lease_epoch = protocol.readU64LE(frame.payload, 0);
    const based_event_seq = protocol.readU64LE(frame.payload, 8);
    const geometry = readGeometry(frame.payload[16..24]);
    const operation_id = self.registry.realtimeResize(slot.session_id, slot.key, lease_epoch, based_event_seq, geometry) catch |err| {
        const code: ErrorCode = switch (err) {
            error.LeaseLost => .lease_lost,
            error.StaleTerminal => .stale_terminal,
            else => .invalid_attachment,
        };
        return self.sendError(code, false, frame.request_id, frame.session_id, frame.attachment_id, frame.attachment_epoch, @errorName(err));
    };
    self.setResizeRequest(index, slot.key.epoch, frame.request_id, operation_id, frame.payload);
    try self.sendResizeAccepted(frame, operation_id, geometry);
}

fn sendResizeAccepted(self: *Self, frame: protocol.Frame, operation_id: u64, geometry: Session.Geometry) !void {
    var payload: [24]u8 = undefined;
    protocol.writeU64LE(&payload, 0, protocol.readU64LE(frame.payload, 0));
    protocol.writeU64LE(&payload, 8, operation_id);
    writeGeometry(payload[16..24], geometry);
    try self.sendParts(.canonical_resize, 0, frame.request_id, frame.attachment_id, frame.attachment_epoch, frame.session_id, &.{&payload});
}

fn receivePong(self: *Self, frame: protocol.Frame) !void {
    if (frame.payload.len != 8 or frame.request_id != 0 or frame.attachment_id != 0 or frame.attachment_epoch != 0 or !idIsZero(frame.session_id))
        return error.InvalidPong;
    const ping_ms: i64 = @bitCast(protocol.readU64LE(frame.payload, 0));
    self.state_mutex.lockUncancelable(self.io);
    if (ping_ms != self.last_ping_ms) {
        self.state_mutex.unlock(self.io);
        return error.InvalidPong;
    }
    self.last_pong_ms = monotonicMs(self.io);
    self.state_mutex.unlock(self.io);
}

fn receivePing(self: *Self, frame: protocol.Frame) !void {
    if (frame.payload.len != 8 or frame.request_id == 0 or protocol.readU64LE(frame.payload, 0) != frame.request_id or frame.attachment_id != 0 or frame.attachment_epoch != 0 or !idIsZero(frame.session_id))
        return error.InvalidPing;
    try self.sendParts(.pong, 0, frame.request_id, 0, 0, zero_id, &.{frame.payload});
}

fn sendReplay(self: *Self, index: usize, request_id: u64, replay: *const realtime.Replay) !void {
    const slot = self.slotSnapshot(index) orelse return;
    var begin: [80]u8 = .{0} ** 80;
    @memcpy(begin[0..16], &replay.generation);
    begin[16] = @intFromEnum(replay.mode);
    begin[17] = @intFromEnum(replay.state);
    writeGeometry(begin[20..28], replay.geometry);
    writeGeometry(begin[28..36], replay.replay_geometry);
    protocol.writeU64LE(&begin, 48, replay.high_event_seq);
    protocol.writeU64LE(&begin, 56, replay.high_output_offset);
    protocol.writeU64LE(&begin, 64, replay.lease.epoch);
    protocol.writeU64LE(&begin, 72, replay.lease.controller_attachment_id orelse 0);
    try self.sendParts(.attach_begin, 0, request_id, replay.key.attachment_id, replay.key.epoch, slot.session_id, &.{&begin});
    if (replay.mode == .checkpoint) try self.sendCheckpoint(index, slot.session_id, replay);
    for (replay.events) |event| try self.sendEvent(index, replay.key, slot.session_id, event, replay.output(event));
    var barrier: [16]u8 = undefined;
    protocol.writeU64LE(&barrier, 0, replay.high_event_seq);
    protocol.writeU64LE(&barrier, 8, replay.high_output_offset);
    try self.sendParts(.live_barrier, 0, request_id, replay.key.attachment_id, replay.key.epoch, slot.session_id, &.{&barrier});
}

fn sendCheckpoint(self: *Self, index: usize, session_id: Session.Id, replay: *const realtime.Replay) !void {
    var begin: [56]u8 = undefined;
    protocol.writeU32LE(&begin, 0, @intCast(replay.checkpoint.len));
    protocol.writeU32LE(&begin, 4, manifest.checkpoint_chunk_bytes);
    protocol.writeU64LE(&begin, 8, replay.checkpoint_event_seq);
    protocol.writeU64LE(&begin, 16, replay.checkpoint_output_offset);
    @memcpy(begin[24..56], &replay.checkpoint_sha256);
    try self.sendParts(.checkpoint_begin, 0, 0, replay.key.attachment_id, replay.key.epoch, session_id, &.{&begin});
    var offset: usize = 0;
    while (offset < replay.checkpoint.len) {
        const raw = replay.checkpoint[offset..][0..@min(manifest.checkpoint_chunk_bytes, replay.checkpoint.len - offset)];
        try self.consumeCredit(index, replay.key, raw.len + protocol.header_length + checkpoint_chunk_prefix_length);
        const compressed = try compress(self.allocator, raw);
        defer self.allocator.free(compressed);
        var prefix: [checkpoint_chunk_prefix_length]u8 = undefined;
        protocol.writeU32LE(&prefix, 0, @intCast(offset));
        protocol.writeU32LE(&prefix, 4, @intCast(raw.len));
        protocol.writeU32LE(&prefix, 8, std.hash.crc.Crc32Iscsi.hash(raw));
        protocol.writeU32LE(&prefix, 12, @intCast(compressed.len));
        try self.sendParts(.checkpoint_chunk, protocol.compressed_flag, 0, replay.key.attachment_id, replay.key.epoch, session_id, &.{ &prefix, compressed });
        offset += raw.len;
    }
    try self.sendParts(.checkpoint_end, 0, 0, replay.key.attachment_id, replay.key.epoch, session_id, &.{&replay.checkpoint_sha256});
}

fn sendEvent(self: *Self, index: usize, key: Session.AttachmentKey, session_id: Session.Id, event: Session.Event, output: []const u8) !void {
    var prefix: [event_prefix_length]u8 = .{0} ** event_prefix_length;
    prefix[0] = @intFromEnum(event.kind);
    protocol.writeU64LE(&prefix, 16, event.seq);
    protocol.writeU64LE(&prefix, 24, event.output_offset);
    switch (event.kind) {
        .output => {
            try self.consumeCredit(index, key, output.len + protocol.header_length + event_prefix_length);
            const compressed = try compress(self.allocator, output);
            defer self.allocator.free(compressed);
            protocol.writeU32LE(&prefix, 4, @intCast(output.len));
            protocol.writeU32LE(&prefix, 8, event.crc32c);
            protocol.writeU32LE(&prefix, 12, @intCast(compressed.len));
            try self.sendParts(.event_batch, protocol.compressed_flag, 0, key.attachment_id, key.epoch, session_id, &.{ &prefix, compressed });
        },
        .resize => {
            try self.consumeCredit(index, key, 128);
            protocol.writeU32LE(&prefix, 4, 8);
            protocol.writeU32LE(&prefix, 12, 8);
            var geometry: [8]u8 = undefined;
            writeGeometry(&geometry, .{ .cols = event.cols, .rows = event.rows, .cell_width_px = event.cell_width_px, .cell_height_px = event.cell_height_px });
            try self.sendParts(.event_batch, 0, 0, key.attachment_id, key.epoch, session_id, &.{ &prefix, &geometry });
        },
        .exit => {
            try self.consumeCredit(index, key, 128);
            protocol.writeU32LE(&prefix, 4, 12);
            protocol.writeU32LE(&prefix, 12, 12);
            var body: [12]u8 = undefined;
            protocol.writeU32LE(&body, 0, @bitCast(event.wait_status));
            protocol.writeU64LE(&body, 4, @bitCast(event.timestamp_ms));
            try self.sendParts(.event_batch, 0, 0, key.attachment_id, key.epoch, session_id, &.{ &prefix, &body });
        },
    }
}

fn sendWelcome(self: *Self, request_id: u64) !void {
    var payload: [88]u8 = .{0} ** 88;
    @memcpy(payload[0..16], &self.registry.server_instance);
    std.crypto.hash.sha2.Sha256.hash(manifest.terminal_abi, payload[16..48], .{});
    protocol.writeU32LE(&payload, 48, @intCast(protocol.max_frame_length));
    protocol.writeU32LE(&payload, 52, @intCast(self.registry.limits.max_checkpoint_bytes));
    protocol.writeU32LE(&payload, 56, @intCast(manifest.max_credit_bytes));
    protocol.writeU32LE(&payload, 60, @intCast(manifest.heartbeat_interval_ms));
    protocol.writeU32LE(&payload, 64, @intCast(manifest.heartbeat_timeout_ms));
    protocol.writeU16LE(&payload, 68, @intCast(manifest.max_connection_attachments));
    protocol.writeU64LE(&payload, 72, self.registry.currentRevision());
    protocol.writeU64LE(&payload, 80, self.connection_id);
    try self.sendParts(.welcome, 0, request_id, 0, 0, zero_id, &.{&payload});
}

fn sendError(self: *Self, code: ErrorCode, fatal: bool, request_id: u64, session_id: Session.Id, attachment_id: u64, epoch: u64, detail: []const u8) !void {
    var prefix: [4]u8 = .{0} ** 4;
    protocol.writeU16LE(&prefix, 0, @intFromEnum(code));
    protocol.writeU16LE(&prefix, 2, @intFromBool(fatal));
    const bounded = detail[0..@min(detail.len, 512)];
    try self.sendParts(.error_frame, 0, request_id, attachment_id, epoch, session_id, &.{ &prefix, bounded });
    if (fatal) self.stopped.store(true, .release);
}

fn sendLease(self: *Self, request_id: u64, attachment: ConnectionAttachment, lease: Session.LeaseState) !void {
    var payload: [24]u8 = undefined;
    protocol.writeU64LE(&payload, 0, lease.epoch);
    protocol.writeU64LE(&payload, 8, lease.controller_attachment_id orelse 0);
    writeGeometry(payload[16..24], lease.geometry);
    try self.sendParts(.lease_changed, 0, request_id, attachment.key.attachment_id, attachment.key.epoch, attachment.session_id, &.{&payload});
}

fn sendParts(
    self: *Self,
    frame_type: protocol.FrameType,
    flags: u8,
    request_id: u64,
    attachment_id: u64,
    attachment_epoch: u64,
    session_id: Session.Id,
    parts: []const []const u8,
) !void {
    var payload_length: usize = 0;
    for (parts) |part| payload_length = std.math.add(usize, payload_length, part.len) catch return error.FrameTooLarge;
    if (payload_length > protocol.max_payload_length or parts.len > 7) return error.FrameTooLarge;
    try self.send_mutex.lock(self.io);
    defer self.send_mutex.unlock(self.io);
    self.sender_sequence = std.math.add(u64, self.sender_sequence, 1) catch return error.SequenceExhausted;
    var header: [protocol.header_length]u8 = undefined;
    _ = try protocol.encodeFrame(.{
        .frame_type = frame_type,
        .flags = flags,
        .connection_sequence = self.sender_sequence,
        .request_id = request_id,
        .attachment_id = attachment_id,
        .attachment_epoch = attachment_epoch,
        .session_id = session_id,
    }, &header);
    protocol.writeU32LE(&header, protocol.payload_length_offset, @intCast(payload_length));
    var vectors: [8][]const u8 = undefined;
    vectors[0] = &header;
    for (parts, 1..) |part, index| vectors[index] = part;
    try self.websocket.writeMessageVec(vectors[0 .. parts.len + 1], .binary);
}

fn sendWebSocketControl(self: *Self, data: []const u8, opcode: std.http.Server.WebSocket.Opcode) !void {
    try self.send_mutex.lock(self.io);
    defer self.send_mutex.unlock(self.io);
    try self.websocket.writeMessage(data, opcode);
}

fn publishLoop(self: *Self) void {
    while (!self.stopped.load(.acquire)) {
        self.publishControl() catch {
            self.stopped.store(true, .release);
            _ = self.sendWebSocketControl(&.{}, .connection_close) catch {};
            return;
        };
        for (0..self.attachments.len) |index| self.publishSlot(index) catch |err| {
            if (err == error.StaleAttachment) continue;
            self.stopped.store(true, .release);
            _ = self.sendWebSocketControl(&.{}, .connection_close) catch {};
            return;
        };
        self.io.sleep(.fromMilliseconds(manifest.publish_interval_ms), .awake) catch return;
    }
}

fn publishControl(self: *Self) !void {
    const now = monotonicMs(self.io);
    var send_ping = false;
    self.state_mutex.lockUncancelable(self.io);
    if (now - self.last_pong_ms >= manifest.heartbeat_timeout_ms) {
        self.state_mutex.unlock(self.io);
        return error.HeartbeatTimeout;
    }
    if (now - self.last_ping_ms >= manifest.heartbeat_interval_ms) {
        self.last_ping_ms = now;
        send_ping = true;
    }
    const revision = self.registry.currentRevision();
    const send_revision = revision != self.revision_seen;
    if (send_revision) self.revision_seen = revision;
    self.state_mutex.unlock(self.io);
    if (send_ping) {
        var payload: [8]u8 = undefined;
        protocol.writeU64LE(&payload, 0, @bitCast(now));
        try self.sendParts(.ping, 0, 0, 0, 0, zero_id, &.{&payload});
    }
    if (send_revision) {
        var payload: [8]u8 = undefined;
        protocol.writeU64LE(&payload, 0, revision);
        try self.sendParts(.session_changed, 0, 0, 0, 0, zero_id, &.{&payload});
    }
}

fn publishSlot(self: *Self, index: usize) !void {
    const slot = self.slotSnapshot(index) orelse return;
    if (!slot.live or slot.credit < 1024) return;
    const lease = self.registry.realtimeLease(slot.session_id, slot.key) catch |err| switch (err) {
        error.AttachmentNotFound, error.SessionNotFound => return self.resyncAndDetach(index, slot),
    };
    if (lease.epoch != slot.lease_seen) {
        try self.sendLease(0, slot, lease);
        self.setLeaseSeen(index, lease.epoch);
    }
    var batch = self.registry.realtimeRead(
        slot.session_id,
        slot.key,
        slot.event_seq,
        slot.output_offset,
        @min(manifest.event_batch_bytes, slot.credit -| 512),
    ) catch |err| switch (err) {
        error.ResyncRequired, error.AttachmentNotFound => return self.resyncAndDetach(index, slot),
        error.BatchLimitTooSmall => return,
        else => return err,
    };
    defer batch.deinit();
    for (batch.events) |event| {
        const next_output_offset = event.output_offset + if (event.kind == .output) event.byte_len else 0;
        self.updateCursor(index, slot.key.epoch, event.seq, next_output_offset);
        try self.sendEvent(index, slot.key, slot.session_id, event, batch.output(event));
    }
    const metadata = self.registry.get(slot.session_id) orelse return;
    if ((metadata.state == .exited or metadata.state == .failed) and !slot.exit_sent) {
        var payload: [20]u8 = .{0} ** 20;
        protocol.writeU64LE(&payload, 0, metadata.event_seq);
        protocol.writeU32LE(&payload, 8, @bitCast(metadata.exit_status orelse -1));
        protocol.writeU64LE(&payload, 12, @bitCast(metadata.last_activity_ms));
        try self.sendParts(.exited, 0, 0, slot.key.attachment_id, slot.key.epoch, slot.session_id, &.{&payload});
        self.markExitSent(index, slot.key.epoch);
    }
}

fn resyncAndDetach(self: *Self, index: usize, slot: ConnectionAttachment) !void {
    const metadata = self.registry.get(slot.session_id);
    var payload: [16]u8 = .{0} ** 16;
    if (metadata) |value| {
        protocol.writeU64LE(&payload, 0, value.checkpoint_event_seq);
        protocol.writeU64LE(&payload, 8, value.output_offset);
    }
    try self.sendParts(.resync_required, 0, 0, slot.key.attachment_id, slot.key.epoch, slot.session_id, &.{&payload});
    self.detachIndex(index);
}

fn reserveAttachment(self: *Self, session_id: Session.Id, key: Session.AttachmentKey, credit: usize, lease_epoch: u64) !usize {
    self.state_mutex.lockUncancelable(self.io);
    defer self.state_mutex.unlock(self.io);
    for (&self.attachments, 0..) |*slot, index| {
        if (!slot.active) {
            slot.* = .{ .active = true, .session_id = session_id, .key = key, .credit = credit, .lease_seen = lease_epoch };
            return index;
        }
    }
    return error.ConnectionAttachmentLimit;
}

fn findSlot(self: *Self, session_id: Session.Id, attachment_id: u64, epoch: u64) ?usize {
    self.state_mutex.lockUncancelable(self.io);
    defer self.state_mutex.unlock(self.io);
    for (self.attachments, 0..) |slot, index| {
        if (slot.active and slot.key.attachment_id == attachment_id and slot.key.epoch == epoch and
            std.mem.eql(u8, &slot.session_id, &session_id)) return index;
    }
    return null;
}

fn slotSnapshot(self: *Self, index: usize) ?ConnectionAttachment {
    self.state_mutex.lockUncancelable(self.io);
    defer self.state_mutex.unlock(self.io);
    return if (self.attachments[index].active) self.attachments[index] else null;
}

fn detachIndex(self: *Self, index: usize) void {
    self.state_mutex.lockUncancelable(self.io);
    const slot = self.attachments[index];
    self.attachments[index] = .{};
    self.state_mutex.unlock(self.io);
    if (slot.active) _ = self.registry.realtimeDetach(slot.session_id, slot.key) catch {};
}

fn consumeCredit(self: *Self, index: usize, key: Session.AttachmentKey, amount: usize) !void {
    self.state_mutex.lockUncancelable(self.io);
    defer self.state_mutex.unlock(self.io);
    if (!self.attachments[index].active or !std.meta.eql(self.attachments[index].key, key)) return error.StaleAttachment;
    if (self.attachments[index].credit < amount) return error.FlowControlExhausted;
    self.attachments[index].credit -= amount;
}

fn addCredit(self: *Self, index: usize, amount: usize) void {
    self.state_mutex.lockUncancelable(self.io);
    defer self.state_mutex.unlock(self.io);
    if (!self.attachments[index].active) return;
    self.attachments[index].credit = @min(manifest.max_credit_bytes, self.attachments[index].credit +| amount);
}

fn setLeaseSeen(self: *Self, index: usize, epoch: u64) void {
    self.state_mutex.lockUncancelable(self.io);
    defer self.state_mutex.unlock(self.io);
    if (self.attachments[index].active) self.attachments[index].lease_seen = epoch;
}

fn setClaimRequest(self: *Self, index: usize, epoch: u64, request_id: u64) void {
    self.state_mutex.lockUncancelable(self.io);
    defer self.state_mutex.unlock(self.io);
    if (self.attachments[index].active and self.attachments[index].key.epoch == epoch) self.attachments[index].last_claim_request = request_id;
}

fn setResizeRequest(self: *Self, index: usize, epoch: u64, request_id: u64, operation_id: u64, payload: []const u8) void {
    self.state_mutex.lockUncancelable(self.io);
    defer self.state_mutex.unlock(self.io);
    if (!self.attachments[index].active or self.attachments[index].key.epoch != epoch) return;
    self.attachments[index].last_resize_request = request_id;
    self.attachments[index].last_resize_operation = operation_id;
    @memcpy(&self.attachments[index].last_resize_payload, payload);
}

fn updateCursor(self: *Self, index: usize, epoch: u64, event_seq: u64, output_offset: u64) void {
    self.state_mutex.lockUncancelable(self.io);
    defer self.state_mutex.unlock(self.io);
    if (!self.attachments[index].active or self.attachments[index].key.epoch != epoch) return;
    self.attachments[index].event_seq = event_seq;
    self.attachments[index].output_offset = output_offset;
}

fn markExitSent(self: *Self, index: usize, epoch: u64) void {
    self.state_mutex.lockUncancelable(self.io);
    defer self.state_mutex.unlock(self.io);
    if (self.attachments[index].active and self.attachments[index].key.epoch == epoch) self.attachments[index].exit_sent = true;
}

fn stopAndDetach(self: *Self) void {
    self.stopped.store(true, .release);
    for (0..self.attachments.len) |index| self.detachIndex(index);
}

fn acceptSequence(self: *Self, sequence: u64) !void {
    if (self.receiver_sequence == std.math.maxInt(u64)) return error.SequenceExhausted;
    if (sequence != self.receiver_sequence + 1) return error.InvalidConnectionSequence;
    self.receiver_sequence = sequence;
}

fn readGeometry(bytes: []const u8) Session.Geometry {
    return .{
        .cols = protocol.readU16LE(bytes, 0),
        .rows = protocol.readU16LE(bytes, 2),
        .cell_width_px = protocol.readU16LE(bytes, 4),
        .cell_height_px = protocol.readU16LE(bytes, 6),
    };
}

fn writeGeometry(bytes: []u8, geometry: Session.Geometry) void {
    protocol.writeU16LE(bytes, 0, geometry.cols);
    protocol.writeU16LE(bytes, 2, geometry.rows);
    protocol.writeU16LE(bytes, 4, geometry.cell_width_px);
    protocol.writeU16LE(bytes, 6, geometry.cell_height_px);
}

fn idIsZero(id: Session.Id) bool {
    return std.mem.eql(u8, &id, &zero_id);
}

fn compress(allocator: std.mem.Allocator, bytes: []const u8) ![]u8 {
    const bound = c.ZSTD_compressBound(bytes.len);
    const output = try allocator.alloc(u8, bound);
    errdefer allocator.free(output);
    const result = c.ZSTD_compress(output.ptr, output.len, bytes.ptr, bytes.len, 1);
    if (c.ZSTD_isError(result) != 0) return error.ZstdCompressionFailed;
    return allocator.realloc(output, result);
}

fn replayCreditCost(replay: *const realtime.Replay) usize {
    var total: usize = 0;
    var offset: usize = 0;
    while (offset < replay.checkpoint.len) {
        const raw_len = @min(manifest.checkpoint_chunk_bytes, replay.checkpoint.len - offset);
        total +|= raw_len +| protocol.header_length +| checkpoint_chunk_prefix_length;
        offset += raw_len;
    }
    for (replay.events) |event| {
        total +|= if (event.kind == .output)
            replay.output(event).len +| protocol.header_length +| event_prefix_length
        else
            128;
    }
    return total;
}

fn monotonicMs(io: std.Io) i64 {
    return std.Io.Clock.awake.now(io).toMilliseconds();
}
