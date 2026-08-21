// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const WEB_ROOT = process.argv[2];
assert.ok(WEB_ROOT, "usage: node test/session-checkpoint-contract.mjs WEB_ROOT");
const [{ appendCheckpoint }, { crc32c }, { COMPRESSED_FLAG, writeUint32LE }] = await Promise.all([
  import(pathToFileURL(path.resolve(WEB_ROOT, "SessionCheckpoint.js")).href),
  import(pathToFileURL(path.resolve(WEB_ROOT, "SessionWire.js")).href),
  import(pathToFileURL(path.resolve(WEB_ROOT, "protocol.js")).href),
]);

function makeChunk(raw, offset, crcOverride = crc32c(raw)) {
  const encoded = spawnSync("zstd", ["-q", "-c"], { input: raw });
  assert.equal(encoded.status, 0, encoded.stderr?.toString() || "zstd failed");
  const compressed = new Uint8Array(encoded.stdout.buffer, encoded.stdout.byteOffset, encoded.stdout.byteLength);
  const payload = new Uint8Array(16 + compressed.byteLength);
  writeUint32LE(payload, 0, offset);
  writeUint32LE(payload, 4, raw.byteLength);
  writeUint32LE(payload, 8, crcOverride);
  writeUint32LE(payload, 12, compressed.byteLength);
  payload.set(compressed, 16);
  return payload;
}

const first = Uint8Array.from({ length: 256 * 1024 }, (_, index) => index & 0xff);
const raw = new TextEncoder().encode("checkpoint chunks decompress directly into their destination");
const firstChunk = makeChunk(first, 0);
const secondChunk = makeChunk(raw, first.byteLength);

const totalBytes = first.byteLength + raw.byteLength;
const checkpoint = new Uint8Array(totalBytes);
Object.defineProperty(checkpoint, "set", {
  value() { throw new Error("checkpoint chunk performed a redundant destination copy"); },
});
const record = { checkpoint, checkpointOffset: 0 };
const firstRestored = appendCheckpoint(record, { flags: COMPRESSED_FLAG, payload: firstChunk });
const secondRestored = appendCheckpoint(record, { flags: COMPRESSED_FLAG, payload: secondChunk });
assert.equal(firstRestored, first.byteLength);
assert.equal(secondRestored, raw.byteLength);
assert.equal(record.checkpointOffset, totalBytes);
assert.ok(Buffer.from(checkpoint.subarray(0, first.byteLength)).equals(Buffer.from(first)));
assert.ok(Buffer.from(checkpoint.subarray(first.byteLength)).equals(Buffer.from(raw)));

const corruptRecord = { checkpoint: new Uint8Array(raw.byteLength), checkpointOffset: 0 };
assert.throws(() => appendCheckpoint(corruptRecord, {
  flags: COMPRESSED_FLAG,
  payload: makeChunk(raw, 0, crc32c(raw) ^ 1),
}));
assert.equal(corruptRecord.checkpointOffset, 0);

const gapRecord = { checkpoint: new Uint8Array(raw.byteLength), checkpointOffset: 0 };
assert.throws(() => appendCheckpoint(gapRecord, {
  flags: COMPRESSED_FLAG,
  payload: makeChunk(raw, 1),
}));
assert.equal(gapRecord.checkpointOffset, 0);

console.log(JSON.stringify({ sessionCheckpointContract: "ok", bytes: totalBytes }));
