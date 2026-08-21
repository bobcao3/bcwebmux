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
    bytes: std.ArrayListUnmanaged(u8) = .empty,
    events: std.ArrayListUnmanaged(Event) = .empty,
    byte_limit: usize,

    pub fn init(allocator: std.mem.Allocator, byte_limit: usize) !Journal {
        var value: Journal = .{ .byte_limit = byte_limit };
        errdefer value.deinit(allocator);
        try value.bytes.ensureTotalCapacity(allocator, byte_limit);
        try value.events.ensureTotalCapacity(allocator, max_journal_records);
        return value;
    }

    pub fn deinit(self: *Journal, allocator: std.mem.Allocator) void {
        self.bytes.deinit(allocator);
        self.events.deinit(allocator);
        self.* = undefined;
    }

    pub fn clear(self: *Journal) void {
        self.bytes.clearRetainingCapacity();
        self.events.clearRetainingCapacity();
    }

    pub fn canAppend(self: *const Journal, byte_count: usize) bool {
        return byte_count <= self.byte_limit -| self.bytes.items.len and self.events.items.len < max_journal_records;
    }

    pub fn appendOutput(self: *Journal, bytes: []const u8, seq: u64, offset: u64, timestamp_ms: i64) !void {
        if (!self.canAppend(bytes.len)) return error.JournalFull;
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
created_at_ms: i64,
last_activity_ms: i64,
exit_status: ?i32 = null,
next_event_seq: u64 = 1,
output_offset: u64 = 0,
bytes_since_checkpoint: usize = 0,
checkpoint_event_seq: u64 = 0,
checkpoint_at_monotonic_ms: i64,
current_checkpoint: ?Checkpoint = null,
previous_checkpoint: ?Checkpoint = null,
journal: Journal,
connection: worker.Connection,
mirror_terminal: ghostty.Terminal,
mirror_stream: ghostty.TerminalStream,
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
    var journal = try Journal.init(allocator, limits.journal_bytes);
    errdefer journal.deinit(allocator);
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
    self.connection.close();
    self.mirror_stream.deinit();
    self.mirror_terminal.deinit(self.allocator);
    self.journal.deinit(self.allocator);
    freeCheckpoint(self.allocator, &self.current_checkpoint);
    freeCheckpoint(self.allocator, &self.previous_checkpoint);
    self.allocator.destroy(self);
}

pub fn run(self: *Self) void {
    defer self.actor_done.store(true, .release);
    var packet: [worker.packet_capacity]u8 = undefined;
    var failed = false;
    while (true) {
        const message = self.connection.receive(&packet) catch {
            self.markFailed();
            break;
        };
        switch (message.kind) {
            .output => if (!failed) {
                self.acceptOutput(message.payload) catch {
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
    self.connection.close();
    _ = self.connection.child.wait(self.io) catch {};
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
    if (!manifest.validGeometry(self.limits, geometry.cols, geometry.rows)) return error.InvalidGeometry;
    self.mutex.lockUncancelable(self.io);
    defer self.mutex.unlock(self.io);
    if (self.state != .running) return error.SessionNotRunning;
    try self.ensureJournalCapacity(0);
    const now = nowMs(self.io);
    try self.connection.resize(self.io, geometry.cols, geometry.rows);
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
    if (!self.journal.canAppend(byte_count)) return error.JournalFull;
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
    freeCheckpoint(self.allocator, &self.previous_checkpoint);
    self.previous_checkpoint = self.current_checkpoint;
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
    self.journal.clear();
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

fn bumpRevision(self: *Self) void {
    _ = self.registry_revision.fetchAdd(1, .monotonic);
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

fn effectWritePty(handler: *Handler, bytes: [:0]const u8) void {
    if (bytes.len == 0) return;
    const self: *Self = @fieldParentPtr("mirror_terminal", handler.terminal);
    self.connection.send(self.io, .input, bytes) catch {};
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
    var journal = try Journal.init(std.testing.allocator, 1024);
    defer journal.deinit(std.testing.allocator);
    try journal.appendOutput("abc", 1, 0, 10);
    try journal.appendResize(.{ .cols = 90, .rows = 30 }, 2, 3, 11);
    try std.testing.expectEqual(@as(usize, 2), journal.events.items.len);
    try std.testing.expectEqualStrings("abc", journal.output(journal.events.items[0]));
    try std.testing.expectEqual(std.hash.crc.Crc32Iscsi.hash("abc"), journal.events.items[0].crc32c);
    try std.testing.expectEqual(EventKind.resize, journal.events.items[1].kind);
}
