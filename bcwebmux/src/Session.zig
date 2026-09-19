// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");
const ghostty = @import("ghostty-vt");
const manifest = @import("session_manifest.zig");
const worker = @import("session_worker.zig");

const Self = @This();
const continuation_limit = 1024 * 1024;
const max_title_bytes = 256;
const max_name_bytes = 80;
const max_journal_records = 64 * 1024;

pub const Id = [16]u8;
pub const State = enum { creating, running, terminating, exited, failed };
pub const EventKind = enum { output, resize, exit };

pub const Geometry = struct {
    cols: u16,
    rows: u16,
    cell_width_px: u16 = 8,
    cell_height_px: u16 = 16,
};

pub const max_attachment_slots = 8;
pub const max_input_dedup_entries = 64;

pub const AttachmentKey = struct {
    connection_id: u64,
    attachment_id: u64,
    epoch: u64,
};

pub const AttachmentState = struct {
    active: bool = false,
    live: bool = false,
    barrier_event_seq: u64 = 0,
    barrier_output_offset: u64 = 0,
    key: AttachmentKey = .{ .connection_id = 0, .attachment_id = 0, .epoch = 0 },
    client_id: Id = .{0} ** 16,
    activity_order: u64 = 0,
    last_input_seq: u64 = 0,
    last_input_hash: [32]u8 = .{0} ** 32,
    acknowledged_event_seq: u64 = 0,
    acknowledged_output_offset: u64 = 0,
};

pub const InputDedupEntry = struct {
    active: bool = false,
    client_id: Id = .{0} ** 16,
    input_seq: u64 = 0,
    sha256: [32]u8 = .{0} ** 32,
};

pub const PendingResize = struct {
    active: bool = false,
    operation_id: u64 = 0,
    geometry: Geometry = .{ .cols = 80, .rows = 24 },
};

pub const LeaseState = struct {
    epoch: u64,
    controller_attachment_id: ?u64,
    geometry: Geometry,
};

pub const Event = struct {
    kind: EventKind,
    seq: u64,
    output_offset: u64,
    byte_start: u32 = 0,
    byte_len: u32 = 0,
    crc32c: u32 = 0,
    cols: u16 = 0,
    rows: u16 = 0,
    cell_width_px: u16 = 0,
    cell_height_px: u16 = 0,
    wait_status: i32 = 0,
    timestamp_ms: i64 = 0,
};

