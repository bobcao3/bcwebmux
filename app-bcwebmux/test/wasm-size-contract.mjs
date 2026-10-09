// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const wasmPath = process.argv[2] ?? new URL("../zig-out/web/terminal.wasm", import.meta.url);
const wasm = new Uint8Array(await readFile(wasmPath));
assert.deepEqual([...wasm.subarray(0, 8)], [0, 97, 115, 109, 1, 0, 0, 0]);

function readUleb(offset) {
  let value = 0;
  let shift = 0;
  for (let count = 0; count < 5; count += 1) {
    const byte = wasm[offset++];
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return [value, offset];
    shift += 7;
  }
  throw new Error("oversized WASM section length");
}

const sections = new Map();
for (let offset = 8; offset < wasm.byteLength;) {
  const id = wasm[offset++];
  const [length, payloadOffset] = readUleb(offset);
  assert.ok(payloadOffset + length <= wasm.byteLength, "truncated WASM section");
  sections.set(id, (sections.get(id) ?? 0) + length);
  offset = payloadOffset + length;
}

const codeBytes = sections.get(10) ?? 0;
const dataBytes = sections.get(11) ?? 0;
// Release ceilings, deliberately raised when a shipped feature needs the room.
assert.ok(codeBytes <= 800 * 1024, `WASM code section exceeded 800 KiB: ${codeBytes}`);
assert.ok(dataBytes <= 1 * 1024 * 1024, `WASM data section exceeded 1 MiB: ${dataBytes}`);
assert.ok(wasm.byteLength <= 2 * 1024 * 1024, `terminal WASM exceeded 2 MiB: ${wasm.byteLength}`);
console.log(JSON.stringify({ wasmBytes: wasm.byteLength, codeBytes, dataBytes }));
