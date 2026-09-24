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
    if (findByConnectionAttachment(session, connection_id, attachment_id) != null) return error.AttachmentExists;
    const generation_matches = std.mem.eql(u8, &generation, &session.generation);
    // Logical resume continues the same owner; session-owned pending resize operations remain intact.
    var replacement_index: ?usize = null;
    if (generation_matches) {
        for (session.attachments, 0..) |attachment, index| {
            if (attachment.active and
                std.mem.eql(u8, &attachment.client_id, &client_id) and
                attachment.key.attachment_id == attachment_id and
                attachment.key.connection_id != connection_id)
            {
                replacement_index = index;
                break;
            }
        }
    }
    if (replacement_index == null and session.attachment_count >= session.limits.max_attachments_per_session)
        return error.AttachmentLimit;
    const slot_index = replacement_index orelse (freeSlot(session) orelse return error.AttachmentLimit);
    const high_event_seq = session.next_event_seq -| 1;
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
    const next_epoch = std.math.add(u64, epoch, 1) catch return error.EpochExhausted;
    const transferring_controller = replacement_index != null and
        keyEqual(session.controller_key, session.attachments[slot_index].key);
    const next_lease_epoch = if (transferring_controller)
        std.math.add(u64, session.lease_epoch, 1) catch return error.EpochExhausted
    else
        session.lease_epoch;
    session.next_attachment_epoch = next_epoch;
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
    if (transferring_controller) {
        session.lease_epoch = next_lease_epoch;
        session.controller_key = key;
    }
    if (replacement_index == null) session.attachment_count += 1;
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
    if (session.attachment_count == 0 and session.state == .exited and session.current_checkpoint != null)
        session.journal.release();
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
    const owned_events = try events.toOwnedSlice(allocator);
    errdefer allocator.free(owned_events);
    const owned_bytes = try bytes.toOwnedSlice(allocator);
    return .{
        .allocator = allocator,
        .events = owned_events,
        .bytes = owned_bytes,
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

test "replay allocation failures release transferred slices" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, struct {
        fn run(allocator: std.mem.Allocator) !void {
            var journal = Session.Journal.init(allocator, 64);
            defer journal.deinit();
            try journal.appendOutput("abc", 1, 0, 0);

            var session: Session = undefined;
            session.journal = journal;
            session.next_event_seq = 2;
            session.output_offset = 3;
            session.checkpoint_event_seq = 0;
            session.current_checkpoint = null;

            var batch = try copyEventsAfter(&session, allocator, 0, 64);
            defer batch.deinit();
            try std.testing.expectEqualStrings("abc", batch.bytes);
            try std.testing.expectEqual(@as(usize, 1), batch.events.len);
        }
    }.run, .{});
}

fn resumeTestSession(revision: *std.atomic.Value(u64)) Session {
    var session: Session = undefined;
    session.io = std.testing.io;
    session.mutex = .init;
    session.registry_revision = revision;
    session.limits = .{ .max_attachments_per_session = 1 };
    session.generation = .{1} ** 16;
    session.geometry = .{ .cols = 80, .rows = 24 };
    session.initial_geometry = session.geometry;
    session.state = .running;
    session.journal = Session.Journal.init(std.testing.allocator, 64);
    session.current_checkpoint = null;
    session.checkpoint_event_seq = 0;
    session.next_event_seq = 1;
    session.output_offset = 0;
    session.attachments = [_]Session.AttachmentState{.{}} ** Session.max_attachment_slots;
    session.attachment_count = 0;
    session.next_attachment_epoch = 1;
    session.activity_order = 0;
    session.controller_key = null;
    session.lease_epoch = 0;
    session.pending_resizes = [_]Session.PendingResize{.{}} ** Session.max_attachment_slots;
    session.next_resize_operation = 1;
    session.pending_resize_count = 0;
    return session;
}

