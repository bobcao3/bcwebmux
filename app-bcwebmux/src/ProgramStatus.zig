// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");
const ghostty = @import("ghostty-vt");
const Protocol = ghostty.osc.Command.ProgramStatus;
const Self = @This();

pub const Summary = struct {
    state: Protocol.State,
    kind: ?Protocol.Kind = null,
    progress: ?u8 = null,
};

const Record = struct {
    id: [128]u8 = undefined,
    id_len: u8,
    status: Summary,

    fn idSlice(self: *const Record) []const u8 {
        return self.id[0..self.id_len];
    }
};

records: [64]Record = undefined,
len: usize = 0,

pub fn summary(self: *const Self) ?Summary {
    var result: ?Summary = null;
    for (self.records[0..self.len]) |record| {
        if (result == null or priority(record.status.state) >= priority(result.?.state)) {
            result = record.status;
        }
    }
    return result;
}

pub fn update(self: *Self, report: Protocol.Report) bool {
    const before = self.summary();
    const id = report.readOption(.id) orelse "";
    var index: usize = 0;
    while (index < self.len) {
        const stored_id = self.records[index].idSlice();
        const matches = if (report.state == .clear)
            id.len == 0 or std.mem.eql(u8, stored_id, id) or
                (std.mem.startsWith(u8, stored_id, id) and stored_id.len > id.len and stored_id[id.len] == '/')
        else
            std.mem.eql(u8, stored_id, id);
        if (matches) self.remove(index) else index += 1;
    }
    if (report.state != .clear) {
        if (self.len == self.records.len) self.remove(0);
        const record = &self.records[self.len];
        record.* = .{
            .id_len = @intCast(id.len),
            .status = .{
                .state = report.state,
                .kind = report.readOption(.kind),
                .progress = report.readOption(.progress),
            },
        };
        @memcpy(record.id[0..id.len], id);
        self.len += 1;
    }
    return !std.meta.eql(before, self.summary());
}

pub fn finishCommand(self: *Self) bool {
    const before = self.summary();
    var index: usize = 0;
    while (index < self.len) {
        switch (self.records[index].status.state) {
            .working, .blocked, .idle => self.remove(index),
            else => index += 1,
        }
    }
    return !std.meta.eql(before, self.summary());
}

fn remove(self: *Self, index: usize) void {
    std.mem.copyForwards(Record, self.records[index .. self.len - 1], self.records[index + 1 .. self.len]);
    self.len -= 1;
}

fn priority(state: Protocol.State) u8 {
    return switch (state) {
        .clear => 0,
        .idle => 1,
        .done => 2,
        .working => 3,
        .blocked => 4,
        .@"error" => 5,
    };
}

test "status records copy IDs, replace fields, and clear only the addressed subtree" {
    var status: Self = .{};
    var data = "id=build/test:kind=auth:progress=42".*;
    try std.testing.expect(status.update(.{ .state = .blocked, .data = &data }));
    @memset(&data, 'x');
    try std.testing.expect(!status.update(.{ .state = .working, .data = "id=build" }));
    _ = status.update(.{ .state = .done, .data = "id=builder" });
    try std.testing.expect(status.update(.{ .state = .idle, .data = "id=build/test" }));
    try std.testing.expectEqual(Protocol.State.working, status.summary().?.state);
    try std.testing.expect(status.update(.{ .state = .clear, .data = "id=build" }));
    try std.testing.expectEqual(Protocol.State.done, status.summary().?.state);
    try std.testing.expectEqual(@as(usize, 1), status.len);
    _ = status.update(.{ .state = .blocked, .data = "kind=permission:progress=75" });
    try std.testing.expectEqual(@as(?u8, 75), status.summary().?.progress);
    _ = status.update(.{ .state = .blocked });
    try std.testing.expectEqual(@as(?u8, null), status.summary().?.progress);
    try std.testing.expectEqual(@as(?Protocol.Kind, null), status.summary().?.kind);
    try std.testing.expect(status.update(.{ .state = .clear }));
    try std.testing.expectEqual(@as(?Summary, null), status.summary());
}

test "record capacity evicts the least recently updated ID and command completion retains results" {
    var status: Self = .{};
    _ = status.update(.{ .state = .@"error", .data = "id=old" });
    _ = status.update(.{ .state = .done, .data = "id=seen" });
    var buffer: [32]u8 = undefined;
    for (0..62) |index| {
        _ = status.update(.{ .state = .working, .data = try std.fmt.bufPrint(&buffer, "id=task{d}", .{index}) });
    }
    _ = status.update(.{ .state = .done, .data = "id=seen" });
    _ = status.update(.{ .state = .blocked, .data = "id=new" });
    try std.testing.expectEqual(@as(usize, 64), status.len);
    try std.testing.expectEqual(Protocol.State.blocked, status.summary().?.state);
    try std.testing.expect(status.finishCommand());
    try std.testing.expectEqual(Protocol.State.done, status.summary().?.state);
    try std.testing.expectEqual(@as(usize, 1), status.len);
    _ = status.update(.{ .state = .working });
    _ = status.update(.{ .state = .@"error", .data = "id=latest" });
    try std.testing.expectEqual(Protocol.State.@"error", status.summary().?.state);
    _ = status.finishCommand();
    try std.testing.expectEqual(Protocol.State.@"error", status.summary().?.state);
}
