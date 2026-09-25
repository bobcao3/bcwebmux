// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const SUBPROTOCOL = "bcw.sessions";
const MAGIC = 0x53574342;
const HEADER_LENGTH = 64;
const MAX_PAYLOAD_LENGTH = 1024 * 1024;
const MAX_FRAME_LENGTH = HEADER_LENGTH + MAX_PAYLOAD_LENGTH;
const SESSION_ID_LENGTH = 16;
const MAGIC_OFFSET = 0;
const TYPE_OFFSET = 4;
const FLAGS_OFFSET = 5;
const HEADER_LENGTH_OFFSET = 6;
const PAYLOAD_LENGTH_OFFSET = 8;
const RESERVED_OFFSET = 12;
const CONNECTION_SEQUENCE_OFFSET = 16;
const REQUEST_ID_OFFSET = 24;
const ATTACHMENT_ID_OFFSET = 32;
const ATTACHMENT_EPOCH_OFFSET = 40;
const SESSION_ID_OFFSET = 48;
const PAYLOAD_OFFSET = HEADER_LENGTH;
const COMPRESSED_FLAG = 1;
const RESIZE_PAYLOAD_LENGTH = 4;
const RESIZE_COLS_OFFSET = 0;
const RESIZE_ROWS_OFFSET = 2;
const MAX_UINT64 = (1n << 64n) - 1n;
const EMPTY_PAYLOAD = new Uint8Array(0);
const ZERO_SESSION_ID = new Uint8Array(SESSION_ID_LENGTH);

const FrameType = Object.freeze({
  HELLO: 1,
  WELCOME: 2,
  ERROR: 3,
  SESSION_CHANGED: 4,
  ATTACH: 5,
  ATTACH_BEGIN: 6,
  DETACH: 7,
  CHECKPOINT_BEGIN: 8,
  CHECKPOINT_CHUNK: 9,
  CHECKPOINT_END: 10,
  EVENT_BATCH: 11,
  LIVE_BARRIER: 12,
  ACK: 13,
  CREDIT: 14,
  RESYNC_REQUIRED: 15,
  CLAIM_CONTROL: 16,
  LEASE_CHANGED: 17,
  INPUT: 18,
  INPUT_ACK: 19,
  RESIZE_REQUEST: 20,
  CANONICAL_RESIZE: 21,
  EXITED: 22,
  PING: 23,
  PONG: 24,
});
const FRAME_TYPE_VALUES = new Set(Object.values(FrameType));

function requireUint8Array(name, value) {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${name} must be a Uint8Array`);
  }
  return value;
}

function requireRange(bytes, offset, length) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > bytes.byteLength) {
    throw new RangeError("integer offset is outside the byte array");
  }
}

function asUint8(name, value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`${name} must be an integer between 0 and 255`);
  }
  return value;
}

function asUint16(name, value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`${name} must be an integer between 0 and 65535`);
  }
  return value;
}

function asUint32(name, value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${name} must be an integer between 0 and 4294967295`);
  }
  return value;
}