test "logical resume at capacity fences old controller and waits for replay ACK" {
    var revision: std.atomic.Value(u64) = .init(0);
    var session = resumeTestSession(&revision);
    defer session.journal.deinit();
    const client: Session.Id = .{2} ** 16;
    var old = try beginAttach(&session, std.testing.allocator, 1, 10, client, session.generation, 0, 0);
    defer old.deinit();
    try acknowledge(&session, old.key, 0, 0);
    const old_lease = try claimControl(&session, old.key);
    try std.testing.expectError(error.AttachmentExists, beginAttach(&session, std.testing.allocator, 1, 10, client, session.generation, 0, 0));
    try std.testing.expectError(error.AttachmentLimit, beginAttach(&session, std.testing.allocator, 2, 10, .{3} ** 16, session.generation, 0, 0));
    try std.testing.expectError(error.AttachmentLimit, beginAttach(&session, std.testing.allocator, 2, 11, client, session.generation, 0, 0));
    try std.testing.expectError(error.AttachmentLimit, beginAttach(&session, std.testing.allocator, 2, 10, client, .{9} ** 16, 0, 0));
    var resumed = try beginAttach(&session, std.testing.allocator, 2, 10, client, session.generation, 0, 0);
    defer resumed.deinit();
    try std.testing.expectEqual(@as(u8, 1), session.attachment_count);
    try std.testing.expectEqual(old.key.epoch + 1, resumed.key.epoch);
    try std.testing.expectEqual(old_lease.epoch + 1, resumed.lease.epoch);
    try std.testing.expect(keyEqual(session.controller_key, resumed.key));
    try std.testing.expectError(error.AttachmentNotLive, applyInput(&session, resumed.key, resumed.lease.epoch, 0, 1, "x"));
    try std.testing.expectError(error.AttachmentNotFound, applyInput(&session, old.key, old_lease.epoch, 0, 1, "x"));
    try std.testing.expectError(error.AttachmentNotFound, acknowledge(&session, old.key, 0, 0));
    try std.testing.expectError(error.AttachmentNotFound, claimControl(&session, old.key));
    _ = detach(&session, old.key);
    try std.testing.expectEqual(@as(u8, 1), session.attachment_count);
    try std.testing.expect(keyEqual(session.controller_key, resumed.key));
    try std.testing.expectError(error.InvalidCursor, acknowledge(&session, resumed.key, 1, 0));
    try std.testing.expectError(error.AttachmentNotLive, validateControllerLocked(&session, resumed.key, resumed.lease.epoch, 0));
    try acknowledge(&session, resumed.key, 0, 0);
    _ = try validateControllerLocked(&session, resumed.key, resumed.lease.epoch, 0);
    try std.testing.expectError(error.LeaseLost, validateControllerLocked(&session, resumed.key, old_lease.epoch, 0));
}

test "logical resume preserves readers and pending resize owners" {
    var revision: std.atomic.Value(u64) = .init(0);
    var session = resumeTestSession(&revision);
    defer session.journal.deinit();
    session.limits.max_attachments_per_session = 2;
    const client: Session.Id = .{2} ** 16;
    var controller = try beginAttach(&session, std.testing.allocator, 1, 10, client, session.generation, 0, 0);
    defer controller.deinit();
    try acknowledge(&session, controller.key, 0, 0);
    const lease = try claimControl(&session, controller.key);
    var reader = try beginAttach(&session, std.testing.allocator, 1, 11, client, session.generation, 0, 0);
    defer reader.deinit();
    var resumed = try beginAttach(&session, std.testing.allocator, 2, 11, client, session.generation, 0, 0);
    defer resumed.deinit();
    try std.testing.expectEqual(lease.epoch, resumed.lease.epoch);
    try std.testing.expect(keyEqual(session.controller_key, controller.key));
    try acknowledge(&session, resumed.key, 0, 0);
    try std.testing.expectError(error.LeaseLost, validateControllerLocked(&session, resumed.key, lease.epoch, 0));
    session.pending_resizes[0] = .{ .active = true, .operation_id = 41, .geometry = .{ .cols = 100, .rows = 30, .cell_width_px = 9, .cell_height_px = 18 } };
    session.pending_resizes[1] = .{ .active = true, .operation_id = 42, .geometry = .{ .cols = 120, .rows = 40, .cell_width_px = 10, .cell_height_px = 20 } };
    session.pending_resize_count = 2;
    session.next_resize_operation = 43;
    const pending = session.pending_resizes;
    try std.testing.expectError(error.ResizePending, claimControl(&session, resumed.key));
    var handover = try beginAttach(&session, std.testing.allocator, 3, 10, client, session.generation, 0, 0);
    defer handover.deinit();
    try std.testing.expectEqual(@as(u8, 2), session.attachment_count);
    try std.testing.expectEqual(lease.epoch + 1, handover.lease.epoch);
    try std.testing.expect(keyEqual(session.controller_key, handover.key));
    try std.testing.expectError(error.AttachmentNotLive, applyInput(&session, handover.key, handover.lease.epoch, 0, 1, "x"));
    try std.testing.expectError(error.AttachmentNotFound, applyInput(&session, controller.key, lease.epoch, 0, 1, "x"));
    try std.testing.expectError(error.AttachmentNotFound, acknowledge(&session, controller.key, 0, 0));
    try std.testing.expectError(error.AttachmentNotFound, claimControl(&session, controller.key));
    _ = detach(&session, controller.key);
    try std.testing.expectEqual(@as(u8, 2), session.attachment_count);
    try acknowledge(&session, handover.key, 0, 0);
    _ = try validateControllerLocked(&session, handover.key, handover.lease.epoch, 0);
    try std.testing.expectError(error.ResizePending, claimControl(&session, resumed.key));
    try std.testing.expectEqualDeep(pending, session.pending_resizes);
    try std.testing.expectEqual(@as(u8, 2), session.pending_resize_count);
    try std.testing.expectEqual(@as(u64, 43), session.next_resize_operation);
}

