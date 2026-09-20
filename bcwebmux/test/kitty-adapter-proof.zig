// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

// Requires ghostty-vt's +snapshot,+kitty-graphics profile. These are
// characterizations of the pinned public API, not a graphics adapter.
const std = @import("std");
const ghostty = @import("ghostty-vt");
const testing = std.testing;
const alloc = testing.allocator;
const graphics = ghostty.kitty.graphics;

fn terminal(limit: usize) !ghostty.Terminal {
    try testing.expect(ghostty.sys.decode_png == null);
    return ghostty.Terminal.init(testing.io, alloc, .{
        .cols = 20,
        .rows = 8,
        .kitty_image_storage_limit = limit,
    });
}

fn pending(t: *ghostty.Terminal, id: u32) !graphics.ImageStorage.PendingImage {
    return t.screens.active.kitty_images.addPendingImage(testing.io, alloc, t.screens.active, .{
        .id = id,
        .width = 2,
        .height = 2,
        .format = .rgba,
        .data = .{ .pending = 16 },
    });
}

fn execute(t: *ghostty.Terminal, source: []const u8) !?graphics.Response {
    const cmd = try graphics.CommandParser.parseString(alloc, source);
    defer cmd.deinit(alloc);
    return graphics.execute(testing.io, alloc, t, &cmd);
}

fn display(t: *ghostty.Terminal, source: []const u8) !void {
    const response = (try execute(t, source)) orelse return error.MissingResponse;
    try testing.expectEqualStrings("OK", response.message);
}

fn restore(t: *ghostty.Terminal) !ghostty.Terminal {
    var encoded: std.Io.Writer.Allocating = .init(alloc);
    defer encoded.deinit();
    // All callers are at a ground boundary, with no upload in progress.
    try ghostty.snapshot.encode(alloc, &encoded.writer, t, .{ .continuation = .ground });
    var reader: std.Io.Reader = .fixed(encoded.written());
    var decoded = try ghostty.snapshot.decodeExact(alloc, testing.io, &reader, .{
        .max_continuation_bytes = 0,
    });
    defer decoded.deinit(alloc);
    return decoded.toOwned();
}

fn expectCursor(t: *const ghostty.Terminal, x: u16, y: u16) !void {
    try testing.expectEqual(x, t.screens.active.cursor.x);
    try testing.expectEqual(y, t.screens.active.cursor.y);
}

fn expectGridEqual(a: *const ghostty.Terminal, b: *const ghostty.Terminal) !void {
    try testing.expectEqual(a.cols, b.cols);
    try testing.expectEqual(a.rows, b.rows);
    for (0..a.rows) |y| for (0..a.cols) |x| {
        const point: ghostty.Point = .{ .active = .{ .x = @intCast(x), .y = @intCast(y) } };
        const ac = a.screens.active.pages.getCell(point).?;
        const bc = b.screens.active.pages.getCell(point).?;
        try testing.expectEqual(ac.cell.codepoint(), bc.cell.codepoint());
        try testing.expectEqual(ac.cell.wide, bc.cell.wide);
        try testing.expectEqual(ac.row.wrap, bc.row.wrap);
        try testing.expectEqual(ac.row.kitty_virtual_placeholder, bc.row.kitty_virtual_placeholder);
        try testing.expectEqualDeep(ac.style(), bc.style());
        try testing.expectEqualSlices(u21, ac.node.page().lookupGrapheme(ac.cell) orelse &.{}, bc.node.page().lookupGrapheme(bc.cell) orelse &.{});
    };
    try expectCursor(b, a.screens.active.cursor.x, a.screens.active.cursor.y);
}

