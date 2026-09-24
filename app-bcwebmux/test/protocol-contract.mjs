// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import * as Protocol from "../web/protocol.js";

const {
  SUBPROTOCOL,
  MAGIC,
  HEADER_LENGTH,
  MAX_PAYLOAD_LENGTH,
  MAX_FRAME_LENGTH,
  SESSION_ID_LENGTH,
  MAGIC_OFFSET,
  TYPE_OFFSET,
  FLAGS_OFFSET,
  HEADER_LENGTH_OFFSET,
  PAYLOAD_LENGTH_OFFSET,
  RESERVED_OFFSET,
  CONNECTION_SEQUENCE_OFFSET,
  REQUEST_ID_OFFSET,
  ATTACHMENT_ID_OFFSET,
  ATTACHMENT_EPOCH_OFFSET,
  SESSION_ID_OFFSET,
  PAYLOAD_OFFSET,
  COMPRESSED_FLAG,
  RESIZE_PAYLOAD_LENGTH,
  RESIZE_COLS_OFFSET,
  RESIZE_ROWS_OFFSET,
  MAX_UINT64,
  FrameType,
  asUint64,
  readUint16LE,
  readUint32LE,
  readUint64LE,
  writeUint16LE,
  writeUint32LE,
  writeUint64LE,
  encodeFrame,
  decodeFrame,
  encodeResizePayload,
} = Protocol;

assert.equal(SUBPROTOCOL, "bcw.sessions");
assert.equal(MAGIC, 0x53574342);
assert.equal(HEADER_LENGTH, 64);
assert.equal(MAX_FRAME_LENGTH, HEADER_LENGTH + MAX_PAYLOAD_LENGTH);
assert.deepEqual(
  [
    MAGIC_OFFSET,
    TYPE_OFFSET,
    FLAGS_OFFSET,
    HEADER_LENGTH_OFFSET,
    PAYLOAD_LENGTH_OFFSET,
    RESERVED_OFFSET,
    CONNECTION_SEQUENCE_OFFSET,
    REQUEST_ID_OFFSET,
    ATTACHMENT_ID_OFFSET,
    ATTACHMENT_EPOCH_OFFSET,
    SESSION_ID_OFFSET,
    PAYLOAD_OFFSET,
  ],
  [0, 4, 5, 6, 8, 12, 16, 24, 32, 40, 48, 64],
);
assert.equal(SESSION_ID_LENGTH, 16);
assert.equal(RESIZE_PAYLOAD_LENGTH, 4);
assert.equal(RESIZE_COLS_OFFSET, 0);
assert.equal(RESIZE_ROWS_OFFSET, 2);
assert.equal("CURRENT_SUBPROTOCOL" in Protocol, false);
assert.equal("PROBE_PREFIX" in Protocol, false);
assert.equal("encodeResize" in Protocol, false);

const sessionId = Uint8Array.from({ length: SESSION_ID_LENGTH }, (_, index) => index);
const payload = Uint8Array.of(0xaa, 0xbb);
const golden = Uint8Array.from([
  0x42, 0x43, 0x57, 0x53, 0x01, 0x00, 0x40, 0x00,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
  0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
  0xaa, 0xbb,
]);
const goldenFrame = {
  type: FrameType.HELLO,
  connectionSequence: 1n,
  requestId: 2n,
  attachmentId: 3n,
  attachmentEpoch: 4n,
  sessionId,
  payload,
};
assert.deepEqual([...encodeFrame(goldenFrame)], [...golden]);
const reusable = new Uint8Array(golden.length);
assert.strictEqual(encodeFrame(goldenFrame, reusable), reusable);
assert.deepEqual([...reusable], [...golden]);
const decoded = decodeFrame(reusable);
assert.equal(decoded.type, FrameType.HELLO);
assert.equal(decoded.headerLength, HEADER_LENGTH);
assert.equal(decoded.payloadLength, payload.length);
assert.equal(decoded.reserved, 0);
assert.equal(decoded.connectionSequence, 1n);
assert.equal(decoded.requestId, 2n);
assert.equal(decoded.attachmentId, 3n);
assert.equal(decoded.attachmentEpoch, 4n);
assert.deepEqual([...decoded.sessionId], [...sessionId]);
assert.deepEqual([...decoded.payload], [...payload]);
assert.strictEqual(decoded.payload.buffer, reusable.buffer);
reusable[PAYLOAD_OFFSET] = 0xcc;
assert.equal(decoded.payload[0], 0xcc);

const frameTypes = Object.values(FrameType);
assert.deepEqual(frameTypes, Array.from({ length: 24 }, (_, index) => index + 1));
for (const type of frameTypes) {
  const encoded = encodeFrame({ type, connectionSequence: 1n });
  assert.equal(decodeFrame(encoded).type, type);
}