pub const Journal = struct {
    allocator: std.mem.Allocator,
    bytes: std.ArrayListUnmanaged(u8) = .empty,
    events: std.ArrayListUnmanaged(Event) = .empty,
    byte_limit: usize,

    pub fn init(allocator: std.mem.Allocator, byte_limit: usize) Journal {
        return .{ .allocator = allocator, .byte_limit = byte_limit };
    }

    pub fn deinit(self: *Journal) void {
        self.bytes.deinit(self.allocator);
        self.events.deinit(self.allocator);
        self.* = undefined;
    }

    pub fn clear(self: *Journal) void {
        self.bytes.clearRetainingCapacity();
        self.events.clearRetainingCapacity();
    }

    pub fn release(self: *Journal) void {
        self.bytes.clearAndFree(self.allocator);
        self.events.clearAndFree(self.allocator);
    }

    pub fn discardThrough(self: *Journal, event_seq: u64) void {
        var retained_count: usize = 0;
        var byte_offset: usize = 0;
        for (self.events.items) |event| {
            if (event.seq <= event_seq) continue;
            var retained = event;
            if (event.kind == .output) {
                const start: usize = @intCast(event.byte_start);
                const length: usize = @intCast(event.byte_len);
                std.mem.copyForwards(u8, self.bytes.items[byte_offset..][0..length], self.bytes.items[start..][0..length]);
                retained.byte_start = @intCast(byte_offset);
                byte_offset += length;
            }
            self.events.items[retained_count] = retained;
            retained_count += 1;
        }
        self.bytes.items.len = byte_offset;
        self.events.items.len = retained_count;
    }

    pub fn canAppend(self: *const Journal, byte_count: usize) bool {
        return byte_count <= self.byte_limit -| self.bytes.items.len and self.events.items.len < max_journal_records;
    }

    fn ensureBytesCapacity(self: *Journal, additional: usize) !void {
        const required = self.bytes.items.len + additional;
        if (required <= self.bytes.capacity) return;
        var capacity = self.bytes.capacity;
        if (capacity == 0) capacity = 1;
        while (capacity < required) {
            capacity = @min(capacity +| (capacity / 2 + 1), self.byte_limit);
        }
        try self.bytes.ensureTotalCapacityPrecise(self.allocator, capacity);
    }

    fn ensureEventCapacity(self: *Journal, additional: usize) !void {
        const required = self.events.items.len + additional;
        if (required <= self.events.capacity) return;
        var capacity = self.events.capacity;
        if (capacity == 0) capacity = 1;
        while (capacity < required) {
            capacity = @min(capacity +| (capacity / 2 + 1), @as(usize, max_journal_records));
        }
        try self.events.ensureTotalCapacityPrecise(self.allocator, capacity);
    }

    pub fn appendOutput(self: *Journal, bytes: []const u8, seq: u64, offset: u64, timestamp_ms: i64) !void {
        if (!self.canAppend(bytes.len)) return error.JournalFull;
        try self.ensureBytesCapacity(bytes.len);
        try self.ensureEventCapacity(1);
        const start = self.bytes.items.len;
        self.bytes.appendSliceAssumeCapacity(bytes);
        self.events.appendAssumeCapacity(.{
            .kind = .output,
            .seq = seq,
            .output_offset = offset,
            .byte_start = @intCast(start),
            .byte_len = @intCast(bytes.len),
            .crc32c = std.hash.crc.Crc32Iscsi.hash(bytes),
            .timestamp_ms = timestamp_ms,
        });
    }

    pub fn appendResize(self: *Journal, geometry: Geometry, seq: u64, offset: u64, timestamp_ms: i64) !void {
        if (!self.canAppend(0)) return error.JournalFull;
        try self.ensureEventCapacity(1);
        self.events.appendAssumeCapacity(.{
            .kind = .resize,
            .seq = seq,
            .output_offset = offset,
            .cols = geometry.cols,
            .rows = geometry.rows,
            .cell_width_px = geometry.cell_width_px,
            .cell_height_px = geometry.cell_height_px,
            .timestamp_ms = timestamp_ms,
        });
    }

    pub fn appendExit(self: *Journal, status: i32, seq: u64, offset: u64, timestamp_ms: i64) !void {
        if (!self.canAppend(0)) return error.JournalFull;
        try self.ensureEventCapacity(1);
        self.events.appendAssumeCapacity(.{
            .kind = .exit,
            .seq = seq,
            .output_offset = offset,
            .wait_status = status,
            .timestamp_ms = timestamp_ms,
        });
    }

    pub fn output(self: *const Journal, event: Event) []const u8 {
        const start: usize = @intCast(event.byte_start);
        return self.bytes.items[start..][0..event.byte_len];
    }
};

pub const Checkpoint = struct {
    bytes: []u8,
    sha256: [32]u8,
    event_seq: u64,
    output_offset: u64,
    created_at_ms: i64,
};

pub const Metadata = struct {
    id: Id,
    generation: Id,
    name: [max_name_bytes]u8,
    name_len: u8,
    title: [max_title_bytes]u8,
    title_len: u16,
    state: State,
    geometry: Geometry,
    created_at_ms: i64,
    last_activity_ms: i64,
    exit_status: ?i32,
    event_seq: u64,
    output_offset: u64,
    checkpoint_event_seq: u64,
    checkpoint_bytes: usize,
    attachment_count: u8,
    controller_attachment_id: ?u64,
    lease_epoch: u64,

    pub fn nameSlice(self: *const Metadata) []const u8 {
        return self.name[0..self.name_len];
    }

    pub fn titleSlice(self: *const Metadata) []const u8 {
        return self.title[0..self.title_len];
    }
};

