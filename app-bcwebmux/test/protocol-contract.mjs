// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import {
  SUBPROTOCOL,
  MAX_PAYLOAD_LENGTH,
  MAX_FRAME_LENGTH,
  COMPRESSED_FLAG,
  MAX_UINT64,
  FrameType as F,
  headerLength,
  encodeClientFrame,
  decodeServerFrame,
  asUint64,
  encodeResizePayload,
  readUint16LE,
  readUint32LE,
  readUint64LE,
  writeUint16LE,
  writeUint32LE,
  writeUint64LE,
} from "../web/protocol.js";
import {
  clientTypes,
  serverTypes,
  fixtureHeaderLength,
  encodeServerFixture,
  decodeClientFixture,
} from "./protocol-fixtures.mjs";

assert.equal(SUBPROTOCOL, "bcw.sessions.v2");
assert.equal(MAX_FRAME_LENGTH, 42 + MAX_PAYLOAD_LENGTH);
const attachmentId = 0x100f0e0d0c0b0a090807060504030201n;
const requestId = 0x1817161514131211n;
const sessionId = Uint8Array.from({ length: 16 }, (_, i) => 0x20 + i);
const payload = Uint8Array.of(0xaa, 0xbb);
const attach = { type: F.ATTACH, attachmentId, requestId, sessionId, payload };
const golden = Uint8Array.from([
  5, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 32,
  33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 0xaa, 0xbb,
]);
assert.deepEqual(
  encodeClientFrame(attach),
  golden,
  "ATTACH keeps all 128 identity bits in little endian order",
);
const reusable = new Uint8Array(golden.length);
assert.strictEqual(encodeClientFrame(attach, reusable), reusable);
assert.deepEqual(reusable, golden);
assert.throws(() => encodeClientFrame(attach, new Uint8Array(golden.length - 1)), RangeError);

for (const type of clientTypes) {
  assert.equal(headerLength(type), fixtureHeaderLength(type));
  const bytes = encodeClientFrame({ ...attach, type });
  const frame = decodeClientFixture(bytes);
  assert.equal(bytes.length, fixtureHeaderLength(type) + payload.length);
  assert.equal(frame.attachmentId, [F.HELLO, F.PING, F.PONG].includes(type) ? 0n : attachmentId);
  assert.equal(frame.requestId, [F.ACK, F.CREDIT, F.PING, F.PONG].includes(type) ? 0n : requestId);
  assert.deepEqual(frame.sessionId, type === F.ATTACH ? sessionId : new Uint8Array(16));
  assert.deepEqual(frame.payload, payload);
  assert.throws(() => encodeClientFrame({ ...attach, type, flags: COMPRESSED_FLAG }), RangeError);
}
for (const type of serverTypes) {
  assert.equal(headerLength(type), fixtureHeaderLength(type));
  const bytes = encodeServerFixture({ type, attachmentId, requestId, payload });
  const frame = decodeServerFrame(bytes);
  assert.equal(frame.type, type);
  assert.equal(frame.headerLength, fixtureHeaderLength(type));
  assert.equal(
    frame.attachmentId,
    [F.WELCOME, F.SESSION_CHANGED, F.PING, F.PONG].includes(type) ? 0n : attachmentId,
  );
  assert.equal(
    frame.requestId,
    [
      F.WELCOME,
      F.ERROR,
      F.ATTACH_BEGIN,
      F.LIVE_BARRIER,
      F.LEASE_CHANGED,
      F.INPUT_ACK,
      F.CANONICAL_RESIZE,
    ].includes(type)
      ? requestId
      : 0n,
  );
  assert.deepEqual(frame.payload, payload);
  assert.strictEqual(frame.payload.buffer, bytes.buffer, "decode borrows the message payload");
  bytes[frame.headerLength] = 0xcc;
  assert.equal(frame.payload[0], 0xcc);
  for (let length = 0; length < fixtureHeaderLength(type); length++)
    assert.throws(
      () => decodeServerFrame(bytes.subarray(0, length)),
      RangeError,
      `opcode ${type} truncated at ${length}`,
    );
  for (const flags of [1, 2, 255]) {
    bytes[1] = flags;
    if (flags === 1 && [F.CHECKPOINT_CHUNK, F.EVENT_BATCH].includes(type))
      assert.equal(decodeServerFrame(bytes).flags, COMPRESSED_FLAG);
    else assert.throws(() => decodeServerFrame(bytes), RangeError);
  }
}
for (const type of clientTypes.filter((type) => !serverTypes.includes(type)))
  assert.throws(
    () => decodeServerFrame(encodeClientFrame({ ...attach, type })),
    RangeError,
    "server direction rejects client-only opcode",
  );
