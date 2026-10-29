// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import { createZstdDecompress, zstdDecompressSync } from "node:zlib";
import * as Protocol from "../web/protocol.js";
import {
  crc32c,
  freePort,
  terminateProcess,
  waitFor as poll,
  delay as wait,
} from "./test-support.mjs";
import { readId, writeId } from "./protocol-fixtures.mjs";
const waitFor = (check, timeout, message) => poll(check, timeout, message, 25);
const execFileAsync = promisify(execFile),
  {
    SUBPROTOCOL,
    MAX_FRAME_LENGTH,
    COMPRESSED_FLAG,
    ZERO_SESSION_ID,
    FrameType,
    encodeClientFrame,
    decodeServerFrame,
    headerLength,
    readUint16LE,
    readUint32LE,
    readUint64LE,
    writeUint16LE,
    writeUint32LE,
    writeUint64LE,
    encodeResizePayload,
  } = Protocol,
  INITIAL_CREDIT = 33554432,
  ABI_TEXT =
    "bcwebmux-graphics-frame-v8-checkpoint-v2-continuation-1m-glyph-cell-partitions-pty-zstd-stream-v2-kitty-worker-normalize-v1-ghostty-728bbef6c",
  ABI_DIGEST = new Uint8Array(createHash("sha256").update(ABI_TEXT).digest()),
  ABI_HEX = "f2af43df1a7117276892bb2260938c52bdc6b76c93c55e3ebec217c4418387cd",
  encoder = new TextEncoder(),
  decoder = new TextDecoder(),
  serverPath = process.argv[2];