allocator: std.mem.Allocator,
io: std.Io,
limits: manifest.Limits,
registry_revision: *std.atomic.Value(u64),
id: Id,
generation: Id,
name: [max_name_bytes]u8 = undefined,
name_len: u8,
title: [max_title_bytes]u8 = undefined,
title_len: u16 = 0,
state: State = .creating,
geometry: Geometry,
initial_geometry: Geometry,
created_at_ms: i64,
last_activity_ms: i64,
exit_status: ?i32 = null,
next_event_seq: u64 = 1,
output_offset: u64 = 0,
bytes_since_checkpoint: usize = 0,
checkpoint_event_seq: u64 = 0,
checkpoint_at_monotonic_ms: i64,
current_checkpoint: ?Checkpoint = null,
journal: Journal,
connection: worker.Connection,
mirror_terminal: ghostty.Terminal,
mirror_stream: ghostty.TerminalStream,
mirror_reply_failed: bool = false,
attachments: [max_attachment_slots]AttachmentState = [_]AttachmentState{.{}} ** max_attachment_slots,
input_dedup: [max_input_dedup_entries]InputDedupEntry = [_]InputDedupEntry{.{}} ** max_input_dedup_entries,
input_dedup_cursor: u8 = 0,
pending_resizes: [max_attachment_slots]PendingResize = [_]PendingResize{.{}} ** max_attachment_slots,
pending_resize_count: u8 = 0,
next_resize_operation: u64 = 1,
attachment_count: u8 = 0,
next_attachment_epoch: u64 = 1,
activity_order: u64 = 0,
controller_key: ?AttachmentKey = null,
lease_epoch: u64 = 0,
reference_count: std.atomic.Value(usize) = .init(0),
mutex: std.Io.Mutex = .init,
actor_done: std.atomic.Value(bool) = .init(false),

pub fn create(
    allocator: std.mem.Allocator,
    io: std.Io,
    executable: []const u8,
    shell: []const u8,
    limits: manifest.Limits,
    registry_revision: *std.atomic.Value(u64),
    id: Id,
    generation: Id,
    name: []const u8,
    geometry: Geometry,
) !*Self {
    const self = try allocator.create(Self);
    errdefer allocator.destroy(self);
    const now = nowMs(io);
    var journal = Journal.init(allocator, limits.journal_bytes);
    errdefer journal.deinit();
    var mirror = try ghostty.Terminal.init(io, allocator, .{
        .cols = geometry.cols,
        .rows = geometry.rows,
        .default_modes = .{ .grapheme_cluster = true },
        .max_scrollback_bytes = limits.scrollback_bytes,
    });
    errdefer mirror.deinit(allocator);

    self.* = .{
        .allocator = allocator,
        .io = io,
        .limits = limits,
        .registry_revision = registry_revision,
        .id = id,
        .generation = generation,
        .name_len = @intCast(name.len),
        .geometry = geometry,
        .initial_geometry = geometry,
        .created_at_ms = now,
        .last_activity_ms = now,
        .checkpoint_at_monotonic_ms = monotonicMs(io),
        .journal = journal,
        .connection = undefined,
        .mirror_terminal = mirror,
        .mirror_stream = undefined,
    };
    @memcpy(self.name[0..name.len], name);
    self.mirror_stream = ghostty.TerminalStream.init(.{
        .allocator = allocator,
        .handler = configuredHandler(&self.mirror_terminal),
        .continuation_max_bytes = continuation_limit,
    });
    errdefer self.mirror_stream.deinit();
    self.connection = try worker.spawn(io, executable, shell, geometry.cols, geometry.rows);
    self.state = .running;
    return self;
}

