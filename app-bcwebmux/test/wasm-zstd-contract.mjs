// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { constants, createZstdCompress, zstdCompressSync } from "node:zlib";
import { TerminalCore } from "../../wgpuTerminal/src/TerminalCore.js";
import { crc32c, openWasmCore } from "./test-support.mjs";

const wasmPath = process.argv[2] ?? new URL("../zig-out/web/terminal.wasm", import.meta.url);
const core = await openWasmCore(TerminalCore, wasmPath);
const encoder = new TextEncoder();
let replies = "";
core.onReply((bytes) => {
  replies += new TextDecoder().decode(bytes);
});

// Mirrors the server: one never-ending frame, flushed after every event.
function zstdStream(windowLog = 21) {
  const compressor = createZstdCompress({
    params: {
      [constants.ZSTD_c_compressionLevel]: 1,
      [constants.ZSTD_c_windowLog]: windowLog,
      [constants.ZSTD_c_checksumFlag]: 0,
    },
  });
  const chunks = [];
  compressor.on("data", (chunk) => chunks.push(chunk));
  return async (raw) => {
    compressor.write(raw);
    await new Promise((resolve) => compressor.flush(constants.ZSTD_e_flush, resolve));
    await new Promise((resolve) => setImmediate(resolve));
    return new Uint8Array(Buffer.concat(chunks.splice(0)));
  };
}

// Printable pseudo-random text: incompressible on its own, inert to the parser.
function text(length, seed) {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[index] = index % 100 === 99 ? 10 : 33 + ((state >>> 24) % 94);
  }
  return bytes;
}

async function feed(next, raw, length = raw.byteLength, crc = crc32c(raw)) {
  const compressed = await next(raw);
  core.writeZstd(compressed, length, crc);
  return compressed;
}

// A one-byte first event is complete on its own; no preamble is needed.
core.resetZstdStream();
let next = zstdStream();
const before = core.state.rxBytes;
await feed(next, encoder.encode("a"));
replies = "";
await feed(next, encoder.encode("\x1b[5n"));
assert.equal(replies, "\x1b[0n", "decoded bytes reach the parser");

// Matches reaching past the old 128 KiB window decode exactly.
const repeated = text(256 * 1024, 1);
const filler = text(512 * 1024, 2);
let total = 1 + 4;
for (const block of [repeated, filler]) {
  for (let offset = 0; offset < block.byteLength; offset += 64 * 1024) {
    await feed(next, block.subarray(offset, offset + 64 * 1024));
  }
  total += block.byteLength;
}
let repeatWire = 0;
for (let offset = 0; offset < repeated.byteLength; offset += 64 * 1024) {
  repeatWire += (await feed(next, repeated.subarray(offset, offset + 64 * 1024))).byteLength;
}
total += repeated.byteLength;
assert.ok(repeatWire < repeated.byteLength / 50, `long-range repeat compressed to ${repeatWire}`);
replies = "";
await feed(next, encoder.encode("\x1b[5n"));
total += 4;
assert.equal(replies, "\x1b[0n", "stream stays in sync after long-range matches");
assert.equal(core.state.rxBytes - before, total);

// One-shot frames decode beside the stream without disturbing it.
const snapshot = text(300 * 1024, 3);
const frame = zstdCompressSync(snapshot);
const target = new Uint8Array(snapshot.byteLength);
assert.equal(core.decodeZstdFrame(frame, target, crc32c(snapshot)), target);
assert.ok(Buffer.from(target).equals(Buffer.from(snapshot)));
assert.throws(
  () => core.decodeZstdFrame(frame, new Uint8Array(snapshot.byteLength - 1), crc32c(snapshot)),
  /corrupt zstd input|length mismatch/,
);
assert.throws(() => core.decodeZstdFrame(frame, target, crc32c(snapshot) ^ 1), /checksum mismatch/);
replies = "";
await feed(next, encoder.encode("\x1b[5n"));
assert.equal(replies, "\x1b[0n", "frame decoding leaves the stream intact");

// Rejected chunks parse nothing.
async function rejects(pattern, use) {
  core.resetZstdStream();
  next = zstdStream();
  const received = core.state.rxBytes;
  replies = "";
  await assert.rejects(use, pattern);
  assert.equal(replies, "");
  assert.equal(core.state.rxBytes, received);
}
const query = encoder.encode("\x1b[5n");
await rejects(/checksum mismatch/, () => feed(next, query, query.byteLength, crc32c(query) ^ 1));
await rejects(/length mismatch/, () => feed(next, query, query.byteLength + 1));
await rejects(/length mismatch/, () => feed(next, query, query.byteLength - 1));
// A chunk from the middle of an old stream has no frame header.
const old = zstdStream();
await old(query);
const middle = await old(query);
await rejects(/corrupt zstd input/, async () =>
  core.writeZstd(middle, query.byteLength, crc32c(query)),
);
// Windows beyond 8 MiB are refused rather than allocated.
await rejects(/corrupt zstd input/, () => feed(zstdStream(24), query));

// After a rejection, a reset starts a clean stream.
core.resetZstdStream();
next = zstdStream();
replies = "";
await feed(next, query);
assert.equal(replies, "\x1b[0n");
core.dispose();
console.log(JSON.stringify({ streamBytes: total, repeatWireBytes: repeatWire }));
