// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");
const Session = @import("Session.zig");
const manifest = @import("session_manifest.zig");
const session_realtime = @import("session_realtime.zig");

const Self = @This();
const idempotency_capacity = 256;

pub const CreateOptions = struct {
    profile: []const u8,
    name: []const u8,
    geometry: Session.Geometry,
};

pub const CreateResult = struct {
    metadata: Session.Metadata,
    replayed: bool,
};

pub const TerminateResult = struct {
    metadata: Session.Metadata,
    replayed: bool,
};

const Operation = enum { create, terminate };
const IdempotencyRecord = struct {
    operation: Operation,
    key_hash: [32]u8,
    request_hash: [32]u8,
    session_id: Session.Id,
};

allocator: std.mem.Allocator,
io: std.Io,
executable: []const u8,
shell: []const u8,
limits: manifest.Limits,
server_instance: Session.Id,
mutex: std.Io.Mutex = .init,
sessions: std.AutoHashMapUnmanaged(Session.Id, *Session) = .empty,
group: std.Io.Group = .init,
revision: std.atomic.Value(u64) = .init(0),
creating_count: usize = 0,
idempotency: [idempotency_capacity]IdempotencyRecord = undefined,
idempotency_len: usize = 0,
idempotency_cursor: usize = 0,

pub fn init(
    allocator: std.mem.Allocator,
    io: std.Io,
    executable: []const u8,
    shell: []const u8,
    limits: manifest.Limits,
) !Self {
    if (limits.max_exited_sessions < limits.max_live_sessions or limits.max_exited_sessions > 64 or limits.max_attachments_per_session > Session.max_attachment_slots) return error.InvalidLimits;
    const owned_executable = try allocator.dupe(u8, executable);
    errdefer allocator.free(owned_executable);
    const owned_shell = try allocator.dupe(u8, shell);
    errdefer allocator.free(owned_shell);
    var server_instance: Session.Id = undefined;
    try randomId(io, &server_instance);
    var self: Self = .{
        .allocator = allocator,
        .io = io,
        .executable = owned_executable,
        .shell = owned_shell,
        .limits = limits,
        .server_instance = server_instance,
    };
    const session_capacity = @as(u32, @intCast(limits.max_exited_sessions));
    try self.sessions.ensureTotalCapacity(allocator, session_capacity);
    return self;
}

pub fn deinit(self: *Self) void {
    var iterator = self.sessions.valueIterator();
    while (iterator.next()) |entry| _ = entry.*.requestTerminate();
    self.group.cancel(self.io);
    iterator = self.sessions.valueIterator();
    while (iterator.next()) |entry| entry.*.destroy();
    self.sessions.deinit(self.allocator);
    self.allocator.free(self.executable);
    self.allocator.free(self.shell);
    self.* = undefined;
}

pub fn create(
    self: *Self,
    options: CreateOptions,
    idempotency_key: []const u8,
    request_hash: [32]u8,
) !CreateResult {
    self.pruneExpired();
    if (!std.mem.eql(u8, options.profile, manifest.command_profile)) return error.UnknownCommandProfile;
    if (!validName(options.name, self.limits.max_name_bytes)) return error.InvalidSessionName;
    if (!manifest.validGeometry(self.limits, options.geometry.cols, options.geometry.rows) or
        !manifest.validCellGeometry(options.geometry.cell_width_px, options.geometry.cell_height_px)) return error.InvalidGeometry;
    const key_hash = hashIdempotencyKey(idempotency_key);

    self.mutex.lockUncancelable(self.io);
    if (self.findIdempotency(key_hash)) |record| {
        if (record.operation != .create or !std.mem.eql(u8, &record.request_hash, &request_hash)) {
            self.mutex.unlock(self.io);
            return error.IdempotencyConflict;
        }
        const session = self.sessions.get(record.session_id) orelse {
            self.mutex.unlock(self.io);
            return error.SessionNotFound;
        };
        const metadata = session.snapshotMetadata();
        self.mutex.unlock(self.io);
        return .{ .metadata = metadata, .replayed = true };
    }
    const live_count = self.countLiveLocked();
    if (live_count + self.creating_count >= self.limits.max_live_sessions) {
        self.mutex.unlock(self.io);
        return error.LiveSessionLimit;
    }
    if (self.sessions.count() + self.creating_count >= self.limits.max_exited_sessions) {
        self.mutex.unlock(self.io);
        return error.RetainedSessionLimit;
    }
    self.creating_count += 1;
    self.mutex.unlock(self.io);

    var id: Session.Id = undefined;
    var generation: Session.Id = undefined;
    randomId(self.io, &id) catch |err| {
        self.releaseCreatingReservation();
        return err;
    };
    randomId(self.io, &generation) catch |err| {
        self.releaseCreatingReservation();
        return err;
    };
    const session = Session.create(
        self.allocator,
        self.io,
        self.executable,
        self.shell,
        self.limits,
        &self.revision,
        id,
        generation,
        options.name,
        options.geometry,
    ) catch |err| {
        self.releaseCreatingReservation();
        return err;
    };

    self.mutex.lockUncancelable(self.io);
    self.creating_count -= 1;
    if (self.sessions.contains(id)) {
        self.mutex.unlock(self.io);
        _ = session.requestTerminate();
        session.run();
        session.destroy();
        return error.IdentifierCollision;
    }
    self.sessions.putAssumeCapacity(id, session);
    _ = self.revision.fetchAdd(1, .monotonic);
    self.group.concurrent(self.io, Session.run, .{session}) catch |err| {
        _ = self.sessions.remove(id);
        _ = self.revision.fetchAdd(1, .monotonic);
        self.mutex.unlock(self.io);
        _ = session.requestTerminate();
        session.run();
        session.destroy();
        return err;
    };
    self.storeIdempotency(.create, key_hash, request_hash, id);
    const metadata = session.snapshotMetadata();
    self.mutex.unlock(self.io);
    return .{ .metadata = metadata, .replayed = false };
}

