// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");
const Session = @import("Session.zig");
const manifest = @import("session_manifest.zig");

pub const AttachMode = enum(u8) { reset = 0, checkpoint = 1, tail = 2 };

pub const Replay = struct {
    allocator: std.mem.Allocator,
    key: Session.AttachmentKey,
    mode: AttachMode,
    generation: Session.Id,
    geometry: Session.Geometry,
    replay_geometry: Session.Geometry,
    state: Session.State,
    checkpoint: []u8,
    checkpoint_sha256: [32]u8,
    checkpoint_event_seq: u64,
    checkpoint_output_offset: u64,
    high_event_seq: u64,
    high_output_offset: u64,
    events: []Session.Event,
    bytes: []u8,
    lease: Session.LeaseState,

    pub fn deinit(self: *Replay) void {
        self.allocator.free(self.checkpoint);
        self.allocator.free(self.events);
        self.allocator.free(self.bytes);
        self.* = undefined;
    }

    pub fn output(self: *const Replay, event: Session.Event) []const u8 {
        const start: usize = @intCast(event.byte_start);
        return self.bytes[start..][0..event.byte_len];
    }
};

pub const Batch = struct {
    allocator: std.mem.Allocator,
    events: []Session.Event,
    bytes: []u8,
    high_event_seq: u64,
    high_output_offset: u64,

    pub fn deinit(self: *Batch) void {
        self.allocator.free(self.events);
        self.allocator.free(self.bytes);
        self.* = undefined;
    }

    pub fn output(self: *const Batch, event: Session.Event) []const u8 {
        const start: usize = @intCast(event.byte_start);
        return self.bytes[start..][0..event.byte_len];
    }
};

pub const InputResult = enum { accepted, duplicate };

pub fn beginAttach(
    session: *Session,
    allocator: std.mem.Allocator,
    connection_id: u64,
    attachment_id: u64,
    client_id: Session.Id,
    generation: Session.Id,
    event_seq: u64,
    output_offset: u64,
) !Replay {
    if (connection_id == 0 or attachment_id == 0) return error.InvalidAttachment;
    session.mutex.lockUncancelable(session.io);
    defer session.mutex.unlock(session.io);
    if (session.attachment_count >= session.limits.max_attachments_per_session) return error.AttachmentLimit;
    if (findByConnectionAttachment(session, connection_id, attachment_id) != null) return error.AttachmentExists;
    const slot_index = freeSlot(session) orelse return error.AttachmentLimit;
    const high_event_seq = session.next_event_seq -| 1;
    const generation_matches = std.mem.eql(u8, &generation, &session.generation);
    const resumable = generation_matches and cursorAvailable(session, event_seq, output_offset);
    const mode: AttachMode = if (resumable)
        .tail
    else if (session.current_checkpoint != null)
        .checkpoint
    else
        .reset;
    const replay_start = switch (mode) {
        .tail => event_seq,
        .checkpoint => session.current_checkpoint.?.event_seq,
        .reset => 0,
    };
    if (!cursorAvailable(session, replay_start, switch (mode) {
        .tail => output_offset,
        .checkpoint => session.current_checkpoint.?.output_offset,
        .reset => 0,
    })) return error.ReplayUnavailable;

    var copied = try copyEventsAfter(session, allocator, replay_start, std.math.maxInt(usize));
    errdefer copied.deinit();
    const checkpoint = if (mode == .checkpoint)
        try allocator.dupe(u8, session.current_checkpoint.?.bytes)
    else
        try allocator.alloc(u8, 0);
    errdefer allocator.free(checkpoint);
    const epoch = session.next_attachment_epoch;
    session.next_attachment_epoch = std.math.add(u64, epoch, 1) catch return error.EpochExhausted;
    session.activity_order +%= 1;
    const key: Session.AttachmentKey = .{
        .connection_id = connection_id,
        .attachment_id = attachment_id,
        .epoch = epoch,
    };
    session.attachments[slot_index] = .{
        .active = true,
        .key = key,
        .client_id = client_id,
        .activity_order = session.activity_order,
        .barrier_event_seq = high_event_seq,
        .barrier_output_offset = session.output_offset,
        .live = false,
        .acknowledged_event_seq = replay_start,
        .acknowledged_output_offset = switch (mode) {
            .tail => output_offset,
            .checkpoint => session.current_checkpoint.?.output_offset,
            .reset => 0,
        },
    };
    session.attachment_count += 1;
    session.bumpRevision();
    return .{
        .allocator = allocator,
        .key = key,
        .mode = mode,
        .generation = session.generation,
        .geometry = session.geometry,
        .replay_geometry = session.initial_geometry,
        .state = session.state,
        .checkpoint = checkpoint,
        .checkpoint_sha256 = if (session.current_checkpoint) |value| value.sha256 else .{0} ** 32,
        .checkpoint_event_seq = if (session.current_checkpoint) |value| value.event_seq else 0,
        .checkpoint_output_offset = if (session.current_checkpoint) |value| value.output_offset else 0,
        .high_event_seq = high_event_seq,
        .high_output_offset = session.output_offset,
        .events = copied.events,
        .bytes = copied.bytes,
        .lease = leaseStateLocked(session),
    };
}

