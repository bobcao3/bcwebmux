// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { zstdCompressSync } from "node:zlib";
import { crc32c, openWasmCore } from "./test-support.mjs";

const WEB_ROOT = process.argv[2];
assert.ok(WEB_ROOT, "usage: node test/session-checkpoint-contract.mjs WEB_ROOT");
const [
  { appendCheckpoint, ensureShadow, finishCheckpoint, resetCheckpointTransaction, rollbackShadow },
  { COMPRESSED_FLAG, writeUint32LE },
  { TerminalCore },
] = await Promise.all([
  import(pathToFileURL(path.resolve(WEB_ROOT, "SessionCheckpoint.js")).href),
  import(pathToFileURL(path.resolve(WEB_ROOT, "protocol.js")).href),
  import(pathToFileURL(path.resolve(WEB_ROOT, "wgpuTerminal/src/TerminalCore.js")).href),
]);
// Chunks decode in the receiving core's WASM, as in the browser.
const decoderCore = await openWasmCore(TerminalCore, path.resolve(WEB_ROOT, "terminal.wasm"));

function makeChunk(raw, offset, crcOverride = crc32c(raw)) {
  const compressed = zstdCompressSync(raw);
  const payload = new Uint8Array(16 + compressed.byteLength);
  writeUint32LE(payload, 0, offset);
  writeUint32LE(payload, 4, raw.byteLength);
  writeUint32LE(payload, 8, crcOverride);
  writeUint32LE(payload, 12, compressed.byteLength);
  payload.set(compressed, 16);
  return payload;
}

const first = Uint8Array.from({ length: 4096 }, (_, index) => index & 0xff);
const raw = new TextEncoder().encode(
  "checkpoint chunks decompress directly into their destination",
);
const firstChunk = makeChunk(first, 0);
const secondChunk = makeChunk(raw, first.byteLength);

const totalBytes = first.byteLength + raw.byteLength;
const checkpoint = new Uint8Array(totalBytes);
const record = { core: decoderCore, checkpoint, checkpointOffset: 0 };
const firstRestored = appendCheckpoint(record, { flags: COMPRESSED_FLAG, payload: firstChunk });
const secondRestored = appendCheckpoint(record, { flags: COMPRESSED_FLAG, payload: secondChunk });
assert.equal(firstRestored, first.byteLength);
assert.equal(secondRestored, raw.byteLength);
assert.equal(record.checkpointOffset, totalBytes);
assert.ok(Buffer.from(checkpoint.subarray(0, first.byteLength)).equals(Buffer.from(first)));
assert.ok(Buffer.from(checkpoint.subarray(first.byteLength)).equals(Buffer.from(raw)));

const corruptRecord = {
  core: decoderCore,
  checkpoint: new Uint8Array(raw.byteLength),
  checkpointOffset: 0,
};
assert.throws(
  () =>
    appendCheckpoint(corruptRecord, {
      flags: COMPRESSED_FLAG,
      payload: makeChunk(raw, 0, (crc32c(raw) ^ 1) >>> 0),
    }),
  /corrupt checkpoint chunk/,
);
assert.equal(corruptRecord.checkpointOffset, 0);

const gapRecord = {
  core: decoderCore,
  checkpoint: new Uint8Array(raw.byteLength),
  checkpointOffset: 0,
};
assert.throws(() =>
  appendCheckpoint(gapRecord, {
    flags: COMPRESSED_FLAG,
    payload: makeChunk(raw, 1),
  }),
);
assert.equal(gapRecord.checkpointOffset, 0);

// Same logical ID and epoch in a successor must not authorize old async work.
const core = () => ({
  disposed: 0,
  onData() {
    return { dispose() {} };
  },
  dispose() {
    this.disposed++;
  },
});
const original = core(),
  late = core();
const attempt = { cancel: new AbortController(), retired: false };
const shadowRecord = {
  active: true,
  attachmentId: 1n,
  epoch: 1n,
  core: original,
  attempt,
  eventSeq: 7n,
  outputOffset: 9n,
};
const records = new Map([["1", shadowRecord]]);
let create;
const pendingShadow = ensureShadow(
  {
    core: original,
    createCore: () =>
      new Promise((resolve) => {
        create = resolve;
      }),
  },
  records,
  shadowRecord,
  () => {},
);
attempt.retired = true;
attempt.cancel.abort();
resetCheckpointTransaction(shadowRecord);
shadowRecord.attempt = { cancel: new AbortController(), retired: false };
assert.equal(
  await pendingShadow,
  false,
  "retirement releases the await without waiting for core creation",
);
create(late);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(late.disposed, 1);
assert.equal(shadowRecord.core, original);

const shadow = core();
assert.equal(
  await ensureShadow(
    { core: original, createCore: async () => shadow },
    records,
    shadowRecord,
    () => {},
  ),
  true,
);
shadowRecord.eventSeq = 200n;
shadowRecord.outputOffset = 300n;
rollbackShadow(shadowRecord);
assert.equal(shadowRecord.core, original);
assert.equal(shadow.disposed, 1);
assert.equal(shadowRecord.eventSeq, 7n);
assert.equal(shadowRecord.outputOffset, 9n);

const digest = crypto.subtle.digest;
let resolveDigest;
try {
  crypto.subtle.digest = () =>
    new Promise((resolve) => {
      resolveDigest = resolve;
    });
  const owner = { cancel: new AbortController(), retired: false };
  const restoring = {
    active: true,
    epoch: 1n,
    attempt: owner,
    checkpoint: new Uint8Array([1]),
    checkpointOffset: 1,
    checkpointHash: new Uint8Array(32),
  };
  const finishing = finishCheckpoint(restoring, { payload: new Uint8Array(32) });
  owner.retired = true;
  owner.cancel.abort();
  resetCheckpointTransaction(restoring);
  restoring.attempt = { cancel: new AbortController(), retired: false };
  assert.equal(await finishing, null, "retirement releases digest await before completion");
  resolveDigest(new ArrayBuffer(32));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restoring.checkpoint, null);
} finally {
  crypto.subtle.digest = digest;
}

// Logical digest cancellation cannot admit unlimited actual WebCrypto jobs.
const pool = { active: 0, waiters: [] },
  jobs = [];
try {
  crypto.subtle.digest = () => new Promise((resolve) => jobs.push(resolve));
  const startDigest = () => {
    const record = {
      active: true,
      epoch: 1n,
      attempt: { cancel: new AbortController(), retired: false },
      restoreCancel: new AbortController(),
      restoreJobs: { digest: pool },
      checkpoint: new Uint8Array([1]),
      checkpointOffset: 1,
      checkpointHash: new Uint8Array(32),
    };
    return { record, promise: finishCheckpoint(record, { payload: new Uint8Array(32) }) };
  };
  for (let i = 0; i < 5; i++) {
    const pending = startDigest();
    resetCheckpointTransaction(pending.record);
    assert.equal(await pending.promise, null);
  }
  assert.equal(jobs.length, 2);
  assert.equal(pool.active, 2);
  assert.equal(pool.waiters.length, 0);
  const current = startDigest();
  assert.equal(pool.waiters.length, 1);
  jobs[0](new ArrayBuffer(32));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(jobs.length, 3);
  assert.equal(pool.active, 2);
  resetCheckpointTransaction(current.record);
  assert.equal(await current.promise, null);
  jobs[1](new ArrayBuffer(32));
  jobs[2](new ArrayBuffer(32));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pool.active, 0);
  assert.equal(pool.waiters.length, 0);
} finally {
  crypto.subtle.digest = digest;
}

console.log(JSON.stringify({ sessionCheckpointContract: "ok", bytes: totalBytes }));
