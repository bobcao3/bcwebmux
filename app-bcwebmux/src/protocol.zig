// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");

pub const subprotocol = @import("session_manifest.zig").protocol;
pub const max_header_length: usize = 42;
pub const max_payload_length: usize = 1024 * 1024;
pub const max_frame_length: usize = max_header_length + max_payload_length;
pub const session_id_length: usize = 16;
pub const compressed_flag: u8 = 1;
pub const resize_payload_length: usize = 4;
pub const resize_cols_offset: usize = 0;
pub const resize_rows_offset: usize = 2;

pub const FrameType = enum(u8) {
    hello = 1,
    welcome = 2,
    error_frame = 3,
    session_changed = 4,
    attach = 5,
    attach_begin = 6,
    detach = 7,
    checkpoint_begin = 8,
    checkpoint_chunk = 9,
    checkpoint_end = 10,
    event_batch = 11,
    live_barrier = 12,
    ack = 13,
    credit = 14,
    resync_required = 15,
    claim_control = 16,
    lease_changed = 17,
    input = 18,
    input_ack = 19,
    resize_request = 20,
    canonical_resize = 21,
    exited = 22,
    ping = 23,
    pong = 24,
};

pub const CodecError = error{
    FrameTooShort,
    UnknownType,
    UnknownFlags,
    InvalidDirection,
    PayloadTooLarge,
    OutputTooSmall,
};

pub const Frame = struct {
    frame_type: FrameType,
    flags: u8 = 0,
    request_id: u64 = 0,
    attachment_id: u128 = 0,
    session_id: [session_id_length]u8 = @splat(0),
    payload: []const u8 = &.{},
};

pub fn writeU16LE(bytes: []u8, offset: usize, value: u16) void {
    std.mem.writeInt(u16, bytes[offset..][0..2], value, .little);
}

pub fn writeU32LE(bytes: []u8, offset: usize, value: u32) void {
    std.mem.writeInt(u32, bytes[offset..][0..4], value, .little);
}

pub fn writeU64LE(bytes: []u8, offset: usize, value: u64) void {
    std.mem.writeInt(u64, bytes[offset..][0..8], value, .little);
}

pub fn writeU128LE(bytes: []u8, offset: usize, value: u128) void {
    std.mem.writeInt(u128, bytes[offset..][0..16], value, .little);
}

pub fn readU16LE(bytes: []const u8, offset: usize) u16 {
    return std.mem.readInt(u16, bytes[offset..][0..2], .little);
}

pub fn readU32LE(bytes: []const u8, offset: usize) u32 {
    return std.mem.readInt(u32, bytes[offset..][0..4], .little);
}

pub fn readU64LE(bytes: []const u8, offset: usize) u64 {
    return std.mem.readInt(u64, bytes[offset..][0..8], .little);
}

pub fn readU128LE(bytes: []const u8, offset: usize) u128 {
    return std.mem.readInt(u128, bytes[offset..][0..16], .little);
}

pub fn frameTypeFromInt(value: u8) CodecError!FrameType {
    return std.enums.fromInt(FrameType, value) orelse error.UnknownType;
}

pub fn hasAttachmentId(frame_type: FrameType) bool {
    return switch (frame_type) {
        .hello, .welcome, .session_changed, .ping, .pong => false,
        else => true,
    };
}

pub fn hasRequestId(frame_type: FrameType) bool {
    return switch (frame_type) {
        .hello, .welcome, .error_frame, .attach, .attach_begin, .detach, .live_barrier, .claim_control, .lease_changed, .input, .input_ack, .resize_request, .canonical_resize => true,
        else => false,
    };
}

pub fn headerLengthForType(frame_type: FrameType) usize {
    return 2 + @as(usize, if (hasAttachmentId(frame_type)) 16 else 0) +
        @as(usize, if (hasRequestId(frame_type)) 8 else 0) +
        @as(usize, if (frame_type == .attach) 16 else 0);
}