pub fn list(self: *Self, output: []Session.Metadata) usize {
    self.pruneExpired();
    var pinned: [64]*Session = undefined;
    var count: usize = 0;
    const limit = @min(output.len, pinned.len);

    self.mutex.lockUncancelable(self.io);
    var iterator = self.sessions.valueIterator();
    while (iterator.next()) |entry| {
        if (count == limit) break;
        const session = entry.*;
        _ = session.reference_count.fetchAdd(1, .acq_rel);
        pinned[count] = session;
        count += 1;
    }
    self.mutex.unlock(self.io);

    for (pinned[0..count], 0..) |session, index| {
        output[index] = session.snapshotMetadata();
        unpinSession(session);
    }
    std.mem.sort(Session.Metadata, output[0..count], {}, newerFirst);
    return count;
}

pub fn get(self: *Self, id: Session.Id) ?Session.Metadata {
    self.pruneExpired();
    const session = self.pinSession(id) catch return null;
    defer unpinSession(session);
    return session.snapshotMetadata();
}

pub fn rename(self: *Self, id: Session.Id, name: []const u8) !Session.Metadata {
    if (!validName(name, self.limits.max_name_bytes)) return error.InvalidSessionName;
    const session = try self.pinSession(id);
    defer unpinSession(session);
    if (!session.rename(name)) return error.InvalidSessionState;
    _ = self.revision.fetchAdd(1, .monotonic);
    return session.snapshotMetadata();
}

pub fn terminate(
    self: *Self,
    id: Session.Id,
    idempotency_key: []const u8,
    request_hash: [32]u8,
) !TerminateResult {
    const key_hash = hashIdempotencyKey(idempotency_key);
    self.mutex.lockUncancelable(self.io);
    if (self.findIdempotency(key_hash)) |record| {
        if (record.operation != .terminate or !std.mem.eql(u8, &record.request_hash, &request_hash) or !std.mem.eql(u8, &record.session_id, &id)) {
            self.mutex.unlock(self.io);
            return error.IdempotencyConflict;
        }
        const session = self.sessions.get(id) orelse {
            self.mutex.unlock(self.io);
            return error.SessionNotFound;
        };
        const metadata = session.snapshotMetadata();
        self.mutex.unlock(self.io);
        return .{ .metadata = metadata, .replayed = true };
    }
    const session = self.sessions.get(id) orelse {
        self.mutex.unlock(self.io);
        return error.SessionNotFound;
    };
    if (!session.markTerminating()) {
        self.mutex.unlock(self.io);
        return error.InvalidSessionState;
    }
    _ = self.revision.fetchAdd(1, .monotonic);
    self.storeIdempotency(.terminate, key_hash, request_hash, id);
    const metadata = session.snapshotMetadata();
    // The session stays pinned by the registry lock while signaling termination.
    session.signalTerminate();
    self.mutex.unlock(self.io);
    return .{ .metadata = metadata, .replayed = false };
}

pub fn delete(self: *Self, id: Session.Id) !void {
    self.mutex.lockUncancelable(self.io);
    const session = self.sessions.get(id) orelse {
        self.mutex.unlock(self.io);
        return error.SessionNotFound;
    };
    const metadata = session.snapshotMetadata();
    if (metadata.state != .exited and metadata.state != .failed) {
        self.mutex.unlock(self.io);
        return error.SessionRunning;
    }
    if (!session.actor_done.load(.acquire)) {
        self.mutex.unlock(self.io);
        return error.SessionBusy;
    }
    if (session.reference_count.load(.acquire) != 0 or metadata.attachment_count != 0) {
        self.mutex.unlock(self.io);
        return error.SessionBusy;
    }
    _ = self.sessions.remove(id);
    _ = self.revision.fetchAdd(1, .monotonic);
    self.mutex.unlock(self.io);
    session.destroy();
}