function asUint64(name, value) {
  if (typeof value === "bigint") {
    if (value < 0n || value > MAX_UINT64) {
      throw new RangeError(`${name} must be an unsigned 64-bit integer`);
    }
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer or bigint`);
  }
  return BigInt(value);
}

function writeUint16LE(bytes, offset, value) {
  requireUint8Array("bytes", bytes);
  requireRange(bytes, offset, 2);
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(
    offset,
    asUint16("value", value),
    true,
  );
  return bytes;
}

function writeUint32LE(bytes, offset, value) {
  requireUint8Array("bytes", bytes);
  requireRange(bytes, offset, 4);
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(
    offset,
    asUint32("value", value),
    true,
  );
  return bytes;
}

function writeUint64LE(bytes, offset, value) {
  requireUint8Array("bytes", bytes);
  requireRange(bytes, offset, 8);
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigUint64(
    offset,
    asUint64("value", value),
    true,
  );
  return bytes;
}

function readUint16LE(bytes, offset) {
  requireUint8Array("bytes", bytes);
  requireRange(bytes, offset, 2);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function readUint32LE(bytes, offset) {
  requireUint8Array("bytes", bytes);
  requireRange(bytes, offset, 4);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function readUint64LE(bytes, offset) {
  requireUint8Array("bytes", bytes);
  requireRange(bytes, offset, 8);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, true);
}

function allowsCompression(type) {
  return type === FrameType.CHECKPOINT_CHUNK || type === FrameType.EVENT_BATCH;
}

function validateType(type) {
  if (!FRAME_TYPE_VALUES.has(type)) throw new RangeError("unknown frame type");
  return type;
}

function validateFlags(type, flags) {
  asUint8("flags", flags);
  if (
    (flags & ~COMPRESSED_FLAG) !== 0 ||
    ((flags & COMPRESSED_FLAG) !== 0 && !allowsCompression(type))
  ) {
    throw new RangeError("unknown or invalid frame flags");
  }
}

function encodeFrame(frame, output) {
  if (frame === null || typeof frame !== "object") throw new TypeError("frame must be an object");
  const type = validateType(frame.type);
  const flags = frame.flags ?? 0;
  validateFlags(type, flags);
  const headerLength = frame.headerLength ?? HEADER_LENGTH;
  if (headerLength !== HEADER_LENGTH) throw new RangeError("header length must be 64");
  const connectionSequence = asUint64("connectionSequence", frame.connectionSequence);
  if (connectionSequence === 0n) throw new RangeError("connectionSequence must be nonzero");
  const requestId = asUint64("requestId", frame.requestId ?? 0);
  const attachmentId = asUint64("attachmentId", frame.attachmentId ?? 0);
  const attachmentEpoch = asUint64("attachmentEpoch", frame.attachmentEpoch ?? 0);
  const sessionId = frame.sessionId ?? ZERO_SESSION_ID;
  requireUint8Array("sessionId", sessionId);
  if (sessionId.byteLength !== SESSION_ID_LENGTH)
    throw new RangeError("sessionId must be exactly 16 bytes");
  const payload = frame.payload ?? EMPTY_PAYLOAD;
  requireUint8Array("payload", payload);
  if (payload.byteLength > MAX_PAYLOAD_LENGTH)
    throw new RangeError("payload exceeds maximum length");
  const totalLength = HEADER_LENGTH + payload.byteLength;
  if (output === undefined) output = new Uint8Array(totalLength);
  requireUint8Array("output", output);
  if (output.byteLength < totalLength) throw new RangeError("output is too small");
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  view.setUint32(MAGIC_OFFSET, MAGIC, true);
  view.setUint8(TYPE_OFFSET, type);
  view.setUint8(FLAGS_OFFSET, flags);
  view.setUint16(HEADER_LENGTH_OFFSET, HEADER_LENGTH, true);
  view.setUint32(PAYLOAD_LENGTH_OFFSET, payload.byteLength, true);
  view.setUint32(RESERVED_OFFSET, 0, true);
  view.setBigUint64(CONNECTION_SEQUENCE_OFFSET, connectionSequence, true);
  view.setBigUint64(REQUEST_ID_OFFSET, requestId, true);
  view.setBigUint64(ATTACHMENT_ID_OFFSET, attachmentId, true);
  view.setBigUint64(ATTACHMENT_EPOCH_OFFSET, attachmentEpoch, true);
  output.set(sessionId, SESSION_ID_OFFSET);
  output.set(payload, PAYLOAD_OFFSET);
  return output.byteLength === totalLength ? output : output.subarray(0, totalLength);
}

function decodeFrame(message) {
  const bytes = requireUint8Array("message", message);
  if (bytes.byteLength < HEADER_LENGTH)
    throw new RangeError("frame is shorter than its fixed header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(MAGIC_OFFSET, true) !== MAGIC) throw new RangeError("invalid frame magic");
  const type = view.getUint8(TYPE_OFFSET);
  validateType(type);
  const flags = view.getUint8(FLAGS_OFFSET);
  validateFlags(type, flags);
  const headerLength = view.getUint16(HEADER_LENGTH_OFFSET, true);
  if (headerLength !== HEADER_LENGTH) throw new RangeError("invalid frame header length");
  if (view.getUint32(RESERVED_OFFSET, true) !== 0)
    throw new RangeError("reserved header bytes must be zero");
  const payloadLength = view.getUint32(PAYLOAD_LENGTH_OFFSET, true);
  if (payloadLength > MAX_PAYLOAD_LENGTH) throw new RangeError("payload exceeds maximum length");
  if (bytes.byteLength - HEADER_LENGTH !== payloadLength)
    throw new RangeError("payload length does not match frame length");
  const connectionSequence = view.getBigUint64(CONNECTION_SEQUENCE_OFFSET, true);
  if (connectionSequence === 0n) throw new RangeError("connection sequence must be nonzero");
  return {
    type,
    flags,
    headerLength,
    payloadLength,
    reserved: 0,
    connectionSequence,
    requestId: view.getBigUint64(REQUEST_ID_OFFSET, true),
    attachmentId: view.getBigUint64(ATTACHMENT_ID_OFFSET, true),
    attachmentEpoch: view.getBigUint64(ATTACHMENT_EPOCH_OFFSET, true),
    sessionId: bytes.subarray(SESSION_ID_OFFSET, SESSION_ID_OFFSET + SESSION_ID_LENGTH),
    payload: bytes.subarray(PAYLOAD_OFFSET, PAYLOAD_OFFSET + payloadLength),
  };
}

function encodeResizePayload(cols, rows, payload = new Uint8Array(RESIZE_PAYLOAD_LENGTH)) {
  requireUint8Array("payload", payload);
  if (payload.byteLength !== RESIZE_PAYLOAD_LENGTH)
    throw new RangeError("resize payload must be exactly 4 bytes");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  view.setUint16(RESIZE_COLS_OFFSET, asUint16("cols", cols), true);
  view.setUint16(RESIZE_ROWS_OFFSET, asUint16("rows", rows), true);
  return payload;
}

export {
  SUBPROTOCOL,
  MAGIC,
  HEADER_LENGTH,
  MAX_PAYLOAD_LENGTH,
  MAX_FRAME_LENGTH,
  SESSION_ID_LENGTH,
  ZERO_SESSION_ID,
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
  asUint16,
  asUint32,
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
};
