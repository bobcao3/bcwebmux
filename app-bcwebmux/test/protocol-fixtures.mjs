// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";

// Independent peer codec: fixtures must not round-trip through the browser codec.
const connectionTypes = new Set([1, 2, 4, 23, 24]);
const requestTypes = new Set([1, 2, 3, 5, 6, 7, 12, 16, 17, 18, 19, 20, 21]);
export const clientTypes = [1, 5, 7, 13, 14, 16, 18, 20, 23, 24];
export const serverTypes = [2, 3, 4, 6, 8, 9, 10, 11, 12, 15, 17, 19, 21, 22, 23, 24];
export function fixtureHeaderLength(type) {
  assert.ok(type >= 1 && type <= 24);
  return (
    2 +
    (connectionTypes.has(type) ? 0 : 16) +
    (requestTypes.has(type) ? 8 : 0) +
    (type === 5 ? 16 : 0)
  );
}
export function writeId(bytes, offset, value) {
  assert.ok(value >= 0n && value < 1n << 128n);
  for (let i = 0; i < 16; i++) bytes[offset + i] = Number((value >> BigInt(i * 8)) & 255n);
}
export function readId(bytes, offset) {
  let id = 0n;
  for (let i = 15; i >= 0; i--) id = (id << 8n) | BigInt(bytes[offset + i]);
  return id;
}
export function encodeServerFixture({
  type,
  flags = 0,
  attachmentId = 0n,
  requestId = 0n,
  payload = new Uint8Array(),
}) {
  assert.ok(serverTypes.includes(type));
  const bytes = new Uint8Array(fixtureHeaderLength(type) + payload.length);
  bytes.set([type, flags]);
  let offset = 2;
  if (!connectionTypes.has(type)) {
    writeId(bytes, offset, attachmentId);
    offset += 16;
  }
  if (requestTypes.has(type)) new DataView(bytes.buffer).setBigUint64(offset, requestId, true);
  bytes.set(payload, fixtureHeaderLength(type));
  return bytes;
}
export function decodeClientFixture(bytes) {
  const type = bytes[0],
    headerLength = fixtureHeaderLength(type);
  assert.ok(clientTypes.includes(type), `unexpected client opcode ${type}`);
  assert.equal(bytes[1], 0, "client frames cannot be compressed");
  assert.ok(bytes.length >= headerLength);
  assert.ok(bytes.length - headerLength <= 1024 * 1024);
  let offset = 2;
  const attachmentId = connectionTypes.has(type) ? 0n : readId(bytes, offset);
  if (!connectionTypes.has(type)) offset += 16;
  const requestId = requestTypes.has(type)
    ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, true)
    : 0n;
  if (requestTypes.has(type)) offset += 8;
  const sessionId = type === 5 ? bytes.slice(offset, offset + 16) : new Uint8Array(16);
  return {
    type,
    flags: bytes[1],
    attachmentId,
    requestId,
    sessionId,
    headerLength,
    payload: bytes.subarray(headerLength),
    payloadLength: bytes.length - headerLength,
  };
}
