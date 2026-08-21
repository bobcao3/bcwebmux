// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");

pub const subprotocol = "bcw.sessions";
pub const magic: u32 = 0x53574342;
pub const header_length: usize = 64;
pub const max_payload_length: usize = 1024 * 1024;
pub const max_frame_length: usize = header_length + max_payload_length;
pub const session_id_length: usize = 16;
pub const magic_offset: usize = 0;
pub const type_offset: usize = 4;
pub const flags_offset: usize = 5;
pub const header_length_offset: usize = 6;
pub const payload_length_offset: usize = 8;
pub const reserved_offset: usize = 12;
pub const connection_sequence_offset: usize = 16;
pub const request_id_offset: usize = 24;
pub const attachment_id_offset: usize = 32;
pub const attachment_epoch_offset: usize = 40;
pub const session_id_offset: usize = 48;
pub const payload_offset: usize = header_length;
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
    InvalidMagic,
    UnknownType,
    UnknownFlags,
    InvalidHeaderLength,
    ReservedNonZero,
    PayloadTooLarge,
    PayloadMismatch,
    ZeroConnectionSequence,
    OutputTooSmall,
};

pub const Frame = struct {
    frame_type: FrameType,
    flags: u8 = 0,
    header_length: u16 = @intCast(header_length),
    connection_sequence: u64,
    request_id: u64 = 0,
    attachment_id: u64 = 0,
    attachment_epoch: u64 = 0,
    session_id: [session_id_length]u8 = [_]u8{0} ** session_id_length,
    payload: []const u8 = &.{},
};

pub fn writeU16LE(bytes: []u8, offset: usize, value: u16) void {
    bytes[offset] = @truncate(value);
    bytes[offset + 1] = @truncate(value >> 8);
}

pub fn writeU32LE(bytes: []u8, offset: usize, value: u32) void {
    bytes[offset] = @truncate(value);
    bytes[offset + 1] = @truncate(value >> 8);
    bytes[offset + 2] = @truncate(value >> 16);
    bytes[offset + 3] = @truncate(value >> 24);
}

pub fn writeU64LE(bytes: []u8, offset: usize, value: u64) void {
    bytes[offset] = @truncate(value);
    bytes[offset + 1] = @truncate(value >> 8);
    bytes[offset + 2] = @truncate(value >> 16);
    bytes[offset + 3] = @truncate(value >> 24);
    bytes[offset + 4] = @truncate(value >> 32);
    bytes[offset + 5] = @truncate(value >> 40);
    bytes[offset + 6] = @truncate(value >> 48);
    bytes[offset + 7] = @truncate(value >> 56);
}

pub fn readU16LE(bytes: []const u8, offset: usize) u16 {
    return @as(u16, bytes[offset]) | (@as(u16, bytes[offset + 1]) << 8);
}

pub fn readU32LE(bytes: []const u8, offset: usize) u32 {
    return @as(u32, bytes[offset]) |
        (@as(u32, bytes[offset + 1]) << 8) |
        (@as(u32, bytes[offset + 2]) << 16) |
        (@as(u32, bytes[offset + 3]) << 24);
}

pub fn readU64LE(bytes: []const u8, offset: usize) u64 {
    return @as(u64, bytes[offset]) |
        (@as(u64, bytes[offset + 1]) << 8) |
        (@as(u64, bytes[offset + 2]) << 16) |
        (@as(u64, bytes[offset + 3]) << 24) |
        (@as(u64, bytes[offset + 4]) << 32) |
        (@as(u64, bytes[offset + 5]) << 40) |
        (@as(u64, bytes[offset + 6]) << 48) |
        (@as(u64, bytes[offset + 7]) << 56);
}

fn frameTypeFromByte(value: u8) CodecError!FrameType {
    return switch (value) {
        1 => .hello,
        2 => .welcome,
        3 => .error_frame,
        4 => .session_changed,
        5 => .attach,
        6 => .attach_begin,
        7 => .detach,
        8 => .checkpoint_begin,
        9 => .checkpoint_chunk,
        10 => .checkpoint_end,
        11 => .event_batch,
        12 => .live_barrier,
        13 => .ack,
        14 => .credit,
        15 => .resync_required,
        16 => .claim_control,
        17 => .lease_changed,
        18 => .input,
        19 => .input_ack,
        20 => .resize_request,
        21 => .canonical_resize,
        22 => .exited,
        23 => .ping,
        24 => .pong,
        else => error.UnknownType,
    };
}

pub fn frameTypeFromInt(value: u8) CodecError!FrameType {
    return frameTypeFromByte(value);
}