assert.ok(serverPath, "usage: node test/session-ws-protocol.mjs SERVER");
assert.equal(Buffer.from(ABI_DIGEST).toString("hex"), ABI_HEX);
// One attachment's output stream; every event ends on a zstd flush boundary.
class OutputStream {
  #decompressor = createZstdDecompress();
  #chunks = [];
  #error = null;
  constructor() {
    this.#decompressor.on("data", (chunk) => this.#chunks.push(chunk));
    this.#decompressor.on("error", (error) => (this.#error = error));
  }
  async decode(body) {
    await new Promise((resolve) => this.#decompressor.write(body, () => resolve()));
    await new Promise((resolve) => setImmediate(resolve));
    if (this.#error) throw this.#error;
    const raw = Buffer.concat(this.#chunks.splice(0));
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  close() {
    this.#decompressor.destroy();
  }
}
function sameBytes(left, right) {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}
function concatBytes(parts) {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}
function uuidBytes(text) {
  const hex = text.replaceAll("-", "");
  assert.match(hex, /^[0-9a-f]{32}$/i);
  return Uint8Array.from(hex.match(/../g), (pair) => Number.parseInt(pair, 16));
}
function attachmentText(id) {
  return id.toString(16).padStart(32, "0");
}
function geometry(bytes, offset = 0) {
  return {
    cols: readUint16LE(bytes, offset),
    rows: readUint16LE(bytes, offset + 2),
    cellWidthPx: readUint16LE(bytes, offset + 4),
    cellHeightPx: readUint16LE(bytes, offset + 6),
  };
}
class RawClient {
  constructor(url, origin, name) {
    this.url = url;
    this.origin = origin;
    this.name = name;
    this.clientId = randomBytes(16);
    this.socket = null;
    this.requestId = 1n;
    this.queue = [];
    this.waiters = [];
    this.failure = null;
    this.attachments = new Map();
    this.closed = false;
  }
  async connect() {
    const socket = new WebSocket(this.url, {
      protocols: SUBPROTOCOL,
      headers: { Origin: this.origin },
    });
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      try {
        const bytes =
            event.data instanceof ArrayBuffer
              ? new Uint8Array(event.data)
              : new Uint8Array(event.data),
          frame = decodeServerFrame(bytes);
        frame.frameLength = bytes.byteLength;
        if (frame.type === FrameType.PING) {
          assert.equal(frame.payload.byteLength, 8);
          this.send(FrameType.PONG, frame.payload, null, frame.requestId);
          return;
        }
        const waiter = this.waiters.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(frame);
        } else this.queue.push(frame);
      } catch (error) {
        this.fail(error);
      }
    });
    const opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`${this.name} websocket open timeout`)), 3000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(Error(`${this.name} websocket error`));
        },
        { once: true },
      );
      socket.addEventListener(
        "close",
        () => {
          clearTimeout(timer);
          reject(Error(`${this.name} websocket closed before open`));
        },
        { once: true },
      );
    });
    socket.addEventListener("close", () => {
      this.closed = true;
      if (!this.failure) this.fail(Error(`${this.name} websocket closed`));
    });
    await opened;
    const hello = new Uint8Array(56);
    hello.set(this.clientId, 0);
    hello.set(ABI_DIGEST, 16);
    writeUint32LE(hello, 48, INITIAL_CREDIT);
    writeUint32LE(hello, 52, MAX_FRAME_LENGTH);
    this.send(FrameType.HELLO, hello, null, this.nextRequest());
    const welcome = await this.until((frame) => frame.type === FrameType.WELCOME, "WELCOME");
    assert.equal(welcome.payload.byteLength, 88);
    assert.ok(sameBytes(welcome.payload.subarray(16, 48), ABI_DIGEST), `${this.name} WELCOME ABI`);
    assert.equal(readUint32LE(welcome.payload, 48), MAX_FRAME_LENGTH);
    assert.equal(readUint32LE(welcome.payload, 56), INITIAL_CREDIT);
    return this;
  }
  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
  nextRequest() {
    const value = this.requestId;
    this.requestId += 1n;
    return value;
  }
  send(type, payload, attachment, requestId = 0n) {
    assert.equal(this.socket?.readyState, WebSocket.OPEN, `${this.name} socket open`);
    const frame = encodeClientFrame({
      type,
      payload,
      requestId,
      attachmentId: attachment?.id ?? 0n,
      sessionId: attachment?.sessionId ?? ZERO_SESSION_ID,
    });
    this.socket.send(frame);
    return frame;
  }
  nextFrame(timeoutMs) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(Error(`${this.name} frame timeout`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }
  async until(predicate, description, timeoutMs = 5000) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      let frame;
      try {
        frame = await this.nextFrame(Math.max(1, deadline - performance.now()));
      } catch (error) {
        if (error?.message === `${this.name} frame timeout`)
          throw Error(`${this.name} timed out waiting for ${description}`, {
            cause: error,
          });
        throw error;
      }
      await this.dispatch(frame);
      if (predicate(frame)) return frame;
    }
    throw Error(`${this.name} timed out waiting for ${description}`);
  }
  attachmentFor(frame) {
    const attachment = this.attachments.get(frame.attachmentId.toString());
    assert.ok(attachment, `${this.name} unknown attachment ${frame.attachmentId}`);
    return attachment;
  }
  resetOutputStream(attachment) {
    attachment.outputStream?.close();
    attachment.outputStream = new OutputStream();
  }
  async dispatch(frame) {
    if (
      frame.type === FrameType.WELCOME ||
      frame.type === FrameType.PONG ||
      frame.type === FrameType.SESSION_CHANGED
    )
      return;
    if (frame.type === FrameType.ERROR) {
      assert.ok(frame.payload.byteLength >= 4, `${this.name} ERROR payload`);
      frame.errorCode = readUint16LE(frame.payload, 0);
      frame.errorFatal = readUint16LE(frame.payload, 2) !== 0;
      frame.errorDetail = decoder.decode(frame.payload.subarray(4));
      return;
    }
    const attachment = this.attachmentFor(frame);
    if (frame.type === FrameType.ATTACH_BEGIN) {
      assert.equal(frame.payload.byteLength, 88);
      assert.equal(frame.payload[18], 0);
      assert.equal(frame.payload[19], 0);
      assert.ok(frame.payload.subarray(36, 48).every((value) => value === 0));
      attachment.generation = frame.payload.slice(0, 16);
      attachment.mode = frame.payload[16];
      attachment.state = frame.payload[17];
      attachment.geometry = geometry(frame.payload, 20);
      attachment.replayGeometry = geometry(frame.payload, 28);
      attachment.highEventSeq = readUint64LE(frame.payload, 48);
      attachment.highOutputOffset = readUint64LE(frame.payload, 56);
      attachment.leaseEpoch = readUint64LE(frame.payload, 64);
      attachment.controllerId = readId(frame.payload, 72);
      if (attachment.mode === 0) {
        attachment.eventSeq = 0n;
        attachment.outputOffset = 0n;
      }
      this.resetOutputStream(attachment);
      return;
    }
    if (frame.type === FrameType.CHECKPOINT_BEGIN) {
      assert.equal(frame.payload.byteLength, 56);
      attachment.checkpoint = new Uint8Array(readUint32LE(frame.payload, 0));
      assert.ok(attachment.checkpoint.byteLength > 0);
      attachment.checkpointOffset = 0;
      attachment.checkpointEventSeq = readUint64LE(frame.payload, 8);
      attachment.checkpointOutputOffset = readUint64LE(frame.payload, 16);
      attachment.checkpointHash = frame.payload.slice(24, 56);
      return;
    }
    if (frame.type === FrameType.CHECKPOINT_CHUNK) {
      assert.ok(attachment.checkpoint && frame.flags === COMPRESSED_FLAG);
      assert.ok(frame.payload.byteLength >= 16);
      const offset = readUint32LE(frame.payload, 0),
        rawLength = readUint32LE(frame.payload, 4),
        crc = readUint32LE(frame.payload, 8),
        wireLength = readUint32LE(frame.payload, 12);
      assert.equal(offset, attachment.checkpointOffset);
      assert.equal(wireLength, frame.payload.byteLength - 16);
      const raw = zstdDecompressSync(frame.payload.subarray(16));
      assert.equal(raw.byteLength, rawLength);
      assert.equal(crc32c(raw), crc);
      assert.ok(offset + rawLength <= attachment.checkpoint.byteLength);
      attachment.checkpoint.set(raw, offset);
      attachment.checkpointOffset += rawLength;
      attachment.checkpointChunks += 1;
      this.credit(attachment, rawLength + headerLength(FrameType.CHECKPOINT_CHUNK) + 16);
      return;
    }
    if (frame.type === FrameType.CHECKPOINT_END) {
      assert.equal(frame.payload.byteLength, 32);
      assert.equal(attachment.checkpointOffset, attachment.checkpoint.byteLength);
      const digest = new Uint8Array(createHash("sha256").update(attachment.checkpoint).digest());
      assert.ok(sameBytes(digest, attachment.checkpointHash));
      assert.ok(sameBytes(digest, frame.payload));
      attachment.eventSeq = attachment.checkpointEventSeq;
      attachment.outputOffset = attachment.checkpointOutputOffset;
      attachment.checkpointDigest = digest;
      return;
    }
    if (frame.type === FrameType.EVENT_BATCH) {
      assert.ok(frame.payload.byteLength >= 32);
      const kind = frame.payload[0],
        rawLength = readUint32LE(frame.payload, 4),
        crc = readUint32LE(frame.payload, 8),
        wireLength = readUint32LE(frame.payload, 12),
        eventSeq = readUint64LE(frame.payload, 16),
        outputOffset = readUint64LE(frame.payload, 24);
      assert.equal(wireLength, frame.payload.byteLength - 32);
      assert.equal(eventSeq, attachment.eventSeq + 1n, `${this.name} contiguous event sequence`);
      assert.equal(outputOffset, attachment.outputOffset, `${this.name} contiguous output cursor`);
      const body = frame.payload.subarray(32);
      let raw = body,
        event = { kind, seq: eventSeq, outputOffset };
      if (kind === 0) {
        assert.equal(frame.flags, COMPRESSED_FLAG);
        assert.ok(attachment.outputStream, `${this.name} output before ATTACH_BEGIN`);
        raw = await attachment.outputStream.decode(body);
        assert.equal(raw.byteLength, rawLength);
        assert.equal(crc32c(raw), crc);
        attachment.outputRawBytes += raw.byteLength;
        attachment.outputCompressedBytes += body.byteLength;
        attachment.outputEventCount += 1;
        attachment.outputWireBytes += frame.frameLength;
        attachment.outputParts.push(raw.slice());
        event.output = raw.slice();
        attachment.outputOffset += BigInt(raw.byteLength);
      } else if (kind === 1) {
        assert.equal(frame.flags, 0);
        assert.equal(rawLength, 8);
        assert.equal(body.byteLength, 8);
        assert.equal(crc, 0);
        event.geometry = geometry(body);
      } else if (kind === 2) {
        assert.equal(frame.flags, 0);
        assert.equal(rawLength, 12);
        assert.equal(body.byteLength, 12);
        assert.equal(crc, 0);
        event.exitStatus = new DataView(body.buffer, body.byteOffset, body.byteLength).getInt32(
          0,
          true,
        );
        attachment.exited = true;
      } else assert.fail(`${this.name} unknown event kind ${kind}`);
      assert.equal(raw.byteLength, rawLength);
      attachment.events.push(event);
      attachment.eventSeq = eventSeq;
      this.ack(attachment, kind === 0 ? rawLength + headerLength(FrameType.EVENT_BATCH) + 32 : 128);
      return;
    }
    if (frame.type === FrameType.LIVE_BARRIER) {
      assert.equal(frame.payload.byteLength, 16);
      assert.equal(
        readUint64LE(frame.payload, 0),
        attachment.eventSeq,
        `${this.name} barrier event cursor`,
      );
      assert.equal(
        readUint64LE(frame.payload, 8),
        attachment.outputOffset,
        `${this.name} barrier output cursor`,
      );
      attachment.live = true;
      this.ack(attachment, attachment.barrierCredit);
      return;
    }
    if (frame.type === FrameType.LEASE_CHANGED) {
      assert.equal(frame.payload.byteLength, 32);
      attachment.leaseEpoch = readUint64LE(frame.payload, 0);
      attachment.controllerId = readId(frame.payload, 8);
      attachment.geometry = geometry(frame.payload, 24);
      return;
    }
    if (frame.type === FrameType.CANONICAL_RESIZE) {
      assert.equal(frame.payload.byteLength, 24);
      attachment.leaseEpoch = readUint64LE(frame.payload, 0);
      attachment.geometry = geometry(frame.payload, 16);
      return;
    }
    if (frame.type === FrameType.INPUT_ACK) {
      assert.equal(frame.payload.byteLength, 12);
      const sequence = readUint64LE(frame.payload, 0);
      attachment.inputAcks.set(sequence.toString(), readUint16LE(frame.payload, 8));
      return;
    }
    if (frame.type === FrameType.EXITED) {
      assert.equal(frame.payload.byteLength, 20);
      attachment.exited = true;
      attachment.exitEventSeq = readUint64LE(frame.payload, 0);
      return;
    }
    assert.fail(`${this.name} unexpected frame type ${frame.type}`);
  }
  ack(attachment, credit) {
    const payload = new Uint8Array(24);
    writeUint64LE(payload, 0, attachment.eventSeq);
    writeUint64LE(payload, 8, attachment.outputOffset);
    writeUint32LE(payload, 16, credit);
    this.send(FrameType.ACK, payload, attachment);
  }
  credit(attachment, amount) {
    const payload = new Uint8Array(8);
    writeUint32LE(payload, 0, amount);
    this.send(FrameType.CREDIT, payload, attachment);
  }
  async attach(
    session,
    generation,
    eventSeq = 0n,
    outputOffset = 0n,
    id,
    initialCredit = INITIAL_CREDIT,
    barrierCredit = INITIAL_CREDIT,
    previousAttachmentId = 0n,
  ) {
    const attachment = {
      id: id ?? BigInt(`0x${randomBytes(16).toString("hex")}`),
      sessionId: uuidBytes(session.id),
      generation: uuidBytes(generation),
      eventSeq: BigInt(eventSeq),
      outputOffset: BigInt(outputOffset),
      outputParts: [],
      events: [],
      inputAcks: new Map(),
      checkpointChunks: 0,
      outputRawBytes: 0,
      outputCompressedBytes: 0,
      outputEventCount: 0,
      outputWireBytes: 0,
      barrierCredit,
      live: false,
      exited: false,
    };
    this.attachments.set(attachment.id.toString(), attachment);
    const payload = new Uint8Array(56);
    payload.set(attachment.generation, 0);
    writeUint64LE(payload, 16, attachment.eventSeq);
    writeUint64LE(payload, 24, attachment.outputOffset);
    writeUint32LE(payload, 32, initialCredit);
    writeId(payload, 40, previousAttachmentId);
    const requestId = this.nextRequest();
    this.send(FrameType.ATTACH, payload, attachment, requestId);
    await this.until(
      (frame) => frame.type === FrameType.LIVE_BARRIER && frame.requestId === requestId,
      `${this.name} attach barrier`,
    );
    assert.ok(attachment.live);
    return attachment;
  }
  async attachExpectError(session, generation, eventSeq, outputOffset, id, initialCredit) {
    const attachment = {
      id: id ?? BigInt(`0x${randomBytes(16).toString("hex")}`),
      sessionId: uuidBytes(session.id),
      generation: uuidBytes(generation),
      eventSeq: BigInt(eventSeq),
      outputOffset: BigInt(outputOffset),
      outputParts: [],
      events: [],
      inputAcks: new Map(),
      checkpointChunks: 0,
      outputRawBytes: 0,
      outputCompressedBytes: 0,
      outputEventCount: 0,
      outputWireBytes: 0,
      barrierCredit: 0,
    };
    this.attachments.set(attachment.id.toString(), attachment);
    const payload = new Uint8Array(56);
    payload.set(attachment.generation, 0);
    writeUint64LE(payload, 16, attachment.eventSeq);
    writeUint64LE(payload, 24, attachment.outputOffset);
    writeUint32LE(payload, 32, initialCredit);
    const requestId = this.nextRequest();
    this.send(FrameType.ATTACH, payload, attachment, requestId);
    return this.until(
      (frame) => frame.type === FrameType.ERROR && frame.requestId === requestId,
      `${this.name} attach error`,
    );
  }
  async claim(attachment) {
    const requestId = this.nextRequest();
    this.send(FrameType.CLAIM_CONTROL, new Uint8Array(0), attachment, requestId);
    await this.until(
      (frame) => frame.type === FrameType.LEASE_CHANGED && frame.requestId === requestId,
      `${this.name} claim lease`,
    );
    assert.equal(attachment.controllerId, attachment.id);
    return attachment.leaseEpoch;
  }
  async input(attachment, text, leaseEpoch = attachment.leaseEpoch) {
    const bytes = typeof text === "string" ? encoder.encode(text) : text,
      sequence = (attachment.inputSequence ?? 0n) + 1n;
    attachment.inputSequence = sequence;
    const payload = new Uint8Array(24 + bytes.byteLength);
    writeUint64LE(payload, 0, leaseEpoch);
    writeUint64LE(payload, 8, attachment.eventSeq);
    writeUint64LE(payload, 16, sequence);
    payload.set(bytes, 24);
    const requestId = this.nextRequest();
    this.send(FrameType.INPUT, payload, attachment, requestId);
    const frame = await this.until(
      (value) => value.type === FrameType.INPUT_ACK && value.requestId === requestId,
      `${this.name} input ACK`,
    );
    assert.equal(readUint64LE(frame.payload, 0), sequence);
    return readUint16LE(frame.payload, 8);
  }
  async resize(attachment, cols, rows, leaseEpoch = attachment.leaseEpoch) {
    const payload = new Uint8Array(24);
    writeUint64LE(payload, 0, leaseEpoch);
    writeUint64LE(payload, 8, attachment.eventSeq);
    encodeResizePayload(cols, rows, payload.subarray(16, 20));
    writeUint16LE(payload, 20, 8);
    writeUint16LE(payload, 22, 16);
    const requestId = this.nextRequest();
    this.send(FrameType.RESIZE_REQUEST, payload, attachment, requestId);
    const frame = await this.until(
      (value) => value.type === FrameType.CANONICAL_RESIZE && value.requestId === requestId,
      `${this.name} resize response`,
    );
    return {
      operationId: readUint64LE(frame.payload, 8),
      geometry: geometry(frame.payload, 16),
      epoch: readUint64LE(frame.payload, 0),
    };
  }
  async resizeError(attachment, cols, rows, leaseEpoch) {
    const payload = new Uint8Array(24);
    writeUint64LE(payload, 0, leaseEpoch);
    writeUint64LE(payload, 8, attachment.eventSeq);
    encodeResizePayload(cols, rows, payload.subarray(16, 20));
    writeUint16LE(payload, 20, 8);
    writeUint16LE(payload, 22, 16);
    const requestId = this.nextRequest();
    this.send(FrameType.RESIZE_REQUEST, payload, attachment, requestId);
    const frame = await this.until(
      (value) => value.type === FrameType.ERROR && value.requestId === requestId,
      `${this.name} stale resize error`,
    );
    assert.equal(frame.errorFatal, false);
    return frame.errorCode;
  }
  async waitOutput(attachment, marker, occurrences = 1, timeoutMs = 5000) {
    const needle = typeof marker === "string" ? encoder.encode(marker) : marker,
      present = () => {
        const bytes = concatBytes(attachment.outputParts);
        let count = 0;
        for (let index = 0; index + needle.byteLength <= bytes.byteLength; index += 1)
          if (needle.every((value, offset) => bytes[index + offset] === value)) {
            count += 1;
            index += needle.byteLength - 1;
          }
        return count >= occurrences;
      };
    if (!present())
      await this.until(() => present(), `${this.name} output ${String(marker)}`, timeoutMs);
    return concatBytes(attachment.outputParts);
  }
  async waitQuiet(attachment, quietMs = 100) {
    const timeoutMs = Math.max(0, Math.min(quietMs, 1000));
    while (true)
      try {
        await this.dispatch(await this.nextFrame(timeoutMs));
      } catch (error) {
        if (error?.message === `${this.name} frame timeout`) return;
        throw error;
      }
  }
  async waitEvent(attachment, predicate, description) {
    if (!attachment.events.some(predicate))
      await this.until(() => attachment.events.some(predicate), description);
    return attachment.events.find(predicate);
  }
  async waitError() {
    return this.until((frame) => frame.type === FrameType.ERROR, `${this.name} ERROR`);
  }
  async heartbeat() {
    const requestId = this.nextRequest();
    const payload = new Uint8Array(8);
    writeUint64LE(payload, 0, requestId);
    this.send(FrameType.PING, payload, null, requestId);
    const frame = await this.until(
      (value) => value.type === FrameType.PONG && sameBytes(value.payload, payload),
      `${this.name} heartbeat PONG`,
    );
    assert.ok(sameBytes(frame.payload, payload));
  }
  outputLength(attachment) {
    return concatBytes(attachment.outputParts).byteLength;
  }
  outputSince(attachment, offset) {
    return concatBytes(attachment.outputParts).subarray(offset);
  }
  outputText(attachment, offset = 0) {
    return decoder.decode(this.outputSince(attachment, offset));
  }
  async detach(attachment) {
    if (attachment.live && this.socket?.readyState === WebSocket.OPEN)
      this.send(FrameType.DETACH, new Uint8Array(0), attachment);
    await this.close();
  }
  async close() {
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise((resolve) =>
      this.socket.addEventListener("close", resolve, { once: true }),
    );
    this.socket.close();
    await Promise.race([closed, wait(1000)]);
  }
}
function mutationHeaders(origin, key) {
  return { Origin: origin, "Idempotency-Key": key };
}
async function createSession(base, key) {
  return fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: {
      ...mutationHeaders(base, key),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      profile: "shell",
      name: "WS protocol",
      geometry: { cols: 80, rows: 24 },
    }),
  });
}
async function getSession(base, id) {
  const response = await fetch(`${base}/api/sessions/${id}`);
  assert.equal(response.status, 200);
  return response.json();
}
async function waitSession(base, id, predicate, message) {
  let latest;
  await waitFor(
    async () => {
      try {
        latest = await getSession(base, id);
        return predicate(latest);
      } catch {
        return false;
      }
    },
    12000,
    () => `${message}: ${JSON.stringify(latest)}`,
  );
  return latest;
}
async function unsupportedWebSocket(url, origin) {
  const socket = new WebSocket(url, {
      protocols: "bcw.unsupported",
      headers: { Origin: origin },
    }),
    rejected = new Promise((resolve) => {
      socket.addEventListener("error", () => resolve(), { once: true });
      socket.addEventListener("close", () => resolve(), { once: true });
    });
  await Promise.race([
    rejected,
    wait(2000).then(() => {
      throw Error("unsupported websocket was accepted");
    }),
  ]);
  socket.close();
}
async function workerPids(parentPid) {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,args="]);
  return stdout
    .split(
      `
`,
    )
    .flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      return match && Number(match[2]) === parentPid && match[3].includes("--session-worker")
        ? [Number(match[1])]
        : [];
    });
}
async function processState(pid) {
  try {
    return (await execFileAsync("ps", ["-p", String(pid), "-o", "stat="])).stdout.trim();
  } catch {
    return "";
  }
}
const { runSessionWebSocketScenario } = await import("./session-ws-scenario.mjs");
await runSessionWebSocketScenario(serverPath, {
  RawClient,
  attachmentText,
  concatBytes,
  createSession,
  decoder,
  freePort,
  mutationHeaders,
  processState,
  sameBytes,
  stopServer: (server) => terminateProcess(server, 1500),
  unsupportedWebSocket,
  waitFor,
  waitSession,
  workerPids,
});