fn clientType(frame_type: FrameType) bool {
    return switch (frame_type) {
        .hello, .attach, .detach, .ack, .credit, .claim_control, .input, .resize_request, .ping, .pong => true,
        else => false,
    };
}

fn serverType(frame_type: FrameType) bool {
    return !clientType(frame_type) or frame_type == .ping or frame_type == .pong;
}

fn validateFlags(frame_type: FrameType, flags: u8) CodecError!void {
    if (flags & ~compressed_flag != 0) return error.UnknownFlags;
    if (flags != 0 and frame_type != .checkpoint_chunk and frame_type != .event_batch) return error.UnknownFlags;
}

pub fn encodeServerFrame(frame: Frame, output: []u8) CodecError![]u8 {
    if (!serverType(frame.frame_type)) return error.InvalidDirection;
    return encodeFrame(frame, output);
}

pub fn decodeClientFrame(message: []const u8) CodecError!Frame {
    const frame = try decodeFrame(message);
    if (!clientType(frame.frame_type)) return error.InvalidDirection;
    return frame;
}

pub fn encodeFrame(frame: Frame, output: []u8) CodecError![]u8 {
    try validateFlags(frame.frame_type, frame.flags);
    if (frame.payload.len > max_payload_length) return error.PayloadTooLarge;
    const header_length = headerLengthForType(frame.frame_type);
    const total_length = header_length + frame.payload.len;
    if (output.len < total_length) return error.OutputTooSmall;
    output[0] = @backingInt(frame.frame_type);
    output[1] = frame.flags;
    var offset: usize = 2;
    if (hasAttachmentId(frame.frame_type)) {
        writeU128LE(output, offset, frame.attachment_id);
        offset += 16;
    }
    if (hasRequestId(frame.frame_type)) {
        writeU64LE(output, offset, frame.request_id);
        offset += 8;
    }
    if (frame.frame_type == .attach) @memcpy(output[offset..][0..session_id_length], &frame.session_id);
    @memcpy(output[header_length..total_length], frame.payload);
    return output[0..total_length];
}

pub fn decodeFrame(message: []const u8) CodecError!Frame {
    if (message.len < 2) return error.FrameTooShort;
    const frame_type = try frameTypeFromInt(message[0]);
    try validateFlags(frame_type, message[1]);
    const header_length = headerLengthForType(frame_type);
    if (message.len < header_length) return error.FrameTooShort;
    if (message.len - header_length > max_payload_length) return error.PayloadTooLarge;
    var frame = Frame{ .frame_type = frame_type, .flags = message[1], .payload = message[header_length..] };
    var offset: usize = 2;
    if (hasAttachmentId(frame_type)) {
        frame.attachment_id = readU128LE(message, offset);
        offset += 16;
    }
    if (hasRequestId(frame_type)) {
        frame.request_id = readU64LE(message, offset);
        offset += 8;
    }
    if (frame_type == .attach) @memcpy(&frame.session_id, message[offset..][0..session_id_length]);
    return frame;
}

test "compact attach golden bytes preserve all 128 identity bits" {
    var frame = Frame{
        .frame_type = .attach,
        .attachment_id = 0x100f0e0d0c0b0a090807060504030201,
        .request_id = 0x1817161514131211,
        .payload = &.{ 0xaa, 0xbb },
    };
    for (&frame.session_id, 0..) |*byte, index| byte.* = @as(u8, @intCast(index)) + 0xa0;
    var output: [max_header_length + 2]u8 = undefined;
    const encoded = try encodeFrame(frame, &output);
    const expected = [_]u8{
        5,    0,    1,    2,    3,    4,    5,    6,    7,    8,    9,    10,   11,   12,   13,   14,   15,   16,
        0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9,
        0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf, 0xaa, 0xbb,
    };
    try std.testing.expectEqualSlices(u8, &expected, encoded);
    const decoded = try decodeClientFrame(encoded);
    try std.testing.expectEqual(frame.attachment_id, decoded.attachment_id);
    try std.testing.expectEqual(frame.request_id, decoded.request_id);
    try std.testing.expectEqualSlices(u8, &frame.session_id, &decoded.session_id);
    try std.testing.expectEqualSlices(u8, frame.payload, decoded.payload);
}