fn allowsCompression(frame_type: FrameType) bool {
    return frame_type == .checkpoint_chunk or frame_type == .event_batch;
}

fn validateFlags(frame_type: FrameType, flags: u8) CodecError!void {
    if (flags & ~compressed_flag != 0) return error.UnknownFlags;
    if (flags & compressed_flag != 0 and !allowsCompression(frame_type)) return error.UnknownFlags;
}

pub fn encodeFrame(frame: Frame, output: []u8) CodecError![]u8 {
    if (frame.header_length != @as(u16, @intCast(header_length))) return error.InvalidHeaderLength;
    try validateFlags(frame.frame_type, frame.flags);
    if (frame.connection_sequence == 0) return error.ZeroConnectionSequence;
    if (frame.payload.len > max_payload_length) return error.PayloadTooLarge;
    if (frame.session_id.len != session_id_length) unreachable;
    const total_length = header_length + frame.payload.len;
    if (output.len < total_length) return error.OutputTooSmall;
    writeU32LE(output, magic_offset, magic);
    output[type_offset] = @intFromEnum(frame.frame_type);
    output[flags_offset] = frame.flags;
    writeU16LE(output, header_length_offset, @intCast(header_length));
    writeU32LE(output, payload_length_offset, @intCast(frame.payload.len));
    writeU32LE(output, reserved_offset, 0);
    writeU64LE(output, connection_sequence_offset, frame.connection_sequence);
    writeU64LE(output, request_id_offset, frame.request_id);
    writeU64LE(output, attachment_id_offset, frame.attachment_id);
    writeU64LE(output, attachment_epoch_offset, frame.attachment_epoch);
    @memcpy(output[session_id_offset .. session_id_offset + session_id_length], std.mem.asBytes(&frame.session_id));
    @memcpy(output[payload_offset..total_length], frame.payload);
    return output[0..total_length];
}

pub fn decodeFrame(message: []const u8) CodecError!Frame {
    if (message.len < header_length) return error.FrameTooShort;
    if (readU32LE(message, magic_offset) != magic) return error.InvalidMagic;
    const frame_type = try frameTypeFromByte(message[type_offset]);
    const flags = message[flags_offset];
    try validateFlags(frame_type, flags);
    if (readU16LE(message, header_length_offset) != header_length) return error.InvalidHeaderLength;
    if (readU32LE(message, reserved_offset) != 0) return error.ReservedNonZero;
    const payload_length_u32 = readU32LE(message, payload_length_offset);
    if (payload_length_u32 > max_payload_length) return error.PayloadTooLarge;
    const payload_length: usize = @intCast(payload_length_u32);
    if (message.len - header_length != payload_length) return error.PayloadMismatch;
    const connection_sequence = readU64LE(message, connection_sequence_offset);
    if (connection_sequence == 0) return error.ZeroConnectionSequence;
    var session_id: [session_id_length]u8 = undefined;
    @memcpy(std.mem.asBytes(&session_id), message[session_id_offset .. session_id_offset + session_id_length]);
    return .{
        .frame_type = frame_type,
        .flags = flags,
        .header_length = @intCast(header_length),
        .connection_sequence = connection_sequence,
        .request_id = readU64LE(message, request_id_offset),
        .attachment_id = readU64LE(message, attachment_id_offset),
        .attachment_epoch = readU64LE(message, attachment_epoch_offset),
        .session_id = session_id,
        .payload = message[payload_offset .. payload_offset + payload_length],
    };
}

test "golden frame and reusable output" {
    var frame = Frame{ .frame_type = .hello, .connection_sequence = 1, .request_id = 2, .attachment_id = 3, .attachment_epoch = 4, .payload = &[_]u8{ 0xaa, 0xbb } };
    for (0..session_id_length) |index| frame.session_id[index] = @intCast(index);
    var output: [header_length + 2]u8 = undefined;
    const encoded = try encodeFrame(frame, &output);
    const expected = [_]u8{
        0x42, 0x43, 0x57, 0x53, 0x01, 0x00, 0x40, 0x00,
        0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
        0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
        0xaa, 0xbb,
    };
    try std.testing.expectEqualSlices(u8, expected[0..], encoded);
    const decoded = try decodeFrame(encoded);
    try std.testing.expectEqual(frame.frame_type, decoded.frame_type);
    try std.testing.expectEqual(frame.connection_sequence, decoded.connection_sequence);
    try std.testing.expectEqualSlices(u8, frame.payload, decoded.payload);
    try std.testing.expectEqual(@as(usize, 2), decoded.payload.len);
}