pub fn readAfter(
    session: *Session,
    allocator: std.mem.Allocator,
    key: Session.AttachmentKey,
    event_seq: u64,
    output_offset: u64,
    max_bytes: usize,
) !Batch {
    session.mutex.lockUncancelable(session.io);
    defer session.mutex.unlock(session.io);
    _ = findSlot(session, key) orelse return error.AttachmentNotFound;
    if (!cursorAvailable(session, event_seq, output_offset)) return error.ResyncRequired;
    return copyEventsAfter(session, allocator, event_seq, max_bytes);
}

pub fn acknowledge(session: *Session, key: Session.AttachmentKey, event_seq: u64, output_offset: u64) !void {
    session.mutex.lockUncancelable(session.io);
    defer session.mutex.unlock(session.io);
    const index = findSlot(session, key) orelse return error.AttachmentNotFound;
    if (!cursorAvailable(session, event_seq, output_offset)) return error.InvalidCursor;
    if (event_seq < session.attachments[index].acknowledged_event_seq or
        output_offset < session.attachments[index].acknowledged_output_offset) return error.StaleCursor;
    session.attachments[index].acknowledged_event_seq = event_seq;
    session.attachments[index].acknowledged_output_offset = output_offset;
    if (event_seq == session.attachments[index].barrier_event_seq and
        output_offset == session.attachments[index].barrier_output_offset) session.attachments[index].live = true;
}

pub fn detach(session: *Session, key: Session.AttachmentKey) Session.LeaseState {
    session.mutex.lockUncancelable(session.io);
    defer session.mutex.unlock(session.io);
    const index = findSlot(session, key) orelse return leaseStateLocked(session);
    const controlled = keyEqual(session.controller_key, key);
    session.attachments[index] = .{};
    session.attachment_count -= 1;
    if (controlled) {
        if (session.pending_resize_count != 0)
            session.invalidateControllerLocked()
        else
            session.promoteControllerLocked();
    }
    session.bumpRevision();
    return leaseStateLocked(session);
}

pub fn claimControl(session: *Session, key: Session.AttachmentKey) !Session.LeaseState {
    session.mutex.lockUncancelable(session.io);
    defer session.mutex.unlock(session.io);
    const index = findSlot(session, key) orelse return error.AttachmentNotFound;
    if (!session.attachments[index].live) return error.AttachmentNotLive;
    if (session.pending_resize_count != 0) return error.ResizePending;
    session.lease_epoch = std.math.add(u64, session.lease_epoch, 1) catch return error.EpochExhausted;
    session.activity_order +%= 1;
    session.attachments[index].activity_order = session.activity_order;
    session.controller_key = key;
    session.bumpRevision();
    return leaseStateLocked(session);
}