test "directional codecs and message boundaries for every opcode" {
    const lengths = [_]usize{ 10, 10, 26, 2, 42, 26, 26, 18, 18, 18, 18, 26, 18, 18, 18, 26, 26, 26, 26, 26, 26, 18, 2, 2 };
    const clients = [_]bool{ true, false, false, false, true, false, true, false, false, false, false, false, true, true, false, true, false, true, false, true, false, false, true, true };
    var output: [max_header_length + 3]u8 = undefined;
    for (lengths, clients, 1..) |length, client, opcode| {
        const frame_type = try frameTypeFromInt(@intCast(opcode));
        const frame = Frame{ .frame_type = frame_type, .attachment_id = std.math.maxInt(u128), .request_id = 7, .session_id = @splat(9), .payload = "xyz" };
        const encoded = try encodeFrame(frame, &output);
        try std.testing.expectEqual(length + 3, encoded.len);
        const decoded = try decodeFrame(encoded);
        try std.testing.expectEqualSlices(u8, "xyz", decoded.payload);
        if (length == 2 or length == 10) try std.testing.expectEqual(@as(u128, 0), decoded.attachment_id);
        if (length == 2 or length == 18) try std.testing.expectEqual(@as(u64, 0), decoded.request_id);
        if (frame_type != .attach) try std.testing.expectEqualSlices(u8, &@as([16]u8, @splat(0)), &decoded.session_id);
        for (0..length) |short| try std.testing.expectError(error.FrameTooShort, decodeFrame(encoded[0..short]));
        if (client) {
            _ = try decodeClientFrame(encoded);
        } else {
            try std.testing.expectError(error.InvalidDirection, decodeClientFrame(encoded));
        }
        if (!client or frame_type == .ping or frame_type == .pong) {
            _ = try encodeServerFrame(frame, &output);
        } else {
            try std.testing.expectError(error.InvalidDirection, encodeServerFrame(frame, &output));
        }
    }
}

test "flags, payload limit, and reusable output bounds" {
    var output: [max_header_length]u8 = undefined;
    try std.testing.expectError(error.UnknownType, decodeFrame(&.{ 255, 0 }));
    try std.testing.expectError(error.UnknownFlags, decodeFrame(&.{ 23, 1 }));
    for (std.meta.tags(FrameType)) |frame_type| {
        const frame = Frame{ .frame_type = frame_type, .flags = compressed_flag };
        if (frame_type == .checkpoint_chunk or frame_type == .event_batch) {
            const bytes = try encodeServerFrame(frame, &output);
            try std.testing.expectEqual(compressed_flag, (try decodeFrame(bytes)).flags);
        } else {
            try std.testing.expectError(error.UnknownFlags, encodeFrame(frame, &output));
        }
        try std.testing.expectError(error.UnknownFlags, encodeFrame(.{ .frame_type = frame_type, .flags = 2 }, &output));
    }
    try std.testing.expectError(error.OutputTooSmall, encodeServerFrame(.{ .frame_type = .error_frame }, output[0..25]));
    const bytes = try std.testing.allocator.alloc(u8, max_frame_length + 1);
    defer std.testing.allocator.free(bytes);
    @memset(bytes, 0);
    _ = try encodeFrame(.{ .frame_type = .attach }, bytes);
    _ = try decodeClientFrame(bytes[0..max_frame_length]);
    try std.testing.expectError(error.PayloadTooLarge, decodeClientFrame(bytes));
    const payload = try std.testing.allocator.alloc(u8, max_payload_length + 1);
    defer std.testing.allocator.free(payload);
    try std.testing.expectError(error.PayloadTooLarge, encodeServerFrame(.{ .frame_type = .event_batch, .payload = payload }, &output));
}