test "logical resume epoch failures preserve old slot and counters" {
    var revision: std.atomic.Value(u64) = .init(0);
    var session = resumeTestSession(&revision);
    defer session.journal.deinit();
    const client: Session.Id = .{2} ** 16;
    var old = try beginAttach(&session, std.testing.allocator, 1, 10, client, session.generation, 0, 0);
    defer old.deinit();
    try acknowledge(&session, old.key, 0, 0);
    _ = try claimControl(&session, old.key);
    const activity = session.activity_order;
    const rev = revision.load(.monotonic);
    session.next_attachment_epoch = std.math.maxInt(u64);
    try std.testing.expectError(error.EpochExhausted, beginAttach(&session, std.testing.allocator, 2, 10, client, session.generation, 0, 0));
    session.next_attachment_epoch = 2;
    session.lease_epoch = std.math.maxInt(u64);
    try std.testing.expectError(error.EpochExhausted, beginAttach(&session, std.testing.allocator, 2, 10, client, session.generation, 0, 0));
    try std.testing.expectEqual(@as(u64, 2), session.next_attachment_epoch);
    try std.testing.expectEqual(activity, session.activity_order);
    try std.testing.expectEqual(rev, revision.load(.monotonic));
    try std.testing.expectEqual(@as(u8, 1), session.attachment_count);
    try std.testing.expect(keyEqual(session.controller_key, old.key));
    _ = try validateControllerLocked(&session, old.key, session.lease_epoch, 0);
}

test "logical resume replay allocation failures leave old attachment valid" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, struct {
        fn run(allocator: std.mem.Allocator) !void {
            var revision: std.atomic.Value(u64) = .init(0);
            var session = resumeTestSession(&revision);
            defer session.journal.deinit();
            const client: Session.Id = .{2} ** 16;
            var old = try beginAttach(&session, std.testing.allocator, 1, 10, client, session.generation, 0, 0);
            defer old.deinit();
            try acknowledge(&session, old.key, 0, 0);
            const lease = try claimControl(&session, old.key);
            try session.journal.appendOutput("abc", 1, 0, 0);
            session.next_event_seq = 2;
            session.output_offset = 3;
            const rev = revision.load(.monotonic);
            const activity = session.activity_order;
            var resumed = beginAttach(&session, allocator, 2, 10, client, session.generation, 0, 0) catch |err| {
                try std.testing.expectEqual(@as(u8, 1), session.attachment_count);
                try std.testing.expectEqual(@as(u64, 2), session.next_attachment_epoch);
                try std.testing.expectEqual(lease.epoch, session.lease_epoch);
                try std.testing.expectEqual(activity, session.activity_order);
                try std.testing.expectEqual(rev, revision.load(.monotonic));
                try std.testing.expect(keyEqual(session.controller_key, old.key));
                _ = try validateControllerLocked(&session, old.key, lease.epoch, 0);
                return err;
            };
            defer resumed.deinit();
            try std.testing.expectEqualStrings("abc", resumed.bytes);
            try std.testing.expectError(error.AttachmentNotLive, applyInput(&session, resumed.key, resumed.lease.epoch, 0, 1, "x"));
            try acknowledge(&session, resumed.key, 0, 0);
            try std.testing.expectError(error.AttachmentNotLive, validateControllerLocked(&session, resumed.key, resumed.lease.epoch, 0));
            try acknowledge(&session, resumed.key, 1, 3);
            _ = try validateControllerLocked(&session, resumed.key, resumed.lease.epoch, 1);
        }
    }.run, .{});
}