pub fn leaseState(session: *Session, key: Session.AttachmentKey) !Session.LeaseState {
    session.mutex.lockUncancelable(session.io);
    defer session.mutex.unlock(session.io);
    _ = findSlot(session, key) orelse return error.AttachmentNotFound;
    return leaseStateLocked(session);
}

pub fn applyInput(
    session: *Session,
    key: Session.AttachmentKey,
    lease_epoch: u64,
    based_event_seq: u64,
    input_seq: u64,
    bytes: []const u8,
) !InputResult {
    if (bytes.len == 0 or bytes.len > session.limits.max_input_bytes) return error.InvalidInput;
    session.mutex.lockUncancelable(session.io);
    defer session.mutex.unlock(session.io);
    const index = try validateControllerLocked(session, key, lease_epoch, based_event_seq);
    var input_hash: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(bytes, &input_hash, .{});
    if (input_seq == 0 or input_seq < session.attachments[index].last_input_seq) return error.StaleInput;
    if (input_seq == session.attachments[index].last_input_seq) {
        if (std.mem.eql(u8, &input_hash, &session.attachments[index].last_input_hash)) return .duplicate;
        return error.InputConflict;
    }
    for (session.input_dedup) |entry| {
        if (!entry.active or
            !std.mem.eql(u8, &entry.client_id, &session.attachments[index].client_id) or
            entry.input_seq != input_seq) continue;
        if (!std.mem.eql(u8, &entry.sha256, &input_hash)) return error.InputConflict;
        session.attachments[index].last_input_seq = input_seq;
        session.attachments[index].last_input_hash = input_hash;
        return .duplicate;
    }
    try session.connection.send(session.io, .input, bytes);
    session.attachments[index].last_input_seq = input_seq;
    session.attachments[index].last_input_hash = input_hash;
    session.input_dedup[session.input_dedup_cursor] = .{
        .active = true,
        .client_id = session.attachments[index].client_id,
        .input_seq = input_seq,
        .sha256 = input_hash,
    };
    session.input_dedup_cursor = @intCast((@as(usize, session.input_dedup_cursor) + 1) % session.input_dedup.len);
    session.activity_order +%= 1;
    session.attachments[index].activity_order = session.activity_order;
    return .accepted;
}

pub fn applyResize(
    session: *Session,
    key: Session.AttachmentKey,
    lease_epoch: u64,
    based_event_seq: u64,
    geometry: Session.Geometry,
) !u64 {
    if (!manifest.validGeometry(session.limits, geometry.cols, geometry.rows) or
        !manifest.validCellGeometry(geometry.cell_width_px, geometry.cell_height_px)) return error.InvalidGeometry;
    session.mutex.lockUncancelable(session.io);
    defer session.mutex.unlock(session.io);
    const index = try validateControllerLocked(session, key, lease_epoch, based_event_seq);
    const operation_id = try session.applyResizeLocked(geometry);
    session.activity_order +%= 1;
    session.attachments[index].activity_order = session.activity_order;
    return operation_id;
}

fn validateControllerLocked(session: *Session, key: Session.AttachmentKey, lease_epoch: u64, based_event_seq: u64) !usize {
    const index = findSlot(session, key) orelse return error.AttachmentNotFound;
    if (!session.attachments[index].live) return error.AttachmentNotLive;
    if (session.state != .running) return error.SessionNotRunning;
    if (!keyEqual(session.controller_key, key) or session.lease_epoch != lease_epoch) return error.LeaseLost;
    if (based_event_seq > session.next_event_seq -| 1 or
        based_event_seq != session.attachments[index].acknowledged_event_seq) return error.StaleTerminal;
    return index;
}

fn leaseStateLocked(session: *Session) Session.LeaseState {
    return .{
        .epoch = session.lease_epoch,
        .controller_attachment_id = if (session.controller_key) |key| key.attachment_id else null,
        .geometry = session.geometry,
    };
}

fn freeSlot(session: *Session) ?usize {
    for (&session.attachments, 0..) |*slot, index| if (!slot.active) return index;
    return null;
}

