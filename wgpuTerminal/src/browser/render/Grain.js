// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

export const GRAIN_SIZE = 64;

export function generateGrain() {
  const values = new Int8Array(GRAIN_SIZE * GRAIN_SIZE);
  let index = 0;
  const uniformCount = Math.floor(values.length / 255);
  for (let level = -127; level <= 127; level += 1) {
    for (let count = 0; count < uniformCount; count += 1) values[index++] = level;
  }
  for (let magnitude = 1; magnitude <= 8; magnitude += 1) {
    values[index++] = -magnitude;
    values[index++] = magnitude;
  }
  let state = 0x6d2b79f5;
  for (let remaining = values.length - 1; remaining > 0; remaining -= 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const swapIndex = (state >>> 0) % (remaining + 1);
    const temporary = values[remaining];
    values[remaining] = values[swapIndex];
    values[swapIndex] = temporary;
  }
  return values;
}