pub fn destroy(self: *Self) void {
    self.connection.finish(self.io);
    self.mirror_stream.deinit();
    self.mirror_terminal.deinit(self.allocator);
    self.journal.deinit();
    freeCheckpoint(self.allocator, &self.current_checkpoint);
    self.allocator.destroy(self);
}

pub fn run(self: *Self) void {
    defer self.actor_done.store(true, .release);
    defer self.connection.finish(self.io);
    var packet: [worker.packet_capacity + 1]u8 = undefined;
    var failed = false;
    while (true) {
        const message = self.connection.receive(self.io, &packet) catch |err| {
            if (err != error.Canceled) {
                std.log.err("session worker receive failed: {t}", .{err});
            }
            self.markFailed();
            break;
        };
        switch (message.kind) {
            .output => if (!failed) {
                self.acceptOutput(message.payload) catch |err| {
                    std.log.err("session output failed: {t}", .{err});
                    failed = true;
                    self.markFailed();
                    self.connection.terminate(self.io);
                };
            },
            .resize_applied => if (!failed) {
                self.acceptResizeApplied(message.payload) catch |err| {
                    std.log.err("session resize failed: {t}", .{err});
                    failed = true;
                    self.markFailed();
                    self.connection.terminate(self.io);
                };
            },
            .exited => {
                const status = if (message.payload.len == 4)
                    std.mem.readInt(i32, message.payload[0..4], .little)
                else
                    -1;
                if (failed) {
                    self.recordFailedExit(status);
                } else {
                    self.acceptExit(status) catch self.markFailed();
                }
                break;
            },
            else => {},
        }
    }
}

pub fn snapshotMetadata(self: *Self) Metadata {
    self.mutex.lockUncancelable(self.io);
    defer self.mutex.unlock(self.io);
    var result: Metadata = .{
        .id = self.id,
        .generation = self.generation,
        .name = undefined,
        .name_len = self.name_len,
        .title = undefined,
        .title_len = self.title_len,
        .state = self.state,
        .geometry = self.geometry,
        .created_at_ms = self.created_at_ms,
        .last_activity_ms = self.last_activity_ms,
        .exit_status = self.exit_status,
        .event_seq = self.next_event_seq -| 1,
        .output_offset = self.output_offset,
        .checkpoint_event_seq = self.checkpoint_event_seq,
        .checkpoint_bytes = if (self.current_checkpoint) |value| value.bytes.len else 0,
        .attachment_count = self.attachment_count,
        .controller_attachment_id = if (self.controller_key) |key| key.attachment_id else null,
        .lease_epoch = self.lease_epoch,
    };
    @memcpy(result.name[0..self.name_len], self.name[0..self.name_len]);
    @memcpy(result.title[0..self.title_len], self.title[0..self.title_len]);
    return result;
}

pub fn rename(self: *Self, name: []const u8) bool {
    self.mutex.lockUncancelable(self.io);
    defer self.mutex.unlock(self.io);
    if (self.state == .failed) return false;
    @memcpy(self.name[0..name.len], name);
    self.name_len = @intCast(name.len);
    self.last_activity_ms = nowMs(self.io);
    return true;
}

pub fn requestTerminate(self: *Self) bool {
    const accepted = self.markTerminating();
    if (accepted) self.signalTerminate();
    return accepted;
}

pub fn markTerminating(self: *Self) bool {
    self.mutex.lockUncancelable(self.io);
    const accepted = switch (self.state) {
        .running => blk: {
            self.state = .terminating;
            self.last_activity_ms = nowMs(self.io);
            break :blk true;
        },
        .terminating, .exited => true,
        else => false,
    };
    self.mutex.unlock(self.io);
    return accepted;
}

pub fn signalTerminate(self: *Self) void {
    self.connection.terminate(self.io);
}

