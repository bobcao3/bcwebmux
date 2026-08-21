// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { decompress } from "./fzstd.js";
import { appendCheckpoint, beginCheckpoint, ensureShadow, finishCheckpoint, resetCheckpointTransaction, rollbackShadow } from "./SessionCheckpoint.js";
import {
  ABI_DIGEST,
  acceptAttachmentEpoch,
  bytesUuid,
  crc32c,
  createEmitter,
  equalBytes,
  handleInputStatus,
  markRecordDetached,
  randomUint64,
  rememberStaleAttachment,
  readGeometry,
  isConnectionFrame,
  stableClientId,
  stateName,
  updateRtt,
  validWelcomeCapabilities,
  uuidBytes,
  writeGeometry,
} from "./SessionWire.js";
import {
  COMPRESSED_FLAG,
  FrameType,
  MAX_FRAME_LENGTH,
  SUBPROTOCOL,
  ZERO_SESSION_ID,
  decodeFrame,
  encodeFrame,
  readUint16LE,
  readUint32LE,
  readUint64LE,
  writeUint32LE,
  writeUint64LE,
} from "./protocol.js";

const INITIAL_CREDIT = 32 * 1024 * 1024;
const MAX_BUFFERED_AMOUNT = 4 * 1024 * 1024;
const MAX_FROZEN_BYTES = 4 * 1024 * 1024;
const INITIAL_RECONNECT_MS = 250;
const MAX_RECONNECT_MS = 5000;
const RTT_INTERVAL_MS = 1000;
const textDecoder = new TextDecoder();

