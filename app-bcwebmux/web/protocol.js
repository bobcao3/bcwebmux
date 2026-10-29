// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const SUBPROTOCOL = "bcw.sessions.v2";
const MAX_HEADER_LENGTH = 42;
const MAX_PAYLOAD_LENGTH = 1024 * 1024;
const MAX_FRAME_LENGTH = MAX_HEADER_LENGTH + MAX_PAYLOAD_LENGTH;
const SESSION_ID_LENGTH = 16;
const COMPRESSED_FLAG = 1;
const RESIZE_PAYLOAD_LENGTH = 4;
const RESIZE_COLS_OFFSET = 0;
const RESIZE_ROWS_OFFSET = 2;
const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_UINT128 = (1n << 128n) - 1n;
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
const CONNECTION_TYPES = new Set([
  FrameType.HELLO,
  FrameType.WELCOME,
  FrameType.SESSION_CHANGED,
  FrameType.PING,
  FrameType.PONG,
]);
const REQUEST_TYPES = new Set([
  FrameType.HELLO,
  FrameType.WELCOME,
  FrameType.ERROR,
  FrameType.ATTACH,
  FrameType.ATTACH_BEGIN,
  FrameType.DETACH,
  FrameType.LIVE_BARRIER,
  FrameType.CLAIM_CONTROL,
  FrameType.LEASE_CHANGED,
  FrameType.INPUT,
  FrameType.INPUT_ACK,
  FrameType.RESIZE_REQUEST,
  FrameType.CANONICAL_RESIZE,
]);
const CLIENT_TYPES = new Set([
  FrameType.HELLO,
  FrameType.ATTACH,
  FrameType.DETACH,
  FrameType.ACK,
  FrameType.CREDIT,
  FrameType.CLAIM_CONTROL,
  FrameType.INPUT,
  FrameType.RESIZE_REQUEST,
  FrameType.PING,
  FrameType.PONG,
]);
const SERVER_TYPES = new Set(
  [...FRAME_TYPE_VALUES].filter(
    (type) => !CLIENT_TYPES.has(type) || type === FrameType.PING || type === FrameType.PONG,
  ),
);

function headerLength(type) {
  validateType(type);
  return (
    2 +
    (CONNECTION_TYPES.has(type) ? 0 : 16) +
    (REQUEST_TYPES.has(type) ? 8 : 0) +
    (type === FrameType.ATTACH ? SESSION_ID_LENGTH : 0)
  );
}