pub fn applyInput(self: *Self, bytes: []const u8) !void {
    if (bytes.len > self.limits.max_input_bytes) return error.InputTooLarge;
    self.mutex.lockUncancelable(self.io);
    defer self.mutex.unlock(self.io);
    if (self.state != .running) return error.SessionNotRunning;
    try self.connection.send(self.io, .input, bytes);
}

pub fn applyResize(self: *Self, geometry: Geometry) !void {
    if (!manifest.validGeometry(self.limits, geometry.cols, geometry.rows) or
        !manifest.validCellGeometry(geometry.cell_width_px, geometry.cell_height_px)) return error.InvalidGeometry;
    self.mutex.lockUncancelable(self.io);
    defer self.mutex.unlock(self.io);
    _ = try self.applyResizeLocked(geometry);
}

pub fn applyResizeLocked(self: *Self, geometry: Geometry) !u64 {
    if (self.state != .running) return error.SessionNotRunning;
    if (self.pending_resize_count >= max_attachment_slots) return error.ResizePending;

    var pending: ?*PendingResize = null;
    for (&self.pending_resizes) |*value| {
        if (!value.active) {
            pending = value;
            break;
        }
    }
    const slot = pending orelse return error.ResizePending;
    var operation_id = self.next_resize_operation;
    if (operation_id == 0) operation_id = 1;
    self.next_resize_operation = operation_id +% 1;
    if (self.next_resize_operation == 0) self.next_resize_operation = 1;
    slot.* = .{ .active = true, .operation_id = operation_id, .geometry = geometry };
    self.pending_resize_count += 1;
    self.connection.resize(
        self.io,
        operation_id,
        geometry.cols,
        geometry.rows,
        geometry.cell_width_px,
        geometry.cell_height_px,
    ) catch |err| {
        slot.* = .{};
        self.pending_resize_count -= 1;
        return err;
    };
    return operation_id;
}

fn acceptResizeApplied(self: *Self, payload: []const u8) !void {
    if (payload.len != 17) return error.InvalidResizeAck;
    const operation_id = std.mem.readInt(u64, payload[0..8], .little);
    const geometry = Geometry{
        .cols = std.mem.readInt(u16, payload[8..10], .little),
        .rows = std.mem.readInt(u16, payload[10..12], .little),
        .cell_width_px = std.mem.readInt(u16, payload[12..14], .little),
        .cell_height_px = std.mem.readInt(u16, payload[14..16], .little),
    };
    const status = payload[16];

    self.mutex.lockUncancelable(self.io);
    defer self.mutex.unlock(self.io);
    var matched: ?*PendingResize = null;
    for (&self.pending_resizes) |*pending| {
        if (pending.active and pending.operation_id == operation_id) {
            matched = pending;
            break;
        }
    }
    const pending = matched orelse return error.InvalidResizeAck;
    if (pending.geometry.cols != geometry.cols or
        pending.geometry.rows != geometry.rows or
        pending.geometry.cell_width_px != geometry.cell_width_px or
        pending.geometry.cell_height_px != geometry.cell_height_px) return error.InvalidResizeAck;
    pending.* = .{};
    self.pending_resize_count -= 1;
    std.log.info("terminal resize applied: operation_id={d} cols={d} rows={d} cell_width_px={d} cell_height_px={d} ioctl_status={d} sigwinch_expected={}", .{
        operation_id,
        geometry.cols,
        geometry.rows,
        geometry.cell_width_px,
        geometry.cell_height_px,
        status,
        status == 0,
    });
    const promote_after_resize = self.pending_resize_count == 0 and
        self.controller_key == null and
        self.attachment_count != 0;
    if (status != 0) {
        if (promote_after_resize) {
            self.promoteControllerLocked();
            self.bumpRevision();
        }
        return;
    }

    try self.ensureJournalCapacity(0);
    const now = nowMs(self.io);
    try self.mirror_stream.handler.resize(.{
        .cols = geometry.cols,
        .rows = geometry.rows,
        .cell_size_px = .{ .width = geometry.cell_width_px, .height = geometry.cell_height_px },
    });
    self.geometry = geometry;
    try self.journal.appendResize(geometry, self.next_event_seq, self.output_offset, now);
    self.next_event_seq += 1;
    self.bumpRevision();
    self.last_activity_ms = now;
    if (promote_after_resize) self.promoteControllerLocked();
}

