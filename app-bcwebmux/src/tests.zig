// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

// One native test root avoids running transitive Session/protocol tests once
// per importing module and includes the C transport queue ownership checks.
test {
    _ = @import("protocol.zig");
    _ = @import("vfs.zig");
    _ = @import("Session.zig");
    _ = @import("terminal-graphics-checkpoint");
    _ = @import("SessionRegistry.zig");
    _ = @import("c_api.zig");
}

test "graphics checkpoint continues old-ID placement and subsequent text" {
    const std = @import("std");
    const ghostty = @import("ghostty-vt");
    const gfx = ghostty.kitty.graphics;
    const Graphics = @import("terminal-graphics");
    const checkpoint_codec = @import("terminal-graphics-checkpoint");
    const testing = std.testing;
    const alloc = testing.allocator;
    const io = testing.io;
    var original = try ghostty.Terminal.init(io, alloc, .{ .cols = 20, .rows = 8 });
    defer original.deinit(alloc);
    original.setKittyGraphicsSizeLimit(alloc, 16 * 1024 * 1024);
    const screen = original.screens.active;
    var adapter = Graphics.init(alloc);
    defer adapter.deinit();
    var query = try gfx.CommandParser.parseString(alloc, "a=q,i=42,f=32,s=2,v=2;AQIDBAUGBwgJCgsMDQ4PEA==");
    defer query.deinit(alloc);
    try testing.expectEqualStrings("OK", adapter.execute(&original, &query).?.message);
    try testing.expectEqual(@as(usize, 0), screen.kitty_images.images.count());
    var first = try gfx.CommandParser.parseString(alloc, "a=T,m=1,i=42,f=32,s=2,v=2;AQIDBAUGBwg=");
    defer first.deinit(alloc);
    try testing.expect(adapter.execute(&original, &first) == null);
    try testing.expect(!adapter.safeToCapture());
    var last = try gfx.CommandParser.parseString(alloc, "m=0;CQoLDA0ODxA=");
    defer last.deinit(alloc);
    try testing.expectEqualStrings("OK", adapter.execute(&original, &last).?.message);
    try testing.expect(adapter.safeToCapture());
    try testing.expectEqual(@as(usize, 16), adapter.source(screen, 42, screen.kitty_images.imageById(42).?.generation).?.bytes.len);
    try testing.expectEqualStrings("OK", adapter.execute(&original, &query).?.message);
    try testing.expectEqual(@as(usize, 1), screen.kitty_images.images.count());
    try testing.expect(screen.kitty_images.imageById(42) != null);
    const parent = try gfx.CommandParser.parseString(alloc, "a=p,i=42,p=7,c=2,r=2,C=1");
    defer parent.deinit(alloc);
    try testing.expectEqualStrings("OK", gfx.execute(io, alloc, &original, &parent).?.message);
    const child = try gfx.CommandParser.parseString(alloc, "a=p,i=42,p=8,P=42,Q=7,H=1");
    defer child.deinit(alloc);
    try testing.expectEqualStrings("OK", gfx.execute(io, alloc, &original, &child).?.message);
    var snapshot: std.Io.Writer.Allocating = .init(alloc);
    defer snapshot.deinit();
    try ghostty.snapshot.encode(alloc, &snapshot.writer, &original, .{ .continuation = .ground });
    var graphics: std.Io.Writer.Allocating = .init(alloc);
    defer graphics.deinit();
    try checkpoint_codec.encode(alloc, &graphics.writer, &original);
    var source: std.Io.Reader = .fixed(snapshot.written());
    var decoded = try ghostty.snapshot.decodeExact(alloc, io, &source, .{ .max_continuation_bytes = 0 });
    defer decoded.deinit(alloc);
    var resumed = decoded.toOwned();
    defer resumed.deinit(alloc);
    try checkpoint_codec.restore(alloc, &resumed, graphics.written(), decoded.history_rows);
    try testing.expectEqual(screen.kitty_images.next_image_id, resumed.screens.active.kitty_images.next_image_id);
    try testing.expectEqual(screen.kitty_images.placements.count(), resumed.screens.active.kitty_images.placements.count());
    const replay = try gfx.CommandParser.parseString(alloc, "a=p,i=42,p=9,c=2,r=2,C=1");
    defer replay.deinit(alloc);
    try testing.expectEqualStrings(gfx.execute(io, alloc, &original, &replay).?.message, gfx.execute(io, alloc, &resumed, &replay).?.message);
    var original_stream = ghostty.TerminalStream.init(.{ .allocator = alloc, .handler = original.vtHandler() });
    defer original_stream.deinit();
    var resumed_stream = ghostty.TerminalStream.init(.{ .allocator = alloc, .handler = resumed.vtHandler() });
    defer resumed_stream.deinit();
    original_stream.nextSlice("A");
    resumed_stream.nextSlice("A");
    try testing.expectEqual(original.screens.active.cursor.x, resumed.screens.active.cursor.x);
    try testing.expectEqual(original.screens.active.cursor.y, resumed.screens.active.cursor.y);
    const position: ghostty.Point = .{ .active = .{ .x = original.screens.active.cursor.x - 1, .y = original.screens.active.cursor.y } };
    try testing.expectEqual(original.screens.active.pages.getCell(position).?.cell.codepoint(), resumed.screens.active.pages.getCell(position).?.cell.codepoint());
}

