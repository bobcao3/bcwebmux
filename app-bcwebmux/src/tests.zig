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
    try checkpoint_codec.restore(alloc, &resumed, graphics.written());
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
