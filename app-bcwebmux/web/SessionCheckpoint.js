// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { decompress } from "./fzstd.js";
import { COMPRESSED_FLAG, readUint32LE, readUint64LE } from "./protocol.js";
import { crc32c, equalBytes } from "./SessionWire.js";

const MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024;

// Release the transaction's await on retirement; a late core is still disposed.
// WebCrypto itself cannot be canceled, but its eventual result has no authority.
function cancellable(start, signals, pool, discard = () => {}) {
  return new Promise((resolve, reject) => {
    let canceled = false,
      running = false;
    const cleanup = () => {
      for (const signal of signals) signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      canceled = true;
      cleanup();
      if (!running && pool) {
        const index = pool.waiters.indexOf(run);
        if (index >= 0) pool.waiters.splice(index, 1);
      }
      resolve(null);
    };
    const complete = () => {
      cleanup();
      if (pool) {
        pool.active--;
        pool.waiters.shift()?.();
      }
    };
    const run = () => {
      if (canceled) return;
      running = true;
      if (pool) pool.active++;
      let promise;
      try {
        promise = Promise.resolve(start());
      } catch (error) {
        complete();
        reject(error);
        return;
      }
      promise.then(
        (value) => {
          // Cancellation settles the JS waiter, not this actual-job slot.
          try {
            if (canceled) discard(value);
            else resolve(value);
          } finally {
            complete();
          }
        },
        (error) => {
          if (!canceled) reject(error);
          complete();
        },
      );
    };
    if (signals.some((signal) => signal.aborted)) return abort();
    for (const signal of signals) signal.addEventListener("abort", abort, { once: true });
    if (pool && pool.active >= 2) pool.waiters.push(run);
    else run();
  });
}

function cancellationSignals(record) {
  return [record.attempt?.cancel.signal, record.restoreCancel?.signal].filter(Boolean);
}

export async function ensureShadow(terminal, records, record, onData) {
  if (!terminal || record.previousCore) return true;
  const key = record.attachmentId.toString();
  const epoch = record.epoch;
  const attempt = record.attempt;
  const transaction = record.transaction;
  const originalCore = record.core;
  const shadow = await cancellable(
    () => terminal.createCore(),
    cancellationSignals(record),
    record.restoreJobs?.core,
    (core) => core.dispose(),
  );
  if (!shadow) return false;
  if (
    !record.active ||
    attempt?.retired ||
    record.attempt !== attempt ||
    record.transaction !== transaction ||
    records.get(key) !== record ||
    record.attachmentId.toString() !== key ||
    record.epoch !== epoch ||
    record.core !== originalCore
  ) {
    shadow.dispose();
    return false;
  }
  record.previousWasHostActive = terminal.core === record.core;
  record.previousCursor = { eventSeq: record.eventSeq, outputOffset: record.outputOffset };
  record.previousCore = record.core;
  record.previousInputDisposable = record.inputDisposable;
  record.core = shadow;
  record.inputDisposable = shadow.onData(onData);
  return true;
}

export function rollbackShadow(record) {
  if (record.restoreGeneration) {
    record.generation = record.restoreGeneration;
    record.restoreGeneration = null;
  }
  if (!record.previousCore) return;
  record.inputDisposable?.dispose();
  record.core?.dispose();
  record.core = record.previousCore;
  record.inputDisposable = record.previousInputDisposable;
  record.previousCore = null;
  record.previousInputDisposable = null;
  record.previousWasHostActive = false;
  if (record.previousCursor) {
    record.eventSeq = record.previousCursor.eventSeq;
    record.outputOffset = record.previousCursor.outputOffset;
    record.previousCursor = null;
  }
}

export function clearCheckpoint(record) {
  record.checkpoint = null;
  record.checkpointHash = null;
  record.checkpointOffset = 0;
}

export function resetCheckpointTransaction(record) {
  record.restoreCancel?.abort();
  record.restoreCancel = new AbortController();
  record.transaction = (record.transaction ?? 0) + 1;
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
  if (
    !record.checkpoint ||
    frame.payload.byteLength !== 32 ||
    record.checkpointOffset !== record.checkpoint.byteLength
  ) {
    throw new Error("incomplete checkpoint");
  }
  const epoch = record.epoch;
  const attempt = record.attempt;
  const transaction = record.transaction;
  const checkpoint = record.checkpoint;
  let resultDigest;
  try {
    resultDigest = await cancellable(
      () => crypto.subtle.digest("SHA-256", checkpoint),
      cancellationSignals(record),
      record.restoreJobs?.digest,
    );
  } catch (cause) {
    const error = new Error("checkpoint digest operation failed", { cause });
    error.checkpointOperation = true;
    throw error;
  }
  if (
    !resultDigest ||
    !record.active ||
    attempt?.retired ||
    record.attempt !== attempt ||
    record.transaction !== transaction ||
    record.epoch !== epoch ||
    record.checkpoint !== checkpoint
  )
    return null;
  const digest = new Uint8Array(resultDigest);
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