function requireUint8Array(name, value) {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${name} must be a Uint8Array`);
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

function asUint128(name, value) {
  if (typeof value !== "bigint" || value < 0n || value > MAX_UINT128) {
    throw new RangeError(`${name} must be an unsigned 128-bit bigint`);
  }
  return value;
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

function writeUint128LE(bytes, offset, value) {
  requireUint8Array("bytes", bytes);
  requireRange(bytes, offset, 16);
  value = asUint128("value", value);
  writeUint64LE(bytes, offset, value & MAX_UINT64);
  writeUint64LE(bytes, offset + 8, value >> 64n);
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

function readUint128LE(bytes, offset) {
  requireUint8Array("bytes", bytes);
  requireRange(bytes, offset, 16);
  return readUint64LE(bytes, offset) | (readUint64LE(bytes, offset + 8) << 64n);
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
  const length = headerLength(type);
  const payload = frame.payload ?? EMPTY_PAYLOAD;
  requireUint8Array("payload", payload);
  if (payload.byteLength > MAX_PAYLOAD_LENGTH)
    throw new RangeError("payload exceeds maximum length");
  const attachmentId = CONNECTION_TYPES.has(type)
    ? 0n
    : asUint128("attachmentId", frame.attachmentId ?? 0n);
  const requestId = REQUEST_TYPES.has(type) ? asUint64("requestId", frame.requestId ?? 0n) : 0n;
  const sessionId = frame.sessionId ?? ZERO_SESSION_ID;
  if (type === FrameType.ATTACH) {
    requireUint8Array("sessionId", sessionId);
    if (sessionId.byteLength !== SESSION_ID_LENGTH)
      throw new RangeError("sessionId must be exactly 16 bytes");
  }
  const totalLength = length + payload.byteLength;
  if (output === undefined) output = new Uint8Array(totalLength);
  requireUint8Array("output", output);
  if (output.byteLength < totalLength) throw new RangeError("output is too small");
  output[0] = type;
  output[1] = flags;
  let offset = 2;
  if (!CONNECTION_TYPES.has(type)) {
    writeUint128LE(output, offset, attachmentId);
    offset += 16;
  }
  if (REQUEST_TYPES.has(type)) {
    writeUint64LE(output, offset, requestId);
    offset += 8;
  }
  if (type === FrameType.ATTACH) output.set(sessionId, offset);
  output.set(payload, length);
  return output.byteLength === totalLength ? output : output.subarray(0, totalLength);
}

function decodeFrame(message) {
  const bytes = requireUint8Array("message", message);
  if (bytes.byteLength < 2) throw new RangeError("frame is shorter than its prefix");
  const type = validateType(bytes[0]);
  const flags = bytes[1];
  validateFlags(type, flags);
  const length = headerLength(type);
  if (bytes.byteLength < length) throw new RangeError("frame is shorter than its header");
  const payloadLength = bytes.byteLength - length;
  if (payloadLength > MAX_PAYLOAD_LENGTH) throw new RangeError("payload exceeds maximum length");
  let offset = 2;
  let attachmentId = 0n,
    requestId = 0n;
  if (!CONNECTION_TYPES.has(type)) {
    attachmentId = readUint128LE(bytes, offset);
    offset += 16;
  }
  if (REQUEST_TYPES.has(type)) {
    requestId = readUint64LE(bytes, offset);
    offset += 8;
  }
  return {
    type,
    flags,
    headerLength: length,
    payloadLength,
    attachmentId,
    requestId,
    sessionId:
      type === FrameType.ATTACH
        ? bytes.subarray(offset, offset + SESSION_ID_LENGTH)
        : ZERO_SESSION_ID,
    payload: bytes.subarray(length),
  };
}

function encodeClientFrame(frame, output) {
  if (!CLIENT_TYPES.has(frame?.type)) throw new RangeError("frame type is not client-to-server");
  return encodeFrame(frame, output);
}

function decodeServerFrame(message) {
  const frame = decodeFrame(message);
  if (!SERVER_TYPES.has(frame.type)) throw new RangeError("frame type is not server-to-client");
  return frame;
}

function encodeResizePayload(cols, rows, payload = new Uint8Array(RESIZE_PAYLOAD_LENGTH)) {
  requireUint8Array("payload", payload);
  if (payload.byteLength !== RESIZE_PAYLOAD_LENGTH)
    throw new RangeError("resize payload must be exactly 4 bytes");
  writeUint16LE(payload, RESIZE_COLS_OFFSET, cols);
  writeUint16LE(payload, RESIZE_ROWS_OFFSET, rows);
  return payload;
}

export {
  SUBPROTOCOL,
  MAX_HEADER_LENGTH,
  MAX_PAYLOAD_LENGTH,
  MAX_FRAME_LENGTH,
  SESSION_ID_LENGTH,
  ZERO_SESSION_ID,
  COMPRESSED_FLAG,
  RESIZE_PAYLOAD_LENGTH,
  RESIZE_COLS_OFFSET,
  RESIZE_ROWS_OFFSET,
  MAX_UINT64,
  MAX_UINT128,
  FrameType,
  headerLength,
  asUint16,
  asUint32,
  asUint64,
  asUint128,
  readUint16LE,
  readUint32LE,
  readUint64LE,
  readUint128LE,
  writeUint16LE,
  writeUint32LE,
  writeUint64LE,
  writeUint128LE,
  encodeClientFrame,
  decodeServerFrame,
  encodeResizePayload,
};
