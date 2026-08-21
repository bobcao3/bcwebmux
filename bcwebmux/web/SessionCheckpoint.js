// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { decompress } from "./fzstd.js";
import {
  COMPRESSED_FLAG,
  readUint32LE,
  readUint64LE,
} from "./protocol.js";
import { crc32c, equalBytes } from "./SessionWire.js";

const MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024;

export async function ensureShadow(terminal, records, record, onData) {
  if (!terminal || record.previousCore) return true;
  const key = record.attachmentId.toString();
  const epoch = record.epoch;
  const originalCore = record.core;
  const shadow = await terminal.createCore();
  if (
    !record.active ||
    records.get(key) !== record ||
    record.attachmentId.toString() !== key ||
    record.epoch !== epoch ||
    record.core !== originalCore
  ) {
    shadow.dispose();
    return false;
  }
  record.previousWasHostActive = terminal.core === record.core;
  record.previousCore = record.core;
  record.previousInputDisposable = record.inputDisposable;
  record.core = shadow;
  record.inputDisposable = shadow.onData(onData);
  return true;
}

export function rollbackShadow(record) {
  if (!record.previousCore) return;
  record.inputDisposable?.dispose();
  record.core?.dispose();
  record.core = record.previousCore;
  record.inputDisposable = record.previousInputDisposable;
  record.previousCore = null;
  record.previousInputDisposable = null;
  record.previousWasHostActive = false;
}

export function clearCheckpoint(record) {
  record.checkpoint = null;
  record.checkpointHash = null;
  record.checkpointOffset = 0;
}

export function resetCheckpointTransaction(record) {
  clearCheckpoint(record);
  rollbackShadow(record);
}

export function beginCheckpoint(record, frame) {
  if (frame.payload.byteLength !== 56) throw new Error("invalid CHECKPOINT_BEGIN");
  const total = readUint32LE(frame.payload, 0);
  if (!total || total > MAX_CHECKPOINT_BYTES) throw new Error("checkpoint exceeds client limit");
  record.checkpoint = new Uint8Array(total);
  record.checkpointOffset = 0;
  record.checkpointEventSeq = readUint64LE(frame.payload, 8);
  record.checkpointOutputOffset = readUint64LE(frame.payload, 16);
  record.checkpointHash = frame.payload.slice(24, 56);
}

export function appendCheckpoint(record, frame) {
  if (!record.checkpoint || frame.payload.byteLength < 16 || frame.flags !== COMPRESSED_FLAG) {
    throw new Error("unexpected checkpoint chunk");
  }
  const offset = readUint32LE(frame.payload, 0);
  const rawLength = readUint32LE(frame.payload, 4);
  const crc = readUint32LE(frame.payload, 8);
  const wireLength = readUint32LE(frame.payload, 12);
  if (offset !== record.checkpointOffset || wireLength !== frame.payload.byteLength - 16) {
    throw new Error("checkpoint chunk gap");
  }
  if (rawLength > 256 * 1024 || offset + rawLength > record.checkpoint.byteLength) {
    throw new Error("corrupt checkpoint chunk");
  }
  const raw = decompress(
    frame.payload.subarray(16),
    record.checkpoint.subarray(offset, offset + rawLength),
  );
  if (raw.byteLength !== rawLength || crc32c(raw) !== crc) {
    throw new Error("corrupt checkpoint chunk");
  }
  record.checkpointOffset += rawLength;
  return rawLength;
}

export async function finishCheckpoint(record, frame) {
  if (!record.checkpoint || frame.payload.byteLength !== 32 || record.checkpointOffset !== record.checkpoint.byteLength) {
    throw new Error("incomplete checkpoint");
  }
  const epoch = record.epoch;
  const checkpoint = record.checkpoint;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", checkpoint));
  if (!record.active || record.epoch !== epoch || record.checkpoint !== checkpoint) return null;
  if (!equalBytes(digest, record.checkpointHash) || !equalBytes(digest, frame.payload)) {
    throw new Error("checkpoint hash mismatch");
  }
  const result = {
    bytes: checkpoint,
    eventSeq: record.checkpointEventSeq,
    outputOffset: record.checkpointOutputOffset,
  };
  record.checkpoint = null;
  record.checkpointHash = null;
  return result;
}