fn findByConnectionAttachment(session: *Session, connection_id: u64, attachment_id: u64) ?usize {
    for (session.attachments, 0..) |slot, index|
        if (slot.active and slot.key.connection_id == connection_id and slot.key.attachment_id == attachment_id) return index;
    return null;
}

fn findSlot(session: *Session, key: Session.AttachmentKey) ?usize {
    for (session.attachments, 0..) |slot, index|
        if (slot.active and keyEqual(slot.key, key)) return index;
    return null;
}

fn keyEqual(left: ?Session.AttachmentKey, right: Session.AttachmentKey) bool {
    const value = left orelse return false;
    return value.connection_id == right.connection_id and value.attachment_id == right.attachment_id and value.epoch == right.epoch;
}

fn cursorAvailable(session: *Session, event_seq: u64, output_offset: u64) bool {
    const high = session.next_event_seq -| 1;
    if (event_seq > high or output_offset > session.output_offset) return false;
    if (event_seq == high) return output_offset == session.output_offset;
    if (event_seq == session.checkpoint_event_seq) {
        const checkpoint_offset = if (session.current_checkpoint) |value| value.output_offset else 0;
        if (output_offset != checkpoint_offset) return false;
    } else {
        var matched = false;
        for (session.journal.events.items) |event| {
            if (event.seq != event_seq) continue;
            const expected = event.output_offset + if (event.kind == .output) event.byte_len else 0;
            if (output_offset != expected) return false;
            matched = true;
            break;
        }
        if (!matched) {
            for (session.journal.events.items) |event| {
                if (event.seq != event_seq + 1) continue;
                if (output_offset != event.output_offset) return false;
                matched = true;
                break;
            }
            if (!matched) return false;
        }
    }
    const next_seq = event_seq + 1;
    for (session.journal.events.items) |event| if (event.seq == next_seq) return true;
    return next_seq > high;
}

fn copyEventsAfter(session: *Session, allocator: std.mem.Allocator, event_seq: u64, max_bytes: usize) !Batch {
    var events: std.ArrayListUnmanaged(Session.Event) = .empty;
    defer events.deinit(allocator);
    var bytes: std.ArrayListUnmanaged(u8) = .empty;
    defer bytes.deinit(allocator);
    var high_event_seq = event_seq;
    var high_output_offset = cursorOffset(session, event_seq) orelse return error.ReplayUnavailable;
    for (session.journal.events.items) |source| {
        if (source.seq <= event_seq) continue;
        const byte_count: usize = if (source.kind == .output) source.byte_len else 0;
        if (events.items.len != 0 and bytes.items.len + byte_count > max_bytes) break;
        if (byte_count > max_bytes and events.items.len == 0) return error.BatchLimitTooSmall;
        var event = source;
        if (source.kind == .output) {
            event.byte_start = @intCast(bytes.items.len);
            try bytes.appendSlice(allocator, session.journal.output(source));
        }
        try events.append(allocator, event);
        high_event_seq = event.seq;
        high_output_offset = event.output_offset + if (event.kind == .output) event.byte_len else 0;
    }
    return .{
        .allocator = allocator,
        .events = try events.toOwnedSlice(allocator),
        .bytes = try bytes.toOwnedSlice(allocator),
        .high_event_seq = high_event_seq,
        .high_output_offset = high_output_offset,
    };
}

fn cursorOffset(session: *Session, event_seq: u64) ?u64 {
    if (event_seq == session.next_event_seq -| 1) return session.output_offset;
    if (event_seq == session.checkpoint_event_seq)
        return if (session.current_checkpoint) |value| value.output_offset else 0;
    for (session.journal.events.items) |event| {
        if (event.seq != event_seq) continue;
        return event.output_offset + if (event.kind == .output) event.byte_len else 0;
    }
    for (session.journal.events.items) |event| {
        if (event.seq != event_seq + 1) continue;
        return event.output_offset;
    }
    return if (event_seq == 0 and session.checkpoint_event_seq == 0) 0 else null;
}