pub fn realtimeAttach(
    self: *Self,
    connection_id: u64,
    client_id: Session.Id,
    id: Session.Id,
    attachment_id: u64,
    generation: Session.Id,
    event_seq: u64,
    output_offset: u64,
) !session_realtime.Replay {
    const session = try self.pinSession(id);
    defer unpinSession(session);
    return session_realtime.beginAttach(
        session,
        self.allocator,
        connection_id,
        attachment_id,
        client_id,
        generation,
        event_seq,
        output_offset,
    );
}

pub fn realtimeRead(
    self: *Self,
    id: Session.Id,
    key: Session.AttachmentKey,
    event_seq: u64,
    output_offset: u64,
    max_bytes: usize,
) !session_realtime.Batch {
    const session = try self.pinSession(id);
    defer unpinSession(session);
    return session_realtime.readAfter(session, self.allocator, key, event_seq, output_offset, max_bytes);
}

pub fn realtimeAck(
    self: *Self,
    id: Session.Id,
    key: Session.AttachmentKey,
    event_seq: u64,
    output_offset: u64,
) !void {
    const session = try self.pinSession(id);
    defer unpinSession(session);
    return session_realtime.acknowledge(session, key, event_seq, output_offset);
}

pub fn realtimeDetach(self: *Self, id: Session.Id, key: Session.AttachmentKey) !Session.LeaseState {
    const session = try self.pinSession(id);
    defer unpinSession(session);
    return session_realtime.detach(session, key);
}

pub fn realtimeClaim(self: *Self, id: Session.Id, key: Session.AttachmentKey) !Session.LeaseState {
    const session = try self.pinSession(id);
    defer unpinSession(session);
    return session_realtime.claimControl(session, key);
}

pub fn realtimeLease(self: *Self, id: Session.Id, key: Session.AttachmentKey) !Session.LeaseState {
    const session = try self.pinSession(id);
    defer unpinSession(session);
    return session_realtime.leaseState(session, key);
}

pub fn realtimeInput(
    self: *Self,
    id: Session.Id,
    key: Session.AttachmentKey,
    lease_epoch: u64,
    based_event_seq: u64,
    input_seq: u64,
    bytes: []const u8,
) !session_realtime.InputResult {
    const session = try self.pinSession(id);
    defer unpinSession(session);
    return session_realtime.applyInput(session, key, lease_epoch, based_event_seq, input_seq, bytes);
}

pub fn realtimeResize(
    self: *Self,
    id: Session.Id,
    key: Session.AttachmentKey,
    lease_epoch: u64,
    based_event_seq: u64,
    geometry: Session.Geometry,
) !u64 {
    const session = try self.pinSession(id);
    defer unpinSession(session);
    return session_realtime.applyResize(session, key, lease_epoch, based_event_seq, geometry);
}

pub fn currentRevision(self: *Self) u64 {
    return self.revision.load(.monotonic);
}

fn pinSession(self: *Self, id: Session.Id) !*Session {
    self.mutex.lockUncancelable(self.io);
    const session = self.sessions.get(id) orelse {
        self.mutex.unlock(self.io);
        return error.SessionNotFound;
    };
    _ = session.reference_count.fetchAdd(1, .acq_rel);
    self.mutex.unlock(self.io);
    return session;
}

fn unpinSession(session: *Session) void {
    const previous = session.reference_count.fetchSub(1, .acq_rel);
    std.debug.assert(previous > 0);
}

fn pruneExpired(self: *Self) void {
    var ids: [64]Session.Id = undefined;
    var id_count: usize = 0;
    const now = std.Io.Clock.real.now(self.io).toMilliseconds();

    self.mutex.lockUncancelable(self.io);
    var iterator = self.sessions.iterator();
    while (iterator.next()) |entry| {
        if (id_count == ids.len) break;
        const session = entry.value_ptr.*;
        if (!session.actor_done.load(.acquire)) continue;
        if (session.reference_count.load(.acquire) != 0) continue;
        const metadata = session.snapshotMetadata();
        if (metadata.attachment_count != 0) continue;
        if (metadata.state != .exited and metadata.state != .failed) continue;
        if (self.limits.exited_retention_ms > 0 and
            (now < metadata.last_activity_ms or
                now - metadata.last_activity_ms < self.limits.exited_retention_ms)) continue;
        ids[id_count] = entry.key_ptr.*;
        id_count += 1;
    }

    var sessions: [64]*Session = undefined;
    var session_count: usize = 0;
    for (ids[0..id_count]) |id| {
        const session = self.sessions.get(id) orelse continue;
        _ = self.sessions.remove(id);
        sessions[session_count] = session;
        session_count += 1;
        _ = self.revision.fetchAdd(1, .monotonic);
    }
    self.mutex.unlock(self.io);

    for (sessions[0..session_count]) |session| session.destroy();
}