fn acceptOutput(self: *Self, bytes: []const u8) !void {
    self.mutex.lockUncancelable(self.io);
    defer self.mutex.unlock(self.io);
    try self.ensureJournalCapacity(bytes.len);
    const now = nowMs(self.io);
    try self.journal.appendOutput(bytes, self.next_event_seq, self.output_offset, now);
    self.next_event_seq += 1;
    self.output_offset = std.math.add(u64, self.output_offset, bytes.len) catch return error.OutputOffsetOverflow;
    self.bytes_since_checkpoint += bytes.len;
    self.last_activity_ms = now;
    self.mirror_stream.nextSlice(bytes);
    if (self.mirror_reply_failed) return error.MirrorReplyFailed;
    if (self.mirror_stream.handler.semantic_failure) return error.MirrorSemanticFailure;
    if (self.bytes_since_checkpoint >= self.limits.checkpoint_output_bytes or
        (monotonicMs(self.io) - self.checkpoint_at_monotonic_ms) >= self.limits.checkpoint_interval_ms)
        try self.createCheckpoint(now);
}

fn acceptExit(self: *Self, status: i32) !void {
    self.mutex.lockUncancelable(self.io);
    defer self.mutex.unlock(self.io);
    try self.ensureJournalCapacity(0);
    const now = nowMs(self.io);
    try self.journal.appendExit(status, self.next_event_seq, self.output_offset, now);
    self.next_event_seq += 1;
    self.exit_status = status;
    self.last_activity_ms = now;
    try self.createCheckpoint(now);
    if (self.attachment_count == 0) self.journal.release();
    self.state = .exited;
    self.bumpRevision();
}

fn recordFailedExit(self: *Self, status: i32) void {
    self.mutex.lockUncancelable(self.io);
    defer self.mutex.unlock(self.io);
    self.exit_status = status;
    self.last_activity_ms = nowMs(self.io);
}

fn ensureJournalCapacity(self: *Self, byte_count: usize) !void {
    if (self.journal.canAppend(byte_count)) return;
    try self.createCheckpoint(nowMs(self.io));
    if (!self.journal.canAppend(byte_count)) {
        self.dropAttachmentsForRetentionLocked();
        self.journal.clear();
    }
    if (!self.journal.canAppend(byte_count)) return error.JournalFull;
}

fn dropAttachmentsForRetentionLocked(self: *Self) void {
    for (&self.attachments) |*slot| slot.active = false;
    self.attachment_count = 0;
    self.controller_key = null;
    self.lease_epoch +%= 1;
    if (self.lease_epoch == 0) self.lease_epoch = 1;
    self.bumpRevision();
}

fn createCheckpoint(self: *Self, now: i64) !void {
    var continuation: std.Io.Writer.Allocating = .init(self.allocator);
    defer continuation.deinit();
    try self.mirror_stream.writeContinuation(&continuation.writer);
    if (continuation.written().len > continuation_limit) return error.ContinuationTooLarge;

    var encoded: std.Io.Writer.Allocating = .init(self.allocator);
    defer encoded.deinit();
    try ghostty.snapshot.encode(self.allocator, &encoded.writer, &self.mirror_terminal, .{
        .continuation = if (continuation.written().len == 0)
            .ground
        else
            .{ .bytes = continuation.written() },
    });
    if (encoded.written().len > self.limits.max_checkpoint_bytes) return error.CheckpointTooLarge;
    const bytes = try encoded.toOwnedSlice();
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(bytes, &digest, .{});
    freeCheckpoint(self.allocator, &self.current_checkpoint);
    self.current_checkpoint = .{
        .bytes = bytes,
        .sha256 = digest,
        .event_seq = self.next_event_seq -| 1,
        .output_offset = self.output_offset,
        .created_at_ms = now,
    };
    self.checkpoint_event_seq = self.next_event_seq -| 1;
    self.checkpoint_at_monotonic_ms = monotonicMs(self.io);
    self.bytes_since_checkpoint = 0;
    if (self.attachment_count == 0) {
        self.journal.clear();
    } else {
        var minimum_acknowledged_event_seq: u64 = std.math.maxInt(u64);
        for (self.attachments) |slot| {
            if (slot.active) {
                minimum_acknowledged_event_seq = @min(
                    minimum_acknowledged_event_seq,
                    slot.acknowledged_event_seq,
                );
            }
        }
        self.journal.discardThrough(minimum_acknowledged_event_seq);
    }
}

