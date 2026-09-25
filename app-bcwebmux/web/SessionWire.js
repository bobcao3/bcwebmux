// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { readUint16LE, readUint32LE, readUint64LE, writeUint16LE } from "./protocol.js";

export const ABI_DIGEST = hexBytes(
  "9f9159876f7ba9efca0a0410aa307cb533a5a3aef86072427eaf208591b50ae6",
);

export function createEmitter() {
  const listeners = new Set();
  return {
    emit(...args) {
      for (const listener of [...listeners]) {
        try {
          listener(...args);
        } catch (error) {
          console.error("session transport listener failed", error);
        }
      }
    },
    event(listener) {
      if (typeof listener !== "function") throw new TypeError("listener must be a function");
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    clear() {
      listeners.clear();
    },
  };
}

export function readGeometry(bytes, offset) {
  return {
    cols: readUint16LE(bytes, offset),
    rows: readUint16LE(bytes, offset + 2),
    cellWidthPx: readUint16LE(bytes, offset + 4),
    cellHeightPx: readUint16LE(bytes, offset + 6),
  };
}

export function writeGeometry(bytes, offset, value) {
  writeUint16LE(bytes, offset, value.cols);
  writeUint16LE(bytes, offset + 2, value.rows);
  writeUint16LE(bytes, offset + 4, value.cellWidthPx);
  writeUint16LE(bytes, offset + 6, value.cellHeightPx);
}

export function stateName(value) {
  return ["creating", "running", "terminating", "exited", "failed"][value] ?? "failed";
}

export function uuidBytes(value) {
  const text = String(value).replaceAll("-", "");
  if (!/^[0-9a-fA-F]{32}$/.test(text)) throw new TypeError("invalid session UUID");
  return hexBytes(text);
}

export function bytesUuid(bytes) {
  const text = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

export function stableClientId() {
  const key = "bcwebmux.client-instance";
  try {
    const existing = localStorage.getItem(key);
    if (existing) return uuidBytes(existing);
    const id = crypto.randomUUID();
    localStorage.setItem(key, id);
    return uuidBytes(id);
  } catch {
    return crypto.getRandomValues(new Uint8Array(16));
  }
}

export function randomUint64() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let value = 0n;
  for (let index = 0; index < bytes.length; index += 1)
    value |= BigInt(bytes[index]) << BigInt(index * 8);
  return value || 1n;
}

export function hexBytes(text) {
  return Uint8Array.from(text.match(/../g) || [], (pair) => Number.parseInt(pair, 16));
}

export function equalBytes(left, right) {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}

export function isConnectionFrame(frame) {
  return (
    frame.attachmentId === 0n &&
    frame.attachmentEpoch === 0n &&
    frame.sessionId.every((byte) => byte === 0)
  );
}

export function validWelcomeCapabilities(payload, maxFrameLength, maxCredit) {
  const interval = readUint32LE(payload, 60);
  return (
    readUint32LE(payload, 48) === maxFrameLength &&
    readUint32LE(payload, 52) > 0 &&
    readUint32LE(payload, 52) <= 16 * 1024 * 1024 &&
    readUint32LE(payload, 56) === maxCredit &&
    interval > 0 &&
    readUint32LE(payload, 64) > interval &&
    readUint16LE(payload, 68) >= 1 &&
    readUint16LE(payload, 68) <= 8 &&
    payload[70] === 0 &&
    payload[71] === 0 &&
    readUint64LE(payload, 80) !== 0n
  );
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? 0x82f63b78 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32c(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function updateRtt(state, sample) {
  const samples = (state._rttSamples ??= []);
  samples.push(sample);
  if (samples.length > 32) samples.shift();
  const sorted = [...samples].sort((a, b) => a - b);
  state.wsRttLatestMs = sample;
  state.wsRttMedianMs = sorted[Math.floor(sorted.length / 2)];
  state.wsRttP95Ms = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

export function handleInputStatus(record, status, emitError) {
  if (status === 2 || status === 3) {
    record.controller = false;
  } else if (status > 3) {
    emitError(new Error(`terminal input was not accepted (status ${status})`));
  }
}

export function acceptAttachmentEpoch(record, frame) {
  record.epoch = frame.attachmentEpoch;
  record.attachRequestId = 0n;
}

export function markRecordDetached(record) {
  record.live = false;
  record.controller = false;
  record.state = "detached";
  record.epoch = 0n;
  record.attachRequestId = 0n;
  record.frozen = [];
  record.frozenBytes = 0;
}

export function rememberStaleAttachment(staleIds, record) {
  staleIds.add(record.attachmentId.toString());
  if (staleIds.size > 32) staleIds.delete(staleIds.values().next().value);
}
