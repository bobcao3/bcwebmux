// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

pub const size = 64;

fn xorshift32(state: *u32) u32 {
    state.* ^= state.* << 13;
    state.* ^= state.* >> 17;
    state.* ^= state.* << 5;
    return state.*;
}

pub fn generate(values: *[size * size]i8) void {
    var index: usize = 0;
    const uniform_count = values.len / 255;
    var level: i16 = -127;
    while (level <= 127) : (level += 1) {
        var count: usize = 0;
        while (count < uniform_count) : (count += 1) {
            values[index] = @intCast(level);
            index += 1;
        }
    }

    var magnitude: i8 = 1;
    while (magnitude <= 8) : (magnitude += 1) {
        values[index] = -magnitude;
        values[index + 1] = magnitude;
        index += 2;
    }

    var state: u32 = 0x6d2b79f5;
    var remaining = values.len;
    while (remaining > 1) {
        remaining -= 1;
        const swap_index = @as(usize, @intCast(xorshift32(&state) % @as(u32, @intCast(remaining + 1))));
        const temporary = values[remaining];
        values[remaining] = values[swap_index];
        values[swap_index] = temporary;
    }
}