fn markFailed(self: *Self) void {
    self.mutex.lockUncancelable(self.io);
    defer self.mutex.unlock(self.io);
    if (self.state != .exited and self.state != .failed) {
        self.state = .failed;
        self.bumpRevision();
    }
    self.last_activity_ms = nowMs(self.io);
}

pub fn bumpRevision(self: *Self) void {
    _ = self.registry_revision.fetchAdd(1, .monotonic);
}

pub fn invalidateControllerLocked(self: *Self) void {
    self.controller_key = null;
    self.lease_epoch +%= 1;
    if (self.lease_epoch == 0) self.lease_epoch = 1;
}

pub fn promoteControllerLocked(self: *Self) void {
    var promoted: ?AttachmentKey = null;
    var greatest_activity_order: u64 = 0;
    for (self.attachments) |slot| {
        if (!slot.active or !slot.live) continue;
        if (promoted == null or slot.activity_order >= greatest_activity_order) {
            promoted = slot.key;
            greatest_activity_order = slot.activity_order;
        }
    }
    self.controller_key = promoted;
    self.lease_epoch +%= 1;
    if (self.lease_epoch == 0) self.lease_epoch = 1;
}

fn freeCheckpoint(allocator: std.mem.Allocator, value: *?Checkpoint) void {
    if (value.*) |checkpoint| allocator.free(checkpoint.bytes);
    value.* = null;
}

fn nowMs(io: std.Io) i64 {
    return std.Io.Clock.real.now(io).toMilliseconds();
}

fn monotonicMs(io: std.Io) i64 {
    return std.Io.Clock.awake.now(io).toMilliseconds();
}

const Handler = ghostty.TerminalStream.Handler;

fn configuredHandler(value: *ghostty.Terminal) Handler {
    var handler = value.vtHandler();
    handler.terminfo_name = "xterm-256color";
    handler.effects.write_pty = effectWritePty;
    handler.effects.title_changed = effectTitle;
    handler.effects.size = effectSize;
    handler.effects.enquiry = effectEnquiry;
    handler.effects.xtversion = effectVersion;
    handler.effects.clipboard_write = null;
    handler.effects.bell = null;
    handler.effects.desktop_notification = null;
    return handler;
}

fn effectSize(handler: *Handler) ?ghostty.size_report.Size {
    const self: *Self = @fieldParentPtr("mirror_terminal", handler.terminal);
    return .{
        .rows = self.geometry.rows,
        .columns = self.geometry.cols,
        .cell_width = self.geometry.cell_width_px,
        .cell_height = self.geometry.cell_height_px,
    };
}

fn effectEnquiry(_: *Handler) []const u8 {
    return "bcwebmux";
}

fn effectVersion(_: *Handler) []const u8 {
    return "bcwebmux 0.1.0";
}

fn effectWritePty(handler: *Handler, bytes: []const u8) void {
    if (bytes.len == 0) return;
    const self: *Self = @fieldParentPtr("mirror_terminal", handler.terminal);
    self.connection.send(self.io, .input, bytes) catch {
        self.mirror_reply_failed = true;
    };
}