export class SessionTransport {
  #url;
  #webSocketFactory;
  #socket = null;
  #terminal = null;
  #terminalDisposables = [];
  #records = new Map();
  #staleAttachmentIds = new Set();
  #activeRecord = null;
  #pendingSize = null;
  #connectionSequence = 0n;
  #serverSequence = 0n;
  #requestSequence = randomUint64();
  #inputSequence = randomUint64() & ((1n << 63n) - 1n);
  #clientId;
  #readyPromise = null;
  #readyResolve = null;
  #readyReject = null;
  #helloRequestId = 0n;
  #messageChain = Promise.resolve();
  #reconnectTimer = 0;
  #reconnectDelay = INITIAL_RECONNECT_MS;
  #rttTimer = 0;
  #rttSent = new Map();
  #disposed = false;
  #statusEmitter = createEmitter();
  #sessionChangedEmitter = createEmitter();
  #errorEmitter = createEmitter();
  #state = {
    connected: false,
    status: "disconnected",
    rxBytes: 0,
    rxWireBytes: 0,
    txBytes: 0,
    txWireBytes: 0,
    wsRttLatestMs: null,
    wsRttMedianMs: null,
    wsRttP95Ms: null,
    attachmentCount: 0,
  };

  constructor(options = {}) {
    this.#url = options.url ?? null;
    this.#webSocketFactory = options.webSocketFactory ?? ((url, protocol) => new WebSocket(url, protocol));
    this.#clientId = options.clientInstanceId ? uuidBytes(options.clientInstanceId) : stableClientId();
  }

  activate(terminal) {
    if (!terminal) throw new TypeError("SessionTransport.activate requires a terminal");
    if (this.#terminal === terminal) return;
    for (const disposable of this.#terminalDisposables.splice(0)) disposable.dispose?.();
    this.#terminal = terminal;
    this.#terminalDisposables = [
      terminal.onResize(size => {
        this.#pendingSize = { ...size };
        this.#sendResize(size);
      }),
      terminal.onSelectionModeChange(event => {
        if (!event.active) this.#flushFrozen(this.#activeRecord);
      }),
    ];
  }

  connect() {
    if (this.#disposed) return Promise.reject(new Error("session transport is disposed"));
    if (this.#socket && this.#socket.readyState !== WebSocket.CLOSED) return this.#readyPromise;
    this.#clearReconnect();
    this.#setStatus("connecting", false);
    this.#readyPromise = new Promise((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    const socket = this.#webSocketFactory(this.#resolveUrl(), SUBPROTOCOL);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => this.#socketOpen(socket));
    socket.addEventListener("message", event => {
      this.#messageChain = this.#messageChain.then(() => this.#socketMessage(socket, event)).catch(error => this.#fail(error));
    });
    socket.addEventListener("close", () => this.#socketClose(socket));
    socket.addEventListener("error", () => socket.close());
    this.#socket = socket;
    return this.#readyPromise;
  }

  async attach(metadata, core, options = {}) {
    if (!metadata?.id || !metadata?.generation || !core) throw new TypeError("attach requires session metadata and core");
    await this.connect();
    const record = {
      metadata,
      sessionId: uuidBytes(metadata.id),
      generation: uuidBytes(metadata.generation),
      attachmentId: randomUint64(),
      attachRequestId: 0n,
      epoch: 0n,
      eventSeq: BigInt(options.eventSeq ?? 0),
      outputOffset: BigInt(options.outputOffset ?? 0),
      core,
      state: "attaching",
      live: false,
      active: true,
      controller: false,
      leaseEpoch: 0n,
      inputDisposable: core.onData(data => this.#sendInput(record, data)),
      checkpoint: null,
      checkpointOffset: 0,
      checkpointHash: null,
      previousCore: null,
      previousInputDisposable: null,
      previousWasHostActive: false,
      frozen: [],
      frozenBytes: 0,
      claim: options.claim !== false,
      resolve: null,
      reject: null,
      promise: null,
    };
    record.promise = new Promise((resolve, reject) => { record.resolve = resolve; record.reject = reject; });
    this.#records.set(record.attachmentId.toString(), record);
    this.#state.attachmentCount = this.#records.size;
    this.#sendAttach(record);
    return record.promise;
  }

  setActive(record) {
    if (record && !this.#records.has(record.attachmentId.toString())) throw new Error("attachment is not owned by this transport");
    if (this.#activeRecord !== record && this.#terminal?.selectionMode) this.#terminal.exitSelectionMode({ restoreFocus: false });
    this.#flushFrozen(this.#activeRecord);
    this.#activeRecord = record;
    if (record?.live && this.#terminal && this.#terminal.core !== record.core) this.#terminal.attachCore(record.core);
    if (record?.live && record.claim && !record.controller) this.claimControl(record);
  }

  claimControl(record = this.#activeRecord) {
    if (!record?.live) return false;
    this.#send(FrameType.CLAIM_CONTROL, new Uint8Array(0), record, this.#nextRequestId());
    return true;
  }

  detach(record) {
    if (!record) return;
    if (record.epoch) this.#send(FrameType.DETACH, new Uint8Array(0), record, this.#nextRequestId());
    this.#removeRecord(record, new Error("attachment detached"));
  }

  onStatus(listener) { return this.#statusEmitter.event(listener); }
  onSessionChanged(listener) { return this.#sessionChangedEmitter.event(listener); }
  onError(listener) { return this.#errorEmitter.event(listener); }
  get state() { return this.#state; }
  get activeAttachment() { return this.#activeRecord; }
  get clientInstanceId() { return bytesUuid(this.#clientId); }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearReconnect();
    clearInterval(this.#rttTimer);
    this.#rttTimer = 0;
    for (const disposable of this.#terminalDisposables.splice(0)) disposable.dispose?.();
    for (const record of [...this.#records.values()]) this.#removeRecord(record, new Error("session transport disposed"));
    this.#socket?.close();
    this.#socket = null;
    this.#setStatus("disconnected", false);
    this.#statusEmitter.clear();
    this.#sessionChangedEmitter.clear();
    this.#errorEmitter.clear();
  }

  #socketOpen(socket) {
    if (socket !== this.#socket || this.#disposed) return;
    this.#connectionSequence = 0n;
    this.#serverSequence = 0n;
    this.#staleAttachmentIds.clear();
    this.#setStatus("negotiating", false);
    const payload = new Uint8Array(56);
    payload.set(this.#clientId, 0);
    payload.set(ABI_DIGEST, 16);
    writeUint32LE(payload, 48, INITIAL_CREDIT);
    writeUint32LE(payload, 52, MAX_FRAME_LENGTH);
    this.#helloRequestId = this.#nextRequestId();
    this.#send(FrameType.HELLO, payload, null, this.#helloRequestId);
  }

  async #socketMessage(socket, event) {
    if (socket !== this.#socket || this.#disposed) return;
    const bytes = new Uint8Array(event.data);
    this.#state.rxWireBytes += bytes.byteLength;
    const frame = decodeFrame(bytes);
    if (frame.connectionSequence !== this.#serverSequence + 1n) throw new Error("server connection sequence gap");
    this.#serverSequence = frame.connectionSequence;
    if (frame.type === FrameType.WELCOME) return this.#welcome(frame);
    if (!this.#state.connected && frame.type === FrameType.ERROR) return this.#protocolError(null, frame);
    if (!this.#state.connected) throw new Error("WELCOME required before session frames");
    const record = frame.attachmentId ? this.#records.get(frame.attachmentId.toString()) : null;
    if (frame.attachmentId && !record && this.#staleAttachmentIds.has(frame.attachmentId.toString())) return;
    switch (frame.type) {
      case FrameType.ATTACH_BEGIN: return this.#attachBegin(record, frame);
      case FrameType.CHECKPOINT_BEGIN: return this.#checkpointBegin(record, frame);
      case FrameType.CHECKPOINT_CHUNK: return this.#checkpointChunk(record, frame);
      case FrameType.CHECKPOINT_END: return this.#checkpointEnd(record, frame);
      case FrameType.EVENT_BATCH: return this.#event(record, frame);
      case FrameType.LIVE_BARRIER: return this.#live(record, frame);
      case FrameType.LEASE_CHANGED: return this.#lease(record, frame);
      case FrameType.CANONICAL_RESIZE: return this.#canonicalResize(record, frame);
      case FrameType.INPUT_ACK: return this.#inputAck(record, frame);
      case FrameType.RESYNC_REQUIRED: return this.#resync(record);
      case FrameType.EXITED: return this.#exited(record, frame);
      case FrameType.SESSION_CHANGED:
        if (!isConnectionFrame(frame) || frame.requestId !== 0n || frame.payload.byteLength !== 8) throw new Error("invalid SESSION_CHANGED");
        this.#sessionChangedEmitter.emit(readUint64LE(frame.payload, 0));
        return;
      case FrameType.PING:
        if (!isConnectionFrame(frame) || frame.requestId !== 0n || frame.payload.byteLength !== 8) throw new Error("invalid PING");
        this.#send(FrameType.PONG, frame.payload, null, frame.requestId);
        return;
      case FrameType.PONG:
        if (!isConnectionFrame(frame) || frame.requestId === 0n || frame.payload.byteLength !== 8) throw new Error("invalid PONG");
        return this.#pong(frame);
      case FrameType.ERROR: return this.#protocolError(record, frame);
      default: throw new Error(`unexpected server frame ${frame.type}`);
    }
  }

  #welcome(frame) {
    if (frame.payload.byteLength !== 88 || !isConnectionFrame(frame) || this.#helloRequestId === 0n || frame.requestId !== this.#helloRequestId) throw new Error("invalid WELCOME");
    if (!equalBytes(frame.payload.subarray(16, 48), ABI_DIGEST)) throw new Error("terminal ABI mismatch; reload/update required");
    if (!validWelcomeCapabilities(frame.payload, MAX_FRAME_LENGTH, INITIAL_CREDIT)) throw new Error("invalid WELCOME capabilities");
    this.#helloRequestId = 0n;
    this.#reconnectDelay = INITIAL_RECONNECT_MS;
    this.#setStatus("connected", true);
    this.#readyResolve?.(this);
    this.#readyResolve = null;
    this.#readyReject = null;
    if (!this.#rttTimer) this.#rttTimer = setInterval(() => this.#ping(), RTT_INTERVAL_MS);
    const records = [...this.#records.values()];
    this.#records.clear();
    for (const record of records) {
      record.attachmentId = randomUint64();
      record.epoch = 0n;
      record.live = false;
      record.controller = false;
      record.state = "attaching";
      this.#records.set(record.attachmentId.toString(), record);
      this.#sendAttach(record);
    }
  }

  async #attachBegin(record, frame) {
    this.#requireRecord(record, frame);
    if (frame.payload.byteLength !== 80 || frame.attachmentEpoch === 0n || record.attachRequestId === 0n || frame.requestId !== record.attachRequestId || frame.payload[18] !== 0 || frame.payload[19] !== 0 || frame.payload.subarray(36, 48).some(byte => byte !== 0)) throw new Error("invalid ATTACH_BEGIN");
    acceptAttachmentEpoch(record, frame);
    record.generation = frame.payload.slice(0, 16);
    const mode = frame.payload[16];
    record.metadata.state = stateName(frame.payload[17]);
    const geometry = readGeometry(frame.payload, 20);
    record.metadata.geometry = geometry;
    const replayGeometry = readGeometry(frame.payload, 28);
    record.leaseEpoch = readUint64LE(frame.payload, 64);
    const controller = readUint64LE(frame.payload, 72);
    record.controller = controller === record.attachmentId;
    record.state = mode === 1 ? "restoring" : "catching-up";
    if (mode === 1 || (mode === 0 && (record.eventSeq !== 0n || record.outputOffset !== 0n))) {
      if (!await ensureShadow(this.#terminal, this.#records, record, data => this.#sendInput(record, data))) return;
    }
    this.#requireRecord(record, frame);
    if (mode === 0) {
      record.core.reset();
      record.eventSeq = 0n;
      record.outputOffset = 0n;
      record.core.setReplayMode(true);
      record.core.resizeCanonical(replayGeometry);
    } else if (mode === 2) {
      record.core.setReplayMode(true);
      if (record.eventSeq === 0n && record.outputOffset === 0n) record.core.resizeCanonical(replayGeometry);
    } else if (mode !== 1) {
      throw new Error("invalid attach mode");
    }
  }

  #checkpointBegin(record, frame) {
    this.#requireRecord(record, frame);
    beginCheckpoint(record, frame);
  }

  #checkpointChunk(record, frame) {
    this.#requireRecord(record, frame);
    const rawLength = appendCheckpoint(record, frame);
    this.#sendCredit(record, rawLength + 80);
  }

  async #checkpointEnd(record, frame) {
    this.#requireRecord(record, frame);
    const restored = await finishCheckpoint(record, frame);
    if (!restored) return;
    record.core.restoreSnapshot(restored.bytes);
    record.core.setReplayMode(true);
    record.eventSeq = restored.eventSeq;
    record.outputOffset = restored.outputOffset;
    record.state = "catching-up";
  }

  #event(record, frame) {
    this.#requireRecord(record, frame);
    if (frame.payload.byteLength < 32) throw new Error("invalid EVENT_BATCH");
    if (record === this.#activeRecord && this.#terminal?.selectionMode) {
      record.frozen.push({ flags: frame.flags, payload: frame.payload.slice() });
      record.frozenBytes += frame.payload.byteLength;
      if (record.frozenBytes > MAX_FROZEN_BYTES) this.#terminal.exitSelectionMode({ restoreFocus: false });
      return;
    }
    this.#applyEvent(record, frame.flags, frame.payload);
  }

  #applyEvent(record, flags, payload) {
    const kind = payload[0];
    const rawLength = readUint32LE(payload, 4);
    const crc = readUint32LE(payload, 8);
    const wireLength = readUint32LE(payload, 12);
    const eventSeq = readUint64LE(payload, 16);
    const outputOffset = readUint64LE(payload, 24);
    if (eventSeq <= record.eventSeq) return;
    if (eventSeq !== record.eventSeq + 1n || outputOffset !== record.outputOffset || wireLength !== payload.byteLength - 32) throw new Error("terminal event gap");
    const body = payload.subarray(32);
    if (kind === 0) {
      if (flags !== COMPRESSED_FLAG) throw new Error("output event is not independently compressed");
      if (rawLength > 256 * 1024) throw new Error("output event is too large");
      const raw = decompress(body, new Uint8Array(rawLength));
      if (raw.byteLength !== rawLength || crc32c(raw) !== crc) throw new Error("corrupt output event");
      if (record === this.#activeRecord && this.#terminal) this.#terminal.write(raw);
      else record.core.write(raw);
      record.outputOffset += BigInt(raw.byteLength);
      this.#state.rxBytes += raw.byteLength;
    } else if (kind === 1) {
      if (flags !== 0 || rawLength !== 8 || body.byteLength !== 8) throw new Error("invalid resize event");
      record.core.resizeCanonical(readGeometry(body, 0));
    } else if (kind === 2) {
      if (flags !== 0 || rawLength !== 12 || body.byteLength !== 12) throw new Error("invalid exit event");
      record.metadata.exitStatus = new DataView(body.buffer, body.byteOffset, body.byteLength).getInt32(0, true);
      record.metadata.state = "exited";
    } else {
      throw new Error("unknown terminal event kind");
    }
    record.eventSeq = eventSeq;
    this.#sendAck(record, rawLength + 128);
  }

  #live(record, frame) {
    this.#requireRecord(record, frame);
    if (frame.payload.byteLength !== 16) throw new Error("invalid LIVE_BARRIER");
    const eventSeq = readUint64LE(frame.payload, 0);
    const outputOffset = readUint64LE(frame.payload, 8);
    if (eventSeq !== record.eventSeq || outputOffset !== record.outputOffset) throw new Error("live barrier cursor mismatch");
    record.core.setReplayMode(false);
    record.live = true;
    record.state = "live";
    if (record.previousCore && (record.previousWasHostActive || record === this.#activeRecord)) this.#terminal.attachCore(record.core);
    record.previousInputDisposable?.dispose();
    record.previousCore?.dispose?.();
    record.previousInputDisposable = null;
    record.previousCore = null;
    record.previousWasHostActive = false;
    this.#sendAck(record, INITIAL_CREDIT);
    record.resolve?.(record);
    record.resolve = null;
    record.reject = null;
    if (record === this.#activeRecord && record.claim) this.claimControl(record);
  }

  #lease(record, frame) {
    this.#requireRecord(record, frame);
    if (frame.payload.byteLength !== 24) throw new Error("invalid LEASE_CHANGED");
    record.leaseEpoch = readUint64LE(frame.payload, 0);
    record.controller = readUint64LE(frame.payload, 8) === record.attachmentId;
    record.metadata.geometry = readGeometry(frame.payload, 16);
    if (record === this.#activeRecord && record.controller && this.#pendingSize) this.#sendResize(this.#pendingSize);
  }

  #canonicalResize(record, frame) {
    this.#requireRecord(record, frame);
    if (frame.payload.byteLength !== 24) throw new Error("invalid CANONICAL_RESIZE");
    record.leaseEpoch = readUint64LE(frame.payload, 0);
    record.metadata.geometry = readGeometry(frame.payload, 16);
  }

  #inputAck(record, frame) {
    this.#requireRecord(record, frame);
    if (frame.payload.byteLength !== 12) throw new Error("invalid INPUT_ACK");
    const status = readUint16LE(frame.payload, 8);
    handleInputStatus(record, status, error => this.#errorEmitter.emit(error));
  }

  #resync(record) {
    if (!record) return;
    record.live = false;
    record.state = "resync";
    rememberStaleAttachment(this.#staleAttachmentIds, record);
    this.#records.delete(record.attachmentId.toString());
    record.attachmentId = randomUint64();
    record.epoch = 0n;
    record.generation = new Uint8Array(16);
    record.eventSeq = 0n;
    record.outputOffset = 0n;
    this.#records.set(record.attachmentId.toString(), record);
    this.#sendAttach(record);
  }

  #exited(record, frame) {
    this.#requireRecord(record, frame);
    if (frame.payload.byteLength !== 20) throw new Error("invalid EXITED");
    record.metadata.state = "exited";
    record.metadata.exitStatus = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength).getInt32(8, true);
  }

  #protocolError(record, frame) {
    if (frame.payload.byteLength < 4 || (!record && !isConnectionFrame(frame)) || (record && !equalBytes(frame.sessionId, record.sessionId)) || (record && record.epoch !== 0n && frame.attachmentEpoch !== record.epoch) || (record && !record.live && record.attachRequestId !== 0n && frame.requestId !== record.attachRequestId)) throw new Error("invalid ERROR");
    const fatal = readUint16LE(frame.payload, 2) !== 0;
    const detail = textDecoder.decode(frame.payload.subarray(4));
    const error = new Error(detail || `session protocol error ${readUint16LE(frame.payload, 0)}`);
    if (record) {
      if (!record.live) {
        this.#removeRecord(record, error);
      } else {
        if (!fatal) rollbackShadow(record);
        record.reject?.(error);
        record.reject = null;
      }
    }
    this.#errorEmitter.emit(error);
    if (fatal) {
      this.dispose();
      throw error;
    }
  }

  #sendAttach(record) {
    const payload = new Uint8Array(40);
    payload.set(record.generation, 0);
    writeUint64LE(payload, 16, record.eventSeq);
    writeUint64LE(payload, 24, record.outputOffset);
    writeUint32LE(payload, 32, INITIAL_CREDIT);
    this.#send(FrameType.ATTACH, payload, record, (record.attachRequestId = this.#nextRequestId()), 0n);
  }

  #sendInput(record, data) {
    if (!record.live || !record.controller || data.byteLength === 0) return;
    if (this.#socket?.bufferedAmount > MAX_BUFFERED_AMOUNT) {
      record.controller = false;
      this.#errorEmitter.emit(new Error("terminal input dropped because websocket is backpressured"));
      return;
    }
    const payload = new Uint8Array(24 + data.byteLength);
    writeUint64LE(payload, 0, record.leaseEpoch);
    writeUint64LE(payload, 8, record.eventSeq);
    writeUint64LE(payload, 16, ++this.#inputSequence);
    payload.set(data, 24);
    if (this.#send(FrameType.INPUT, payload, record, this.#nextRequestId())) {
      this.#state.txBytes += data.byteLength;
    }
  }

  #sendResize(size) {
    const record = this.#activeRecord;
    if (!record?.live || !record.controller) return;
    const cellWidthPx = Math.max(1, Math.round(this.#terminal.state.physicalCellWidth || 8));
    const cellHeightPx = Math.max(1, Math.round(this.#terminal.state.physicalCellHeight || 16));
    const payload = new Uint8Array(24);
    writeUint64LE(payload, 0, record.leaseEpoch);
    writeUint64LE(payload, 8, record.eventSeq);
    writeGeometry(payload, 16, { cols: size.cols, rows: size.rows, cellWidthPx, cellHeightPx });
    this.#send(FrameType.RESIZE_REQUEST, payload, record, this.#nextRequestId());
  }

  #sendAck(record, credit) {
    const payload = new Uint8Array(24);
    writeUint64LE(payload, 0, record.eventSeq);
    writeUint64LE(payload, 8, record.outputOffset);
    writeUint32LE(payload, 16, Math.min(0xffffffff, credit));
    this.#send(FrameType.ACK, payload, record);
  }

  #sendCredit(record, credit) {
    const payload = new Uint8Array(8);
    writeUint32LE(payload, 0, Math.min(0xffffffff, credit));
    this.#send(FrameType.CREDIT, payload, record);
  }

  #send(type, payload, record, requestId = 0n, epoch = record?.epoch ?? 0n) {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const frame = encodeFrame({
      type,
      connectionSequence: ++this.#connectionSequence,
      requestId,
      attachmentId: record?.attachmentId ?? 0n,
      attachmentEpoch: epoch,
      sessionId: record?.sessionId ?? ZERO_SESSION_ID,
      payload,
    });
    socket.send(frame);
    this.#state.txWireBytes += frame.byteLength;
    return true;
  }

  #ping() {
    if (!this.#state.connected) return;
    const nonce = this.#nextRequestId();
    const payload = new Uint8Array(8);
    writeUint64LE(payload, 0, nonce);
    this.#rttSent.set(nonce, performance.now());
    this.#send(FrameType.PING, payload, null, nonce);
  }

  #pong(frame) {
    const nonce = readUint64LE(frame.payload, 0);
    if (nonce !== frame.requestId) throw new Error("invalid PONG");
    const started = this.#rttSent.get(nonce);
    if (started === undefined) return;
    this.#rttSent.delete(nonce);
    updateRtt(this.#state, performance.now() - started);
  }

  #flushFrozen(record) {
    if (!record?.frozen.length) return;
    const frozen = record.frozen.splice(0);
    record.frozenBytes = 0;
    for (const event of frozen) this.#applyEvent(record, event.flags, event.payload);
  }

  #socketClose(socket) {
    if (socket !== this.#socket) return;
    this.#socket = null;
    this.#rttSent.clear();
    this.#state.connected = false;
    for (const record of this.#records.values()) {
      resetCheckpointTransaction(record);
      markRecordDetached(record);
    }
    this.#setStatus("disconnected", false);
    if (this.#readyReject) {
      this.#readyReject(new Error("session socket closed during negotiation"));
      this.#readyResolve = null;
      this.#readyReject = null;
    }
    if (!this.#disposed) this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    if (this.#reconnectTimer) return;
    const jitter = 0.8 + Math.random() * 0.4;
    const delay = Math.round(this.#reconnectDelay * jitter);
    this.#reconnectDelay = Math.min(MAX_RECONNECT_MS, this.#reconnectDelay * 2);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = 0;
      this.connect().catch(error => this.#errorEmitter.emit(error));
    }, delay);
  }

  #clearReconnect() {
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = 0;
  }

  #fail(error) {
    this.#errorEmitter.emit(error);
    this.#readyReject?.(error);
    this.#readyReject = null;
    this.#socket?.close();
  }

  #removeRecord(record, error) {
    rememberStaleAttachment(this.#staleAttachmentIds, record);
    record.active = false;
    markRecordDetached(record);
    resetCheckpointTransaction(record);
    this.#records.delete(record.attachmentId.toString());
    record.inputDisposable?.dispose();
    record.reject?.(error);
    record.resolve = null;
    record.reject = null;
    if (this.#activeRecord === record) this.#activeRecord = null;
    this.#state.attachmentCount = this.#records.size;
  }

  #setStatus(status, connected) {
    this.#state.status = status;
    this.#state.connected = connected;
    this.#statusEmitter.emit(status, this.#state);
  }

  #requireRecord(record, frame) {
    if (!record || !record.active || this.#records.get(frame.attachmentId.toString()) !== record || !equalBytes(frame.sessionId, record.sessionId) || (record.epoch === 0n ? frame.type !== FrameType.ATTACH_BEGIN : frame.attachmentEpoch !== record.epoch)) throw new Error("stale attachment frame");
  }

  #nextRequestId() {
    this.#requestSequence = this.#requestSequence === (1n << 64n) - 1n ? 1n : this.#requestSequence + 1n;
    return this.#requestSequence;
  }

  #resolveUrl() {
    if (this.#url) return String(this.#url);
    const url = new URL("/ws", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.href;
  }
}

export { bytesUuid, crc32c, uuidBytes };