for (const type of serverTypes.filter((type) => !clientTypes.includes(type)))
  assert.throws(
    () => encodeClientFrame({ ...attach, type }),
    RangeError,
    "client direction rejects server-only opcode",
  );
for (const type of [0, 25, 255]) {
  assert.throws(() => headerLength(type), RangeError);
  assert.throws(() => encodeClientFrame({ type }), RangeError);
  assert.throws(() => decodeServerFrame(Uint8Array.of(type, 0)), RangeError);
}

// WebSocket boundaries supply payload length, even for the two-byte PONG header.
assert.deepEqual(
  decodeServerFrame(Uint8Array.of(24, 0, 0xab, 0xcd)).payload,
  Uint8Array.of(0xab, 0xcd),
);
for (const type of [F.ATTACH, F.INPUT, F.PING]) {
  const bytes = encodeClientFrame({ ...attach, type, payload: new Uint8Array(MAX_PAYLOAD_LENGTH) });
  assert.equal(bytes.length, fixtureHeaderLength(type) + MAX_PAYLOAD_LENGTH);
  assert.equal(decodeClientFixture(bytes).payload.length, MAX_PAYLOAD_LENGTH);
  assert.throws(
    () => encodeClientFrame({ ...attach, type, payload: new Uint8Array(MAX_PAYLOAD_LENGTH + 1) }),
    RangeError,
  );
}
for (const type of [F.PONG, F.EVENT_BATCH, F.ATTACH_BEGIN]) {
  const bytes = encodeServerFixture({
    type,
    attachmentId,
    requestId,
    payload: new Uint8Array(MAX_PAYLOAD_LENGTH),
  });
  assert.equal(decodeServerFrame(bytes).payload.length, MAX_PAYLOAD_LENGTH);
  const over = new Uint8Array(bytes.length + 1);
  over.set(bytes);
  assert.throws(
    () => decodeServerFrame(over),
    RangeError,
    "payload cap applies independently of header size",
  );
}
assert.equal(decodeServerFrame(encodeServerFixture({ type: F.ERROR })).attachmentId, 0n);
for (const value of [-1n, 1n << 128n, Number.MAX_SAFE_INTEGER + 1])
  assert.throws(() => encodeClientFrame({ ...attach, attachmentId: value }), RangeError);
assert.equal(
  decodeClientFixture(encodeClientFrame({ ...attach, attachmentId: (1n << 128n) - 1n }))
    .attachmentId,
  (1n << 128n) - 1n,
);
for (const value of [-1n, MAX_UINT64 + 1n])
  assert.throws(() => encodeClientFrame({ ...attach, requestId: value }), RangeError);
assert.throws(() => encodeClientFrame({ ...attach, sessionId: new Uint8Array(15) }), RangeError);

assert.equal(asUint64("value", MAX_UINT64), MAX_UINT64);
assert.equal(asUint64("value", Number.MAX_SAFE_INTEGER), BigInt(Number.MAX_SAFE_INTEGER));
for (const value of [MAX_UINT64 + 1n, -1n, Number.MAX_SAFE_INTEGER + 1, 1.5])
  assert.throws(() => asUint64("value", value), RangeError);
const integers = new Uint8Array(16);
writeUint16LE(integers, 1, 0x1234);
writeUint32LE(integers, 3, 0x89abcdef);
writeUint64LE(integers, 7, 0x123456789abcdef0n);
assert.equal(readUint16LE(integers, 1), 0x1234);
assert.equal(readUint32LE(integers, 3), 0x89abcdef);
assert.equal(readUint64LE(integers, 7), 0x123456789abcdef0n);
assert.throws(() => readUint64LE(integers, 9), RangeError);
assert.throws(() => writeUint16LE(integers, -1, 1), RangeError);
const resizePayload = new Uint8Array(4);
assert.strictEqual(encodeResizePayload(80, 24, resizePayload), resizePayload);
assert.deepEqual(resizePayload, Uint8Array.of(80, 0, 24, 0));
assert.throws(() => encodeResizePayload(0x10000, 24), RangeError);
assert.throws(() => encodeResizePayload(80, 0x10000), RangeError);
console.log("protocol-contract: ok");