fn effectTitle(handler: *Handler) void {
    const self: *Self = @fieldParentPtr("mirror_terminal", handler.terminal);
    const title = handler.terminal.getTitle() orelse return;
    const length = @min(title.len, self.title.len);
    if (self.title_len == length and std.mem.eql(u8, self.title[0..length], title[0..length])) return;
    @memcpy(self.title[0..length], title[0..length]);
    self.title_len = @intCast(length);
    self.bumpRevision();
}

test "journal preserves ordered output and resize" {
    var journal = Journal.init(std.testing.allocator, 1024);
    defer journal.deinit();
    try journal.appendOutput("abc", 1, 0, 10);
    try journal.appendResize(.{ .cols = 90, .rows = 30 }, 2, 3, 11);
    try std.testing.expectEqual(@as(usize, 2), journal.events.items.len);
    try std.testing.expectEqualStrings("abc", journal.output(journal.events.items[0]));
    try std.testing.expectEqual(std.hash.crc.Crc32Iscsi.hash("abc"), journal.events.items[0].crc32c);
    try std.testing.expectEqual(EventKind.resize, journal.events.items[1].kind);
}

test "journal compacts acknowledged prefix" {
    var journal = Journal.init(std.testing.allocator, 1024);
    defer journal.deinit();
    try journal.appendOutput("abc", 1, 0, 10);
    try journal.appendResize(.{ .cols = 90, .rows = 30 }, 2, 3, 11);
    try journal.appendOutput("def", 3, 3, 12);
    try journal.appendOutput("ghi", 4, 6, 13);

    journal.discardThrough(2);
    try std.testing.expectEqual(@as(usize, 2), journal.events.items.len);
    try std.testing.expectEqual(@as(u64, 3), journal.events.items[0].seq);
    try std.testing.expectEqual(@as(u64, 4), journal.events.items[1].seq);
    try std.testing.expectEqualStrings("def", journal.output(journal.events.items[0]));
    try std.testing.expectEqualStrings("ghi", journal.output(journal.events.items[1]));
    try std.testing.expectEqual(@as(u32, 0), journal.events.items[0].byte_start);
    try std.testing.expectEqual(@as(u32, 3), journal.events.items[1].byte_start);
    try std.testing.expectEqualStrings("defghi", journal.bytes.items);

    journal.discardThrough(4);
    try std.testing.expectEqual(@as(usize, 0), journal.events.items.len);
    try std.testing.expectEqual(@as(usize, 0), journal.bytes.items.len);
}

test "journal grows lazily within configured bounds" {
    const byte_limit = 8 * 1024 * 1024;
    var journal = Journal.init(std.testing.allocator, byte_limit);
    defer journal.deinit();

    try std.testing.expectEqual(@as(usize, 0), journal.bytes.capacity);
    try std.testing.expectEqual(@as(usize, 0), journal.events.capacity);

    const data = [_]u8{0} ** (70 * 1024);
    try journal.appendOutput(&data, 1, 0, 10);
    try std.testing.expectEqual(data.len, journal.bytes.items.len);
    try std.testing.expect(journal.bytes.capacity >= data.len);
    try std.testing.expect(journal.bytes.capacity <= byte_limit);
    try std.testing.expect(journal.events.capacity <= max_journal_records);

    journal.release();
    try std.testing.expectEqual(@as(usize, 0), journal.bytes.items.len);
    try std.testing.expectEqual(@as(usize, 0), journal.events.items.len);
    try std.testing.expectEqual(@as(usize, 0), journal.bytes.capacity);
    try std.testing.expectEqual(@as(usize, 0), journal.events.capacity);

    var small_journal = Journal.init(std.testing.allocator, 4);
    defer small_journal.deinit();
    try small_journal.appendOutput("1234", 1, 0, 10);
    try std.testing.expectError(error.JournalFull, small_journal.appendOutput("x", 2, 4, 11));
}