const compressedTypes = [FrameType.CHECKPOINT_CHUNK, FrameType.EVENT_BATCH];
for (const type of compressedTypes) {
  assert.equal(decodeFrame(encodeFrame({ type, flags: COMPRESSED_FLAG, connectionSequence: 1n })).flags, COMPRESSED_FLAG);
}
assert.throws(() => encodeFrame({ type: FrameType.HELLO, flags: COMPRESSED_FLAG, connectionSequence: 1n }), RangeError);
assert.throws(() => encodeFrame({ type: FrameType.EVENT_BATCH, flags: 2, connectionSequence: 1n }), RangeError);

for (let length = 0; length < HEADER_LENGTH; length += 1) {
  assert.throws(() => decodeFrame(golden.subarray(0, length)), RangeError, `truncation at ${length}`);
}
function malformed(mutator) {
  const frame = new Uint8Array(golden);
  mutator(frame);
  assert.throws(() => decodeFrame(frame), RangeError);
}
malformed((frame) => { frame[MAGIC_OFFSET] ^= 1; });
malformed((frame) => { frame[TYPE_OFFSET] = 0xff; });
malformed((frame) => { frame[FLAGS_OFFSET] = 2; });
malformed((frame) => { writeUint16LE(frame, HEADER_LENGTH_OFFSET, HEADER_LENGTH - 1); });
malformed((frame) => { writeUint32LE(frame, RESERVED_OFFSET, 1); });
malformed((frame) => { writeUint32LE(frame, PAYLOAD_LENGTH_OFFSET, 1); });
malformed((frame) => { writeUint64LE(frame, CONNECTION_SEQUENCE_OFFSET, 0n); });
assert.throws(() => encodeFrame({ ...goldenFrame, connectionSequence: 0n }), RangeError);
assert.throws(() => encodeFrame({ ...goldenFrame, headerLength: HEADER_LENGTH - 1 }), RangeError);
assert.throws(() => encodeFrame(goldenFrame, new Uint8Array(HEADER_LENGTH)), RangeError);

const maxPayload = new Uint8Array(MAX_PAYLOAD_LENGTH);
const maxFrame = encodeFrame({ type: FrameType.INPUT, connectionSequence: 1n, payload: maxPayload });
assert.equal(maxFrame.byteLength, MAX_FRAME_LENGTH);
assert.equal(decodeFrame(maxFrame).payloadLength, MAX_PAYLOAD_LENGTH);
assert.throws(
  () => encodeFrame({ type: FrameType.INPUT, connectionSequence: 1n, payload: new Uint8Array(MAX_PAYLOAD_LENGTH + 1) }),
  RangeError,
);
const overMaxHeader = encodeFrame({ type: FrameType.HELLO, connectionSequence: 1n });
writeUint32LE(overMaxHeader, PAYLOAD_LENGTH_OFFSET, MAX_PAYLOAD_LENGTH + 1);
assert.throws(() => decodeFrame(overMaxHeader), RangeError);

assert.equal(asUint64("value", MAX_UINT64), MAX_UINT64);
assert.equal(asUint64("value", Number.MAX_SAFE_INTEGER), BigInt(Number.MAX_SAFE_INTEGER));
assert.throws(() => asUint64("value", MAX_UINT64 + 1n), RangeError);
assert.throws(() => asUint64("value", -1n), RangeError);
assert.throws(() => asUint64("value", Number.MAX_SAFE_INTEGER + 1), RangeError);
assert.throws(() => asUint64("value", 1.5), RangeError);
assert.throws(() => encodeFrame({ type: FrameType.PING, connectionSequence: MAX_UINT64 + 1n }), RangeError);

const integers = new Uint8Array(14);
writeUint16LE(integers, 0, 0x1234);
writeUint32LE(integers, 2, 0x12345678);
writeUint64LE(integers, 6, 0x123456789abcdef0n);
assert.equal(readUint16LE(integers, 0), 0x1234);
assert.equal(readUint32LE(integers, 2), 0x12345678);
assert.equal(readUint64LE(integers, 6), 0x123456789abcdef0n);

const resizePayload = new Uint8Array(RESIZE_PAYLOAD_LENGTH);
assert.strictEqual(encodeResizePayload(80, 24, resizePayload), resizePayload);
assert.deepEqual([...resizePayload], [0x50, 0x00, 0x18, 0x00]);
assert.throws(() => encodeResizePayload(-1, 24), RangeError);
assert.throws(() => encodeResizePayload(80, 0x10000), RangeError);
