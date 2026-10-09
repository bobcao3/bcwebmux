// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

//! zstd input for a terminal: one continuous stream whose chunks each end on a
//! flush boundary, plus independent one-shot frames. Decoded bytes are length-
//! and CRC-32C-checked before anything consumes them.

const std = @import("std");
const FontEngine = @import("FontEngine.zig");
const c = @cImport({
    @cDefine("ZSTD_STATIC_LINKING_ONLY", "1");
    @cInclude("zstd.h");
});

const Self = @This();

const alloc = std.heap.wasm_allocator;
// The sender chooses the stream window; cap what one terminal may be asked to hold.
const max_window_log = 23;
pub const max_input_len = 1024 * 1024;
pub const max_output_len = 1024 * 1024;

pub const Error = error{ OutOfMemory, CorruptInput, LengthMismatch, ChecksumMismatch };

stream: ?*c.ZSTD_DCtx = null,
frame: ?*c.ZSTD_DCtx = null,
input: []u8 = &.{},
output: []u8 = &.{},
output_len: usize = 0,

const custom_mem: c.ZSTD_customMem = .{
    .customAlloc = zstdAlloc,
    .customFree = zstdFree,
    .@"opaque" = null,
};

fn zstdAlloc(_: ?*anyopaque, size: usize) callconv(.c) ?*anyopaque {
    return FontEngine.cAlloc(size);
}

fn zstdFree(_: ?*anyopaque, pointer: ?*anyopaque) callconv(.c) void {
    FontEngine.cFree(pointer);
}

pub fn deinit(self: *Self) void {
    if (self.stream) |context| _ = c.ZSTD_freeDCtx(context);
    if (self.frame) |context| _ = c.ZSTD_freeDCtx(context);
    alloc.free(self.input);
    alloc.free(self.output);
    self.* = .{};
}

/// Returns staging space for `len` compressed bytes; earlier contents are not kept.
pub fn reserve(self: *Self, len: usize) ?[]u8 {
    if (len == 0 or len > max_input_len) return null;
    self.input = grow(self.input, len) catch return null;
    return self.input[0..len];
}

/// The bytes produced by the last successful decode.
pub fn decoded(self: *const Self) []const u8 {
    return self.output[0..self.output_len];
}

/// Starts a new stream; the next chunk must begin with a frame header.
pub fn resetStream(self: *Self) Error!void {
    if (self.stream) |context| {
        if (c.ZSTD_isError(c.ZSTD_DCtx_reset(context, c.ZSTD_reset_session_only)) != 0) return error.CorruptInput;
    } else {
        self.stream = try createContext();
    }
}

/// Decodes the next `len` staged bytes of the stream. They must expand to
/// exactly `raw_len` bytes whose CRC-32C is `crc32c`.
pub fn decodeStream(self: *Self, len: usize, raw_len: usize, crc32c: u32) Error![]const u8 {
    self.output_len = 0;
    const context = self.stream orelse return error.CorruptInput;
    if (len == 0 or len > self.input.len) return error.LengthMismatch;
    const output = try self.outputBuffer(raw_len);
    var source: c.ZSTD_inBuffer = .{ .src = self.input.ptr, .size = len, .pos = 0 };
    var destination: c.ZSTD_outBuffer = .{ .dst = output.ptr, .size = output.len, .pos = 0 };
    while (source.pos < source.size or destination.pos < destination.size) {
        const source_before = source.pos;
        const destination_before = destination.pos;
        if (c.ZSTD_isError(c.ZSTD_decompressStream(context, &destination, &source)) != 0) return error.CorruptInput;
        if (source.pos == source_before and destination.pos == destination_before) return error.LengthMismatch;
    }
    // The chunk ended on a flush boundary, so nothing may remain past raw_len.
    var extra: u8 = undefined;
    var probe: c.ZSTD_outBuffer = .{ .dst = &extra, .size = 1, .pos = 0 };
    var empty: c.ZSTD_inBuffer = .{ .src = self.input.ptr, .size = 0, .pos = 0 };
    if (c.ZSTD_isError(c.ZSTD_decompressStream(context, &probe, &empty)) != 0) return error.CorruptInput;
    if (probe.pos != 0) return error.LengthMismatch;
    return self.verify(output, crc32c);
}

/// Decodes `len` staged bytes holding complete frames that expand to exactly
/// `raw_len` bytes whose CRC-32C is `crc32c`. The stream is unaffected.
pub fn decodeFrame(self: *Self, len: usize, raw_len: usize, crc32c: u32) Error![]const u8 {
    self.output_len = 0;
    if (len == 0 or len > self.input.len) return error.LengthMismatch;
    const context = self.frame orelse context: {
        self.frame = try createContext();
        break :context self.frame.?;
    };
    const output = try self.outputBuffer(raw_len);
    const written = c.ZSTD_decompressDCtx(context, output.ptr, output.len, self.input.ptr, len);
    if (c.ZSTD_isError(written) != 0) return error.CorruptInput;
    if (written != raw_len) return error.LengthMismatch;
    return self.verify(output, crc32c);
}

fn createContext() Error!*c.ZSTD_DCtx {
    const context = c.ZSTD_createDCtx_advanced(custom_mem) orelse return error.OutOfMemory;
    if (c.ZSTD_isError(c.ZSTD_DCtx_setParameter(context, c.ZSTD_d_windowLogMax, max_window_log)) != 0) {
        _ = c.ZSTD_freeDCtx(context);
        return error.OutOfMemory;
    }
    return context;
}

fn outputBuffer(self: *Self, raw_len: usize) Error![]u8 {
    if (raw_len == 0 or raw_len > max_output_len) return error.LengthMismatch;
    self.output = try grow(self.output, raw_len);
    return self.output[0..raw_len];
}

fn verify(self: *Self, output: []const u8, crc32c: u32) Error![]const u8 {
    if (std.hash.crc.Crc32Iscsi.hash(output) != crc32c) return error.ChecksumMismatch;
    self.output_len = output.len;
    return output;
}

fn grow(buffer: []u8, len: usize) error{OutOfMemory}![]u8 {
    if (buffer.len >= len) return buffer;
    const replacement = try alloc.alloc(u8, len);
    alloc.free(buffer);
    return replacement;
}