test "kitty adapter proof: metadata-only pending image supports placement and deletion without a decoder" {
    var t = try terminal(32);
    defer t.deinit(alloc);
    const storage = &t.screens.active.kitty_images;
    const token = try pending(&t, 42);
    try testing.expectEqual(@as(u32, 42), token.id);
    try testing.expect(token.generation != 0);
    try testing.expectEqual(token.generation, storage.imageById(42).?.generation);
    try testing.expectEqual(@as(usize, 16), storage.total_bytes);
    try testing.expect(storage.imageById(42).?.data.bytes() == null);

    t.setCursorPos(2, 3);
    try display(&t, "a=p,i=42,p=7,c=4,r=3,C=1");
    try expectCursor(&t, 2, 1);
    const placement = storage.placements.get(.{
        .image_id = 42,
        .placement_id = .{ .tag = .external, .id = 7 },
    }).?;
    try testing.expect(placement.location == .pin);
    try testing.expectEqual(@as(u32, 4), placement.columns);
    try testing.expectEqual(@as(u32, 3), placement.rows);
    try testing.expectEqual(@as(u30, 1), storage.imageById(42).?.metadata.placement_count);
    try testing.expect(storage.generation > token.generation);
    try testing.expectEqual(token.generation, storage.imageById(42).?.generation);

    try testing.expect((try execute(&t, "a=d,d=i,i=42,p=7")) == null);
    try testing.expectEqual(@as(usize, 0), storage.placements.count());
    try testing.expectEqual(@as(usize, 16), storage.total_bytes);
    try testing.expect(storage.imageById(42).?.data.isPending());
    try display(&t, "a=p,i=42,p=8,c=4,r=3,U=1");
    try testing.expect(storage.placeholderTarget(42, 8).?.placement.location == .virtual);
    try testing.expect((try execute(&t, "a=d,d=I,i=42")) == null);
    try testing.expectEqual(@as(usize, 0), storage.images.count());
    try testing.expectEqual(@as(usize, 0), storage.placements.count());
    try testing.expectEqual(@as(usize, 0), storage.total_bytes);
    try testing.expect(ghostty.sys.decode_png == null);
}

test "kitty adapter proof: pending replacement and eviction retain identity and reservation semantics" {
    var t = try terminal(32);
    defer t.deinit(alloc);
    const storage = &t.screens.active.kitty_images;
    const first_id = storage.nextImageId(.explicit);
    try testing.expectEqual(@as(u32, 1), first_id);
    const first = try pending(&t, first_id);
    try testing.expectEqual(@as(u32, 2), storage.nextImageId(.explicit));
    try display(&t, "a=p,i=1,p=1,c=1,r=1,C=1");
    const replacement = try pending(&t, first_id);
    try testing.expect(replacement.generation > first.generation);
    try testing.expectEqual(@as(usize, 16), storage.total_bytes);
    try testing.expectEqual(@as(usize, 0), storage.placements.count());
    _ = try pending(&t, 2);
    _ = try pending(&t, 3);
    try testing.expect(storage.imageById(1) == null);
    try testing.expect(storage.imageById(2).?.data.isPending());
    try testing.expect(storage.imageById(3).?.data.isPending());
    try testing.expectEqual(@as(usize, 32), storage.total_bytes);
    try testing.expectEqual(@as(u32, 1), storage.nextImageId(.explicit));
}