test "all frame types round trip" {
    const types = [_]FrameType{ .hello, .welcome, .error_frame, .session_changed, .attach, .attach_begin, .detach, .checkpoint_begin, .checkpoint_chunk, .checkpoint_end, .event_batch, .live_barrier, .ack, .credit, .resync_required, .claim_control, .lease_changed, .input, .input_ack, .resize_request, .canonical_resize, .exited, .ping, .pong };
    var output: [header_length]u8 = undefined;
    for (types) |frame_type| {
        const encoded = try encodeFrame(.{ .frame_type = frame_type, .connection_sequence = 1 }, &output);
        const decoded = try decodeFrame(encoded);
        try std.testing.expectEqual(frame_type, decoded.frame_type);
        try std.testing.expectEqual(@intFromEnum(frame_type), @intFromEnum(decoded.frame_type));
    }
}

test "truncated and malformed frames are rejected" {
    const frame = Frame{ .frame_type = .hello, .connection_sequence = 1 };
    var bytes: [header_length]u8 = undefined;
    const encoded = try encodeFrame(frame, &bytes);
    for (0..header_length) |length| try std.testing.expectError(error.FrameTooShort, decodeFrame(encoded[0..length]));
    bytes[magic_offset] ^= 1;
    try std.testing.expectError(error.InvalidMagic, decodeFrame(&bytes));
    bytes = undefined;
    _ = try encodeFrame(frame, &bytes);
    bytes[type_offset] = 0xff;
    try std.testing.expectError(error.UnknownType, decodeFrame(&bytes));
    _ = try encodeFrame(frame, &bytes);
    bytes[flags_offset] = 2;
    try std.testing.expectError(error.UnknownFlags, decodeFrame(&bytes));
    _ = try encodeFrame(frame, &bytes);
    writeU16LE(&bytes, header_length_offset, @intCast(header_length - 1));
    try std.testing.expectError(error.InvalidHeaderLength, decodeFrame(&bytes));
    _ = try encodeFrame(frame, &bytes);
    writeU32LE(&bytes, reserved_offset, 1);
    try std.testing.expectError(error.ReservedNonZero, decodeFrame(&bytes));
    _ = try encodeFrame(frame, &bytes);
    writeU32LE(&bytes, payload_length_offset, 1);
    try std.testing.expectError(error.PayloadMismatch, decodeFrame(&bytes));
    _ = try encodeFrame(frame, &bytes);
    writeU64LE(&bytes, connection_sequence_offset, 0);
    try std.testing.expectError(error.ZeroConnectionSequence, decodeFrame(&bytes));
}

test "compression and payload limits are bounded" {
    const compressed = Frame{ .frame_type = .checkpoint_chunk, .flags = compressed_flag, .connection_sequence = 1 };
    var output: [header_length]u8 = undefined;
    _ = try encodeFrame(compressed, &output);
    try std.testing.expectError(error.UnknownFlags, encodeFrame(.{ .frame_type = .hello, .flags = compressed_flag, .connection_sequence = 1 }, &output));
    try std.testing.expectError(error.UnknownFlags, encodeFrame(.{ .frame_type = .event_batch, .flags = 2, .connection_sequence = 1 }, &output));
    var header: [header_length]u8 = undefined;
    _ = try encodeFrame(.{ .frame_type = .hello, .connection_sequence = 1 }, &header);
    writeU32LE(&header, payload_length_offset, @intCast(max_payload_length + 1));
    try std.testing.expectError(error.PayloadTooLarge, decodeFrame(&header));
    const oversized = try std.testing.allocator.alloc(u8, max_payload_length + 1);
    defer std.testing.allocator.free(oversized);
    try std.testing.expectError(error.PayloadTooLarge, encodeFrame(.{ .frame_type = .input, .connection_sequence = 1, .payload = oversized }, &output));
    try std.testing.expectError(error.OutputTooSmall, encodeFrame(.{ .frame_type = .input, .connection_sequence = 1 }, &[_]u8{}));
}

test "little-endian integer helpers" {
    var bytes: [14]u8 = undefined;
    writeU16LE(&bytes, 0, 0x1234);
    writeU32LE(&bytes, 2, 0x12345678);
    writeU64LE(&bytes, 6, 0x123456789abcdef0);
    try std.testing.expectEqual(@as(u16, 0x1234), readU16LE(&bytes, 0));
    try std.testing.expectEqual(@as(u32, 0x12345678), readU32LE(&bytes, 2));
    try std.testing.expectEqual(@as(u64, 0x123456789abcdef0), readU64LE(&bytes, 6));
}