fn findIdempotency(self: *Self, key_hash: [32]u8) ?IdempotencyRecord {
    for (self.idempotency[0..self.idempotency_len]) |record|
        if (std.mem.eql(u8, &record.key_hash, &key_hash)) return record;
    return null;
}

fn releaseCreatingReservation(self: *Self) void {
    self.mutex.lockUncancelable(self.io);
    self.creating_count -= 1;
    self.mutex.unlock(self.io);
}

fn storeIdempotency(self: *Self, operation: Operation, key_hash: [32]u8, request_hash: [32]u8, id: Session.Id) void {
    const index = if (self.idempotency_len < self.idempotency.len) blk: {
        const value = self.idempotency_len;
        self.idempotency_len += 1;
        break :blk value;
    } else blk: {
        const value = self.idempotency_cursor;
        self.idempotency_cursor = (self.idempotency_cursor + 1) % self.idempotency.len;
        break :blk value;
    };
    self.idempotency[index] = .{
        .operation = operation,
        .key_hash = key_hash,
        .request_hash = request_hash,
        .session_id = id,
    };
}

fn countLiveLocked(self: *Self) usize {
    var live: usize = 0;
    var iterator = self.sessions.valueIterator();
    while (iterator.next()) |entry| switch (entry.*.snapshotMetadata().state) {
        .creating, .running, .terminating => live += 1,
        .exited, .failed => {},
    };
    return live;
}

fn newerFirst(_: void, a: Session.Metadata, b: Session.Metadata) bool {
    return a.last_activity_ms > b.last_activity_ms;
}

fn validName(name: []const u8, max_bytes: usize) bool {
    if (name.len > max_bytes or name.len > @sizeOf(@FieldType(Session.Metadata, "name")) or !std.unicode.utf8ValidateSlice(name)) return false;
    for (name) |byte| if (byte < 0x20 or byte == 0x7f) return false;
    return true;
}

fn hashIdempotencyKey(key: []const u8) [32]u8 {
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(key, &digest, .{});
    return digest;
}

pub fn randomId(io: std.Io, id: *Session.Id) !void {
    try io.randomSecure(id);
    id[6] = (id[6] & 0x0f) | 0x40;
    id[8] = (id[8] & 0x3f) | 0x80;
}

pub fn formatId(id: Session.Id, buffer: *[36]u8) []const u8 {
    const hex = "0123456789abcdef";
    var source: usize = 0;
    var target: usize = 0;
    while (source < id.len) : (source += 1) {
        if (target == 8 or target == 13 or target == 18 or target == 23) {
            buffer[target] = '-';
            target += 1;
        }
        buffer[target] = hex[id[source] >> 4];
        buffer[target + 1] = hex[id[source] & 0x0f];
        target += 2;
    }
    return buffer;
}

pub fn parseId(text: []const u8) ?Session.Id {
    if (text.len != 36 or text[8] != '-' or text[13] != '-' or text[18] != '-' or text[23] != '-') return null;
    var id: Session.Id = undefined;
    var source: usize = 0;
    var target: usize = 0;
    while (source < text.len) {
        if (text[source] == '-') {
            source += 1;
            continue;
        }
        if (source + 1 >= text.len or target >= id.len) return null;
        const high = hexNibble(text[source]) orelse return null;
        const low = hexNibble(text[source + 1]) orelse return null;
        id[target] = (@as(u8, high) << 4) | low;
        source += 2;
        target += 1;
    }
    return if (target == id.len) id else null;
}

fn hexNibble(byte: u8) ?u8 {
    return switch (byte) {
        '0'...'9' => byte - '0',
        'a'...'f' => byte - 'a' + 10,
        'A'...'F' => byte - 'A' + 10,
        else => null,
    };
}

test "session IDs and names are bounded" {
    const id: Session.Id = .{ 0, 1, 2, 3, 4, 5, 0x46, 7, 0x88, 9, 10, 11, 12, 13, 14, 15 };
    var buffer: [36]u8 = undefined;
    const text = formatId(id, &buffer);
    try std.testing.expectEqualStrings("00010203-0405-4607-8809-0a0b0c0d0e0f", text);
    try std.testing.expectEqual(id, parseId(text).?);
    try std.testing.expect(parseId("not-an-id") == null);
    const valid_name = [_]u8{'a'} ** 80;
    const oversized_name = [_]u8{'a'} ** 81;
    try std.testing.expect(validName(&valid_name, 100));
    try std.testing.expect(!validName(&oversized_name, 100));
    try std.testing.expect(!validName(&[_]u8{0xff}, 100));
    try std.testing.expect(!validName("bad\nname", 100));
}