test "kitty adapter proof: snapshot preserves text and virtual placeholders but drops both registries and accounting" {
    var t = try terminal(1024);
    defer t.deinit(alloc);
    const storage = &t.screens.active.kitty_images;
    _ = try pending(&t, storage.nextImageId(.explicit));
    const implicit_id = storage.nextImageId(.implicit);
    try testing.expectEqual(@as(u32, 2147483647), implicit_id);
    _ = try pending(&t, implicit_id);
    try display(&t, "a=p,i=2147483647,c=2,r=2,C=1");
    try display(&t, "a=p,i=1,p=7,c=1,r=1,U=1");
    try t.printString("01234567890123456789wrapped 界");
    t.setCursorPos(4, 2);
    try t.setAttribute(.{ .@"256_fg" = 1 });
    try t.printString("\u{10EEEE}\u{0305}\u{0305}");
    const point: ghostty.Point = .{ .active = .{ .x = 1, .y = 3 } };
    const before = t.screens.active.pages.getCell(point).?;
    try testing.expectEqual(graphics.unicode.placeholder, before.cell.codepoint());
    try testing.expect(before.cell.hasGrapheme());
    try testing.expect(before.row.kitty_virtual_placeholder);
    try testing.expectEqual(@as(usize, 2), storage.images.count());
    try testing.expectEqual(@as(usize, 2), storage.placements.count());
    try testing.expectEqual(@as(usize, 32), storage.total_bytes);
    try testing.expectEqual(@as(u32, 1), storage.next_internal_placement_id);

    var restored = try restore(&t);
    defer restored.deinit(alloc);
    try expectGridEqual(&t, &restored);
    const empty = &restored.screens.active.kitty_images;
    try testing.expectEqual(@as(usize, 0), empty.images.count());
    try testing.expectEqual(@as(usize, 0), empty.placements.count());
    try testing.expectEqual(@as(usize, 0), empty.total_bytes);
    try testing.expectEqual(@as(u64, 0), empty.generation);
    try testing.expectEqual(@as(u32, 0), empty.next_internal_placement_id);
    try testing.expectEqual(@as(usize, 1024), storage.total_limit);
    try testing.expectEqual(@as(usize, 10_000_000), empty.total_limit);
    try testing.expectEqual(@as(u32, 2), storage.nextImageId(.explicit));
    try testing.expectEqual(@as(u32, 1), empty.nextImageId(.explicit));
    try testing.expectEqual(implicit_id + 1, storage.nextImageId(.implicit));
    try testing.expectEqual(implicit_id, empty.nextImageId(.implicit));
    // Generations are process-global, not deterministic replicated counters.
    const fresh = try pending(&restored, 1);
    try testing.expect(fresh.generation > storage.imageById(1).?.generation);
}

test "kitty adapter characterization: historical-ID display after snapshot diverges in response cursor and subsequent text" {
    var live = try terminal(1024);
    defer live.deinit(alloc);
    _ = try pending(&live, 42);
    try display(&live, "a=p,i=42,p=1,c=4,r=3");
    try expectCursor(&live, 4, 2);
    var restored = try restore(&live);
    defer restored.deinit(alloc);
    try expectGridEqual(&live, &restored);

    // Same post-checkpoint input, but the historical ID is gone on restore.
    live.setCursorPos(3, 5);
    restored.setCursorPos(3, 5);
    try expectCursor(&live, 4, 2);
    try expectCursor(&restored, 4, 2);
    try display(&live, "a=p,i=42,p=2,c=4,r=3");
    const missing = (try execute(&restored, "a=p,i=42,p=2,c=4,r=3")).?;
    try testing.expectEqualStrings("ENOENT: image not found", missing.message);
    try expectCursor(&live, 8, 4);
    try expectCursor(&restored, 4, 2);
    try testing.expectEqual(@as(usize, 2), live.screens.active.kitty_images.placements.count());
    try testing.expectEqual(@as(usize, 0), restored.screens.active.kitty_images.placements.count());
    try live.printString("X");
    try restored.printString("X");
    const live_point: ghostty.Point = .{ .active = .{ .x = 8, .y = 4 } };
    const restored_point: ghostty.Point = .{ .active = .{ .x = 4, .y = 2 } };
    try testing.expectEqual(@as(u21, 'X'), live.screens.active.pages.getCell(live_point).?.cell.codepoint());
    try testing.expectEqual(@as(u21, 'X'), restored.screens.active.pages.getCell(restored_point).?.cell.codepoint());
    try testing.expect(restored.screens.active.pages.getCell(live_point).?.cell.codepoint() != 'X');
    try testing.expect(live.screens.active.pages.getCell(restored_point).?.cell.codepoint() != 'X');
}