test "graphics checkpoint remaps placements when snapshot history is discarded" {
    const std = @import("std");
    const ghostty = @import("ghostty-vt");
    const gfx = ghostty.kitty.graphics;
    const Graphics = @import("terminal-graphics");
    const checkpoint_codec = @import("terminal-graphics-checkpoint");
    const testing = std.testing;
    const alloc = testing.allocator;
    const io = testing.io;

    var original = try ghostty.Terminal.init(io, alloc, .{
        .cols = 20,
        .rows = 8,
        .max_scrollback_bytes = null,
    });
    defer original.deinit(alloc);
    original.setKittyGraphicsSizeLimit(alloc, 16 * 1024 * 1024);
    const screen = original.screens.active;
    var adapter = Graphics.init(alloc);
    defer adapter.deinit();

    var transmit = try gfx.CommandParser.parseString(
        alloc,
        "a=T,i=42,p=7,f=32,s=2,v=2,c=1,r=1,C=1;AQIDBAUGBwgJCgsMDQ4PEA==",
    );
    defer transmit.deinit(alloc);
    try testing.expectEqualStrings("OK", adapter.execute(&original, &transmit).?.message);

    var stream = ghostty.TerminalStream.init(.{ .allocator = alloc, .handler = original.vtHandler() });
    defer stream.deinit();
    for (0..6000) |_| stream.nextSlice("line\r\n");

    const place = try gfx.CommandParser.parseString(alloc, "a=p,i=42,p=8,c=1,r=1,C=1");
    defer place.deinit(alloc);
    try testing.expectEqualStrings("OK", gfx.execute(io, alloc, &original, &place).?.message);

    const recent_pin = screen.kitty_images.placements.get(.{
        .image_id = 42,
        .placement_id = .{ .tag = .external, .id = 8 },
    }).?.location.pin;
    const recent_point = screen.pages.pointFromPin(.active, recent_pin.*).?;

    screen.pages.limits.set(.bytes, 1);
    var snapshot: std.Io.Writer.Allocating = .init(alloc);
    defer snapshot.deinit();
    try ghostty.snapshot.encode(alloc, &snapshot.writer, &original, .{ .continuation = .ground });
    var graphics: std.Io.Writer.Allocating = .init(alloc);
    defer graphics.deinit();
    try checkpoint_codec.encode(alloc, &graphics.writer, &original);

    var source: std.Io.Reader = .fixed(snapshot.written());
    var decoded = try ghostty.snapshot.decodeExact(alloc, io, &source, .{ .max_continuation_bytes = 0 });
    defer decoded.deinit(alloc);
    var restored = decoded.toOwned();
    defer restored.deinit(alloc);
    try checkpoint_codec.restore(alloc, &restored, graphics.written(), decoded.history_rows);

    const restored_screen = restored.screens.active;
    try testing.expect(restored_screen.pages.scrollbar().total < screen.pages.scrollbar().total);
    try testing.expect(restored_screen.kitty_images.placements.get(.{
        .image_id = 42,
        .placement_id = .{ .tag = .external, .id = 7 },
    }).?.location.pin.garbage);
    const restored_pin = restored_screen.kitty_images.placements.get(.{
        .image_id = 42,
        .placement_id = .{ .tag = .external, .id = 8 },
    }).?.location.pin;
    try testing.expect(!restored_pin.garbage);
    try testing.expectEqual(recent_point, restored_screen.pages.pointFromPin(.active, restored_pin.*).?);
    try testing.expect(restored_screen.kitty_images.imageById(42) != null);
}
