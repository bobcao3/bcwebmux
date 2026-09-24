// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { Decompress } from "./fzstd.js";
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
const MAX_EVENT_RAW_BYTES = 256 * 1024
// Reserve room for every negotiated attachment's already-granted initial
// credit; a legitimate simultaneous replay must not overflow a smaller global
// queue merely because core creation is pending. Negotiation caps this at eight.
const MAX_APPLICATION_BYTES = 8 * INITIAL_CREDIT + MAX_FRAME_LENGTH;
const MAX_APPLICATION_FRAMES = 65536;
const MAX_SEND_QUEUE_BYTES = 256 * 1024;
const CONTROL_RESERVE = 64 * 1024;
// Availability/resource policy, never derived from successful RTT samples.
export const CONNECTION_PROFILE = Object.freeze({
  connectMs: 10000, helloMs: 10000, controlSubmitMs: 5000,
  responseMs: 15000, probeIntervalMs: 1000, hedgeDelayMs: 1000, schedulingGapMs: 5000,
  retryFloorMs: 500, retryCeilingMs: 10000,
});
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const OUTPUT_STREAM_PREAMBLE = new TextEncoder().encode("bcwebmux persistent PTY zstd stream preamble; discard before output\n");

export class SessionTransport {
  #url;
  #webSocketFactory;
  #attempt = null;
  #hedge = null;
  #hedgeAt = 0;
  #hedgeFailures = 0;
  #generation = 0;
  #slots = new Set();
  #desired = false;
  #fatal = null;
  #profile;
  #retryAt = 0;
  #waiters = new Set();
  get #socket() { return this.#attempt?.socket ?? null; }
  #resumeAttachments = false;
  #terminal = null;
  #terminalDisposables = [];
  #records = new Map();
  #staleAttachmentIds = new Set();
  #activeRecord = null;
  #pendingSize = null;
  #requestSequence = randomUint64();
  #inputSequence = randomUint64() & ((1n << 63n) - 1n);
  #clientId;
  #reconnectTimer = 0;
  #failures = 0;
  #clock;
  #window;
  #document;
  #wakeListener;
  #freezeListener;
  #resumeListener;
  #frozen = false;
  #disposed = false;
  #statusEmitter = createEmitter();
  #attachmentEmitter = createEmitter();
  // Actual completion, not cancellation, releases per-supervisor job slots.
  #restoreJobs = { core: { active: 0, waiters: [] }, digest: { active: 0, waiters: [] } };
  #sessionChangedEmitter = createEmitter();
  #errorEmitter = createEmitter();
  #eventScratch = null
  #state = {
    connected: false,
    serverInstance: null,
    status: "idle",
    generation: 0,
    unreleasedSockets: 0,
    retryAt: null,
    lastOutcome: null,
    lastReceiveAt: null,
    lastApplicationAt: null,
    lastRoundTripAt: null,
    negotiationMs: null,
    unmatchedPongs: 0,
    latePongs: 0,
    suspensionCount: 0,
    suspended: false,
    queuedApplicationBytes: 0,
    queuedSendBytes: 0,
    bufferedAmount: 0,
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
    this.#clock = options.clock ?? { now: () => performance.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) };
    this.#profile = Object.freeze({ ...CONNECTION_PROFILE, ...options.profile });
    for (const value of Object.values(this.#profile)) {
      if (!Number.isFinite(value) || value <= 0) throw new TypeError("connection profile windows must be finite and positive");
    }
    if (this.#profile.retryFloorMs > this.#profile.retryCeilingMs) throw new TypeError("invalid retry backoff range");
    this.#window = options.window ?? globalThis.window;
    this.#document = options.document ?? globalThis.document;
    this.#wakeListener = () => this.#wake();
    this.#freezeListener = () => { this.#frozen = true; this.#suspend(this.#attempt); };
    this.#resumeListener = () => { this.#frozen = false; this.#wake(); };
    this.#window?.addEventListener?.("online", this.#wakeListener);
    this.#document?.addEventListener?.("visibilitychange", this.#wakeListener);
    this.#document?.addEventListener?.("freeze", this.#freezeListener);
    this.#document?.addEventListener?.("resume", this.#resumeListener);
  }

  configureServer(info) {
    this.#resumeAttachments = info?.capabilities?.attachmentResume === true;
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

  // Caller operations survive attempts. onError alone reports fatal connection failure.
  connect(options = {}) {
    if (this.#disposed) return Promise.reject(new Error("session transport is disposed"));
    if (this.#fatal) return Promise.reject(this.#fatal);
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) return Promise.reject(new TypeError("timeoutMs must be finite and positive"));
    this.#desired = true;
    if (this.#state.connected) return Promise.resolve(this);
    const promise = new Promise((resolve, reject) => {
      const waiter = { settle: (error, failed = error !== undefined) => {
        if (!this.#waiters.delete(waiter)) return;
        this.#clock.clearTimeout(waiter.timer);
        options.signal?.removeEventListener("abort", cancel);
        if (failed) reject(error); else resolve(this);
      } };
      const cancel = () => waiter.settle(options.signal.reason, true);
      this.#waiters.add(waiter);
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.timeoutMs !== undefined) waiter.timer = this.#clock.setTimeout(() => waiter.settle(new Error("connection operation deadline exceeded")), options.timeoutMs);
    });
    this.#admit();
    return promise;
  }

  #settleReady(error) { for (const waiter of [...this.#waiters]) waiter.settle(error); }

  #admit() {
    if (this.#attempt || this.#hedge || !this.#desired || this.#disposed || this.#fatal) return;
    for (const slot of this.#slots) if (slot.socket?.readyState === 3) this.#releaseSlot(slot);
    if (this.#clock.now() < this.#retryAt) return this.#scheduleAdmission();
    if (this.#slots.size >= 2) return this.#setStatus("resource-wait", false);
    this.#clearReconnect();
    this.#state.retryAt = null;
    // Reserve before construction; logical retirement never releases this slot.
    const slot = { socket: null, released: false };
    this.#slots.add(slot);
    this.#state.unreleasedSockets = this.#slots.size;
    const now = this.#clock.now();
    const attempt = {
      generation: ++this.#generation, socket: null, slot, retired: false,
      phase: "connecting", phaseStarted: now, lastTick: now, timer: 0,
      suspended: this.#frozen || !!this.#document?.hidden, helloRequestId: 0n,
      sendSequence: 0n, serverSequence: 0n, probe: null, nextProbeAt: Infinity,
      controls: [], sends: [], sendBytes: 0, controlBytes: 0,
      queue: [], queueHead: 0, queueBytes: 0, draining: false, appTimer: 0,
      healthy: false, readyAt: null, maxAttachments: 8,
      canceledAttaches: new Map(),
      cancel: new AbortController(),
    };
    this.#attempt = attempt;
    this.#state.generation = attempt.generation;
    this.#state.suspended = attempt.suspended;
    this.#setStatus("connecting", false);
    try {
      attempt.socket = slot.socket = this.#webSocketFactory(this.#resolveUrl(), SUBPROTOCOL);
      this.#listenSocket(attempt);
      this.#armTick(attempt);
    } catch (error) {
      if (!slot.socket) this.#releaseSlot(slot);
      this.#retire(attempt, error, "socket-construction");
    }
  }

  #startHedge(attempt) {
    const now = this.#clock.now();
    if (!this.#current(attempt) || attempt.phase !== "ready" || this.#hedge || now < this.#hedgeAt || this.#slots.size >= 2 || this.#disposed || this.#fatal) return;
    const slot = { socket: null, released: false };
    this.#slots.add(slot);
    this.#state.unreleasedSockets = this.#slots.size;
    const hedge = {
      generation: ++this.#generation, socket: null, slot, retired: false,
      phase: "connecting", phaseStarted: now, lastTick: now, timer: 0,
      suspended: false, helloRequestId: 0n, sendSequence: 0n, serverSequence: 0n,
      probe: null, nextProbeAt: Infinity, controls: [], sends: [], sendBytes: 0,
      controlBytes: 0, queue: [], queueHead: 0, queueBytes: 0, draining: false,
      appTimer: 0, healthy: false, readyAt: null, maxAttachments: 8,
      canceledAttaches: new Map(), cancel: new AbortController(),
    };
    this.#hedge = hedge;
    this.#setStatus("hedging-connect", true);
    try {
      hedge.socket = slot.socket = this.#webSocketFactory(this.#resolveUrl(), SUBPROTOCOL);
      this.#listenHedge(hedge);
      this.#armHedge(hedge);
    } catch (error) {
      if (!slot.socket) this.#releaseSlot(slot);
      this.#cancelHedge(hedge, true);
    }
  }

  #listenHedge(hedge) {
    const socket = hedge.socket;
    socket.binaryType = "arraybuffer";
    const open = () => {
      if (this.#hedge !== hedge || hedge.retired) return;
      hedge.phase = "negotiating";
      hedge.phaseStarted = this.#clock.now();
      this.#setStatus("hedging-negotiate", true);
      const payload = new Uint8Array(56);
      payload.set(this.#clientId, 0);
      payload.set(ABI_DIGEST, 16);
      writeUint32LE(payload, 48, INITIAL_CREDIT);
      writeUint32LE(payload, 52, MAX_FRAME_LENGTH);
      hedge.helloRequestId = this.#nextRequestId();
      const frame = encodeFrame({ type: FrameType.HELLO, payload, requestId: hedge.helloRequestId,
        attachmentId: 0n, attachmentEpoch: 0n, sessionId: ZERO_SESSION_ID,
        connectionSequence: ++hedge.sendSequence });
      try {
        socket.send(frame);
        this.#state.txWireBytes += frame.byteLength;
      } catch {
        this.#cancelHedge(hedge, true);
      }
    };
    const message = event => {
      if (this.#hedge !== hedge || hedge.retired || hedge.phase !== "negotiating") return;
      try {
        const bytes = new Uint8Array(event.data);
        const frame = decodeFrame(bytes);
        if (frame.connectionSequence !== hedge.serverSequence + 1n) throw new Error("server connection sequence gap");
        hedge.serverSequence = frame.connectionSequence;
        this.#state.rxWireBytes += bytes.byteLength;
        this.#validateWelcome(hedge, frame);
        this.#promoteHedge(hedge, frame);
      } catch {
        this.#cancelHedge(hedge, true);
      }
    };
    const error = () => this.#cancelHedge(hedge, true);
    socket.addEventListener("open", open);
    socket.addEventListener("message", message);
    socket.addEventListener("error", error);
    hedge.unlisten = () => {
      socket.removeEventListener("open", open);
      socket.removeEventListener("message", message);
      socket.removeEventListener("error", error);
    };
    const close = () => {
      socket.removeEventListener("close", close);
      hedge.unlistenClose = null;
      this.#releaseSlot(hedge.slot);
      if (this.#hedge === hedge) this.#cancelHedge(hedge, true);
    };
    socket.addEventListener("close", close);
    hedge.unlistenClose = () => socket.removeEventListener("close", close);
  }

  #armHedge(hedge) {
    if (this.#hedge !== hedge || hedge.retired) return;
    this.#clock.clearTimeout(hedge.timer);
    const limit = hedge.phase === "connecting" ? this.#profile.connectMs : this.#profile.helloMs;
    hedge.timer = this.#clock.setTimeout(() => {
      if (this.#hedge !== hedge || hedge.retired) return;
      if (this.#clock.now() - hedge.phaseStarted >= limit) this.#cancelHedge(hedge, true);
      else this.#armHedge(hedge);
    }, Math.max(1, hedge.phaseStarted + limit - this.#clock.now()));
  }

  #cancelHedge(hedge, failed = false) {
    if (!hedge || hedge.retired) return;
    hedge.retired = true;
    if (this.#hedge === hedge) this.#hedge = null;
    this.#clock.clearTimeout(hedge.timer);
    hedge.unlisten?.();
    hedge.unlisten = null;
    if (failed) {
      const delay = Math.min(this.#profile.retryCeilingMs, this.#profile.retryFloorMs * 2 ** Math.min(this.#hedgeFailures++, 16));
      this.#hedgeAt = this.#clock.now() + delay;
      if (this.#attempt) this.#setStatus("suspect", true);
    } else {
      this.#hedgeAt = 0;
      this.#hedgeFailures = 0;
    }
    if (hedge.socket?.readyState === 3) {
      hedge.unlistenClose?.();
      hedge.unlistenClose = null;
      this.#releaseSlot(hedge.slot);
    }
    else { try { hedge.socket?.close(); } catch {} }
    if (!this.#attempt && !this.#disposed && !this.#fatal) this.#scheduleAdmission();
  }

  #promoteHedge(hedge, frame) {
    if (this.#hedge !== hedge || hedge.retired) return;
    const old = this.#attempt;
    this.#hedge = null;
    this.#clock.clearTimeout(hedge.timer);
    hedge.unlisten?.();
    hedge.unlisten = null;
    hedge.unlistenClose?.();
    hedge.unlistenClose = null;
    hedge.phase = "ready";
    hedge.helloRequestId = 0n;
    hedge.maxAttachments = readUint16LE(frame.payload, 68);
    hedge.nextProbeAt = this.#clock.now();
    this.#attempt = hedge;
    this.#state.generation = hedge.generation;
    this.#state.negotiationMs = this.#clock.now() - hedge.phaseStarted;
    this.#state.queuedApplicationBytes = 0;
    this.#state.queuedSendBytes = 0;
    this.#state.bufferedAmount = hedge.socket.bufferedAmount;
    this.#listenSocket(hedge);
    for (const record of this.#records.values()) {
      resetCheckpointTransaction(record);
    }
    this.#bindRecords(hedge);
    this.#setStatus("roaming", true);
    this.#settleReady();
    this.#hedgeAt = 0;
    this.#hedgeFailures = 0;
    if (old && old !== hedge) this.#closeSuperseded(old);
    this.#ping();
  }

  #closeSuperseded(attempt) {
    attempt.retired = true;
    this.#clock.clearTimeout(attempt.timer);
    this.#clock.clearTimeout(attempt.appTimer);
    attempt.unlisten?.();
    attempt.unlisten = null;
    attempt.cancel.abort();
    attempt.queue.length = 0;
    attempt.controls.length = 0;
    attempt.sends.length = 0;
    attempt.canceledAttaches.clear();
    if (attempt.socket?.readyState === 3) this.#releaseSlot(attempt.slot);
    else { try { attempt.socket?.close(); } catch {} }
  }

  async attach(metadata, core, options = {}) {
    if (!metadata?.id || !metadata?.generation || !core) throw new TypeError("attach requires session metadata and core");
    do { await this.connect({ signal: options.signal }); } while (!this.#state.connected);
    if (options.signal?.aborted) throw options.signal.reason;
    if (this.#fatal) throw this.#fatal;
    if (this.#disposed) throw new Error("session transport disposed");
    if (this.#records.size >= this.#attempt.maxAttachments) throw new Error("connection attachment limit reached");
    if (this.#records.size + this.#attempt.canceledAttaches.size >= 64) throw new Error("pending attachment cleanup limit reached");
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
      attempt: this.#attempt,
      restoreJobs: this.#restoreJobs,
      restoreCancel: new AbortController(),
      cleanupAbort: null,
      state: "attaching",
      live: false,
      bindingLive: false,
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
      outputDecoder: null,
      outputDecodeTarget: null,
      outputDecodeOffset: 0,
      outputPreambleOffset: 0,
      claim: options.claim !== false,
      preserveCore: options.preserveCore !== false,
      resolve: null,
      reject: null,
      promise: null,
    };
    record.promise = new Promise((resolve, reject) => { record.resolve = resolve; record.reject = reject; });
    this.#records.set(record.attachmentId.toString(), record);
    this.#state.attachmentCount = this.#records.size;
    if (options.signal) {
      const abort = () => {
        if (!record.active || !record.reject) return;
        if (record.epoch) this.#send(FrameType.DETACH, new Uint8Array(0), record, this.#nextRequestId());
        this.#removeRecord(record, options.signal.reason);
      };
      record.cleanupAbort = () => { options.signal.removeEventListener("abort", abort); record.cleanupAbort = null; };
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) abort();
    }
    if (!record.active) return record.promise;
    this.#sendAttach(record);
    return record.promise;
  }

  setActive(record) {
    const changed = this.#activeRecord !== record;
    if (record && !this.#records.has(record.attachmentId.toString())) throw new Error("attachment is not owned by this transport");
    if (this.#activeRecord !== record && this.#terminal?.selectionMode) this.#terminal.exitSelectionMode({ restoreFocus: false });
    this.#flushFrozen(this.#activeRecord);
    this.#activeRecord = record;
    if (record?.live && this.#terminal && this.#terminal.core !== record.core) this.#terminal.attachCore(record.core);
    if (record?.live && record.claim && !record.controller) this.claimControl(record);
    if (changed) this.#attachmentEmitter.emit(record, "active");
  }

  claimControl(record = this.#activeRecord) {
    if (!record?.bindingLive) return false;
    this.#send(FrameType.CLAIM_CONTROL, new Uint8Array(0), record, this.#nextRequestId());
    return true;
  }

  detach(record) {
    if (!record) return;
    if (record.epoch) this.#send(FrameType.DETACH, new Uint8Array(0), record, this.#nextRequestId());
    this.#removeRecord(record, new Error("attachment detached"));
  }

  onStatus(listener) { return this.#statusEmitter.event(listener); }
  onAttachmentChanged(listener) { return this.#attachmentEmitter.event(listener); }
  onSessionChanged(listener) { return this.#sessionChangedEmitter.event(listener); }
  onError(listener) { return this.#errorEmitter.event(listener); }
  get state() { return this.#state; }
  get activeAttachment() { return this.#activeRecord; }
  get clientInstanceId() { return bytesUuid(this.#clientId); }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#desired = false;
    this.#clearReconnect();
    this.#cancelHedge(this.#hedge);
    this.#retire(this.#attempt, new Error("session transport disposed"), "disposed");
    this.#window?.removeEventListener?.("online", this.#wakeListener);
    this.#document?.removeEventListener?.("visibilitychange", this.#wakeListener);
    this.#document?.removeEventListener?.("freeze", this.#freezeListener);
    this.#document?.removeEventListener?.("resume", this.#resumeListener);
    this.#settleReady(new Error("session transport disposed"));
    for (const disposable of this.#terminalDisposables.splice(0)) disposable.dispose?.();
    for (const record of [...this.#records.values()]) this.#removeRecord(record, new Error("session transport disposed"));
    this.#eventScratch = null
    this.#setStatus("disposed", false);
    this.#statusEmitter.clear();
    this.#attachmentEmitter.clear();
    this.#sessionChangedEmitter.clear();
    this.#errorEmitter.clear();
  }

  #socketOpen(attempt) {
    if (!this.#current(attempt) || attempt.phase !== "connecting") return;
    attempt.phase = "negotiating";
    attempt.phaseStarted = this.#clock.now();
    attempt.helloSuspended = attempt.suspended || !!this.#document?.hidden;
    this.#staleAttachmentIds.clear();
    this.#setStatus("negotiating", false);
    const payload = new Uint8Array(56);
    payload.set(this.#clientId, 0);
    payload.set(ABI_DIGEST, 16);
    writeUint32LE(payload, 48, INITIAL_CREDIT);
    writeUint32LE(payload, 52, MAX_FRAME_LENGTH);
    attempt.helloRequestId = this.#nextRequestId();
    this.#send(FrameType.HELLO, payload, null, attempt.helloRequestId);
    if (!this.#current(attempt)) return;
    this.#bindRecords(attempt);
  }

  #bindRecords(attempt) {
    const records = [...this.#records.values()];
    this.#records.clear();
    for (const record of records) {
      // Explicit attachment-resume capability is required because older servers
      // identify the controller by attachment ID but do not fence cross-connection ID reuse.
      if (!this.#resumeAttachments) record.attachmentId = randomUint64();
      record.epoch = 0n;
      record.bindingLive = false;
      record.state = "attaching";
      record.attempt = attempt;
      this.#records.set(record.attachmentId.toString(), record);
    }
    for (const record of records) {
      if (!this.#current(attempt)) break;
      this.#sendAttach(record);
    }
  }

  #socketMessage(attempt, event) {
    if (!this.#current(attempt)) return;
    const bytes = new Uint8Array(event.data);
    this.#state.rxWireBytes += bytes.byteLength;
    const frame = decodeFrame(bytes);
    if (frame.connectionSequence !== attempt.serverSequence + 1n) throw new Error("server connection sequence gap");
    attempt.serverSequence = frame.connectionSequence;
    this.#state.lastReceiveAt = this.#clock.now();
    // Connection controls and fully validated terminal evidence cannot wait for
    // core creation/digest. No application cursors or ACKs are advanced here.
    if (frame.type === FrameType.ERROR && isConnectionFrame(frame)) {
      const error = this.#validateError(null, frame);
      if (frame.requestId !== 0n && frame.requestId !== attempt.helloRequestId && frame.requestId !== attempt.probe?.nonce) throw new Error("invalid connection ERROR context");
      if (error.fatal) return this.#fail(error, attempt.socket);
    }
    if (frame.type === FrameType.WELCOME) {
      this.#welcome(frame);
      this.#state.lastReceiveAt = this.#clock.now();
      return;
    }
    if (attempt.phase !== "ready" && frame.type !== FrameType.ERROR) throw new Error("WELCOME required before session frames");
    if (frame.type === FrameType.PONG) {
      if (!isConnectionFrame(frame) || frame.requestId === 0n || frame.payload.byteLength !== 8) throw new Error("invalid PONG");
      this.#pong(frame);
      this.#state.lastReceiveAt = this.#clock.now();
      return;
    }
    if (frame.type === FrameType.PING) {
      if (!isConnectionFrame(frame) || frame.requestId !== 0n || frame.payload.byteLength !== 8) throw new Error("invalid PING");
      this.#state.lastReceiveAt = this.#clock.now();
      this.#send(FrameType.PONG, frame.payload, null);
      return;
    }
    if (attempt.queueBytes + bytes.byteLength > this.#applicationBudget() || attempt.queue.length - attempt.queueHead >= MAX_APPLICATION_FRAMES) {
      return this.#retire(attempt, new Error("application receive queue limit exceeded"), "receive-overload");
    }
    attempt.queue.push({ frame, bytes: bytes.byteLength });
    attempt.queueBytes += bytes.byteLength;
    this.#state.queuedApplicationBytes = attempt.queueBytes;
    this.#drainApplication(attempt);
  }

  async #drainApplication(attempt) {
    if (attempt.draining || attempt.appTimer) return;
    attempt.draining = true;
    try {
      for (let count = 0; this.#current(attempt) && attempt.queueHead < attempt.queue.length && count < 32; count++) {
        // Keep the executing item accounted until its application completes.
        const item = attempt.queue[attempt.queueHead];
        await this.#applyFrame(attempt.socket, item.frame);
        if (!this.#current(attempt)) return;
        attempt.queue[attempt.queueHead++] = null;
        attempt.queueBytes -= item.bytes;
        this.#state.queuedApplicationBytes = attempt.queueBytes;
        this.#state.lastApplicationAt = this.#clock.now();
        this.#flushCredits();
      }
      if (this.#current(attempt)) {
        if (attempt.queueHead) {
          attempt.queue.splice(0, attempt.queueHead);
          attempt.queueHead = 0;
        }
        if (attempt.queue.length) {
          // Yield a task, not a microtask, so controls can dispatch during replay.
          attempt.appTimer = this.#clock.setTimeout(() => {
            attempt.appTimer = 0;
            if (this.#current(attempt)) this.#drainApplication(attempt);
          }, 0);
        }
      }
    } catch (error) {
      this.#fail(error, attempt.socket);
    } finally { attempt.draining = false; }
  }

  async #applyFrame(socket, frame) {
    if (socket !== this.#socket || this.#disposed) return;
    if (!this.#state.connected && frame.type === FrameType.ERROR) return this.#protocolError(null, frame);
    if (!this.#state.connected) throw new Error("WELCOME required before session frames");
    const record = frame.attachmentId ? this.#records.get(frame.attachmentId.toString()) : null;
    if (frame.attachmentId && !record && this.#staleAttachmentIds.has(frame.attachmentId.toString())) {
      const canceled = this.#attempt.canceledAttaches.get(frame.attachmentId.toString());
      if (canceled && frame.type === FrameType.ATTACH_BEGIN) {
        if (!equalBytes(frame.sessionId, canceled.sessionId) || frame.requestId !== canceled.attachRequestId || frame.attachmentEpoch === 0n || frame.payload.byteLength !== 80 || frame.payload[16] > 2 || frame.payload[18] !== 0 || frame.payload[19] !== 0 || frame.payload.subarray(36, 48).some(byte => byte !== 0)) throw new Error("invalid canceled ATTACH_BEGIN");
        canceled.epoch = frame.attachmentEpoch;
        this.#send(FrameType.DETACH, new Uint8Array(0), canceled, this.#nextRequestId());
        this.#attempt?.canceledAttaches.delete(frame.attachmentId.toString());
      } else if (canceled && frame.type === FrameType.ERROR) this.#attempt.canceledAttaches.delete(frame.attachmentId.toString());
      return;
    }
    switch (frame.type) {
      case FrameType.ATTACH_BEGIN: return this.#attachBegin(record, frame, socket);
      case FrameType.CHECKPOINT_BEGIN: return this.#checkpointBegin(record, frame);
      case FrameType.CHECKPOINT_CHUNK: return this.#checkpointChunk(record, frame);
      case FrameType.CHECKPOINT_END: return this.#checkpointEnd(record, frame, socket);
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
      case FrameType.ERROR: return this.#protocolError(record, frame);
      default: throw new Error(`unexpected server frame ${frame.type}`);
    }
  }

  #welcome(frame) {
    const attempt = this.#attempt;
    this.#validateWelcome(attempt, frame);
    attempt.helloRequestId = 0n;
    attempt.phase = "ready";
    attempt.maxAttachments = readUint16LE(frame.payload, 68);
    this.#state.negotiationMs = attempt.helloSuspended || this.#document?.hidden ? null : this.#clock.now() - attempt.phaseStarted;
    this.#state.serverInstance = bytesUuid(frame.payload.subarray(0, 16));
    this.#setStatus("ready", true);
    this.#state.retryAt = null;
    this.#settleReady();
    this.#markHealthy();
    this.#ping();
  }

  #validateWelcome(attempt, frame) {
    if (attempt.phase !== "negotiating" || frame.type !== FrameType.WELCOME || frame.payload.byteLength !== 88 || !isConnectionFrame(frame) || attempt.helloRequestId === 0n || frame.requestId !== attempt.helloRequestId) throw new Error("invalid WELCOME");
    if (!equalBytes(frame.payload.subarray(16, 48), ABI_DIGEST)) throw new Error("terminal ABI mismatch; reload/update required");
    if (!validWelcomeCapabilities(frame.payload, MAX_FRAME_LENGTH, INITIAL_CREDIT)) throw new Error("invalid WELCOME capabilities");
  }

  async #attachBegin(record, frame, socket) {
    this.#requireRecord(record, frame);
    if (frame.payload.byteLength !== 80 || frame.attachmentEpoch === 0n || record.attachRequestId === 0n || frame.requestId !== record.attachRequestId || frame.payload[18] !== 0 || frame.payload[19] !== 0 || frame.payload.subarray(36, 48).some(byte => byte !== 0)) throw new Error("invalid ATTACH_BEGIN");
    acceptAttachmentEpoch(record, frame);
    this.#resetOutputDecoder(record);
    const previousGeneration = record.generation;
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
    const replayMutatesCore = mode === 1 || (mode === 0 && (record.eventSeq !== 0n || record.outputOffset !== 0n))
    if (record.preserveCore && replayMutatesCore) {
      if (this.#terminal) record.restoreGeneration = previousGeneration;
      try {
        if (!await ensureShadow(this.#terminal, this.#records, record, data => this.#sendInput(record, data))) return;
      } catch (error) {
        if (socket === this.#socket && !this.#disposed) {
          this.#send(FrameType.DETACH, new Uint8Array(0), record, this.#nextRequestId());
          this.#failAttachment(record, error);
        }
        return;
      }
    }
    if (socket !== this.#socket || this.#disposed) return;
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
    if (record.active && this.#current(record.attempt)) this.#attachmentEmitter.emit(record, "attaching");
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

  async #checkpointEnd(record, frame, socket) {
    this.#requireRecord(record, frame);
    let restored;
    try {
      restored = await finishCheckpoint(record, frame);
    } catch (error) {
      if (!error.checkpointOperation) throw error;
      if (socket === this.#socket && !this.#disposed) {
        this.#send(FrameType.DETACH, new Uint8Array(0), record, this.#nextRequestId());
        this.#failAttachment(record, error);
      }
      return;
    }
    if (socket !== this.#socket || this.#disposed) return;
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
      if (flags !== COMPRESSED_FLAG) throw new Error("output event is not stream-compressed");
      if (rawLength > MAX_EVENT_RAW_BYTES) throw new Error("output event is too large");
      const raw = this.#decodeOutput(record, body, rawLength);
      if (crc32c(raw) !== crc) throw new Error("corrupt output event");
      if (record === this.#activeRecord && this.#terminal?.core === record.core) this.#terminal.write(raw);
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
    // Return exactly the native charge, not a little extra on every frame.
    this.#sendAck(record, kind === 0 ? rawLength + 96 : 128);
    if (kind !== 0 && record.active && this.#current(record.attempt)) this.#attachmentEmitter.emit(record, kind === 1 ? "resize" : "exit");
  }

  #live(record, frame) {
    this.#requireRecord(record, frame);
    if (frame.payload.byteLength !== 16) throw new Error("invalid LIVE_BARRIER");
    const eventSeq = readUint64LE(frame.payload, 0);
    const outputOffset = readUint64LE(frame.payload, 8);
    if (eventSeq !== record.eventSeq || outputOffset !== record.outputOffset) throw new Error("live barrier cursor mismatch");
    record.core.setReplayMode(false);
    if (record.previousCore && (record.previousWasHostActive || record === this.#activeRecord)) this.#terminal.attachCore(record.core);
    record.previousInputDisposable?.dispose();
    record.previousCore?.dispose?.();
    record.previousInputDisposable = null;
    record.previousCore = null;
    record.previousWasHostActive = false;
    record.previousCursor = null;
    record.restoreGeneration = null;
    record.preserveCore = true
    // Replay already returns its consumed credit as it is applied. A second
    // initial grant here would exceed the receive capacity reserved at ATTACH.
    if (!this.#sendAck(record, 0)) return;
    record.bindingLive = true;
    record.live = true;
    record.state = "live";
    record.cleanupAbort?.();
    record.resolve?.(record);
    record.resolve = null;
    record.reject = null;
    if (record === this.#activeRecord && record.claim && !record.controller) this.claimControl(record);
    if (record === this.#activeRecord && record.controller && this.#pendingSize) this.#sendResize(this.#pendingSize);
    this.#markHealthy();
    if (record.active && record.live) this.#attachmentEmitter.emit(record, "live");
  }

  #lease(record, frame) {
    this.#requireRecord(record, frame);
    if (frame.payload.byteLength !== 24) throw new Error("invalid LEASE_CHANGED");
    record.leaseEpoch = readUint64LE(frame.payload, 0);
    record.controller = readUint64LE(frame.payload, 8) === record.attachmentId;
    record.metadata.geometry = readGeometry(frame.payload, 16);
    if (record === this.#activeRecord && record.controller && this.#pendingSize) this.#sendResize(this.#pendingSize);
    this.#markHealthy();
    if (record.active && this.#current(record.attempt)) this.#attachmentEmitter.emit(record, "lease");
  }

  #canonicalResize(record, frame) {
    this.#requireRecord(record, frame);
    if (frame.payload.byteLength !== 24) throw new Error("invalid CANONICAL_RESIZE");
    record.leaseEpoch = readUint64LE(frame.payload, 0);
    record.metadata.geometry = readGeometry(frame.payload, 16);
    this.#attachmentEmitter.emit(record, "resize");
  }

  #inputAck(record, frame) {
    this.#requireRecord(record, frame);
    if (frame.payload.byteLength !== 12) throw new Error("invalid INPUT_ACK");
    const status = readUint16LE(frame.payload, 8);
    const controller = record.controller;
    handleInputStatus(record, status, error => this.#errorEmitter.emit(error));
    if (controller !== record.controller) this.#attachmentEmitter.emit(record, "controller");
  }

  #resync(record) {
    if (!record) return;
    this.#cancelRecordSends(record);
    resetCheckpointTransaction(record);
    markRecordDetached(record);
    record.bindingLive = false;
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
    if (record.active && this.#current(record.attempt)) this.#attachmentEmitter.emit(record, "resync");
  }

  #exited(record, frame) {
    this.#requireRecord(record, frame);
    if (frame.payload.byteLength !== 20) throw new Error("invalid EXITED");
    record.metadata.state = "exited";
    record.metadata.exitStatus = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength).getInt32(8, true);
    this.#attachmentEmitter.emit(record, "exit");
  }

  #validateError(record, frame) {
    if (frame.payload.byteLength < 4 || (!record && !isConnectionFrame(frame)) || (record && !equalBytes(frame.sessionId, record.sessionId)) || (record && record.epoch !== 0n && frame.attachmentEpoch !== record.epoch) || (record && !record.bindingLive && record.attachRequestId !== 0n && frame.requestId !== record.attachRequestId)) throw new Error("invalid ERROR");
    const code = readUint16LE(frame.payload, 0), fatal = readUint16LE(frame.payload, 2);
    if (code < 1 || code > 11 || fatal > 1) throw new Error("invalid ERROR payload");
    const detail = textDecoder.decode(frame.payload.subarray(4));
    const error = new Error(detail || `session protocol error ${code}`);
    error.fatal = fatal === 1;
    return error;
  }

  #protocolError(record, frame) {
    const error = this.#validateError(record, frame);
    if (error.fatal) return this.#fail(error);
    if (record) {
      if (!record.bindingLive) {
        this.#failAttachment(record, error);
      } else {
        rollbackShadow(record);
        this.#errorEmitter.emit(error);
      }
    } else this.#errorEmitter.emit(error);
  }

  #sendAttach(record) {
    record.attempt = this.#attempt;
    record.attachSubmitted = false;
    if (this.#attempt) this.#attempt.readyAt = null;
    record.pendingCredit = 0;
    const payload = new Uint8Array(40);
    payload.set(record.generation, 0);
    writeUint64LE(payload, 16, record.eventSeq);
    writeUint64LE(payload, 24, record.outputOffset);
    writeUint32LE(payload, 32, INITIAL_CREDIT);
    this.#send(FrameType.ATTACH, payload, record, (record.attachRequestId = this.#nextRequestId()), 0n);
  }

  #sendInput(record, data) {
    if (!record.bindingLive || !record.controller || record.attempt !== this.#attempt || data.byteLength === 0) return;
    if (data.byteLength + 88 > MAX_FRAME_LENGTH || this.#attempt?.sends.length || this.#attempt?.controls.length || this.#socket?.bufferedAmount + data.byteLength + 88 > MAX_BUFFERED_AMOUNT - CONTROL_RESERVE) {
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
    if (!record?.bindingLive || !record.controller) return;
    const cellWidthPx = Math.max(1, Math.round(this.#terminal.state.physicalCellWidth || 8));
    const cellHeightPx = Math.max(1, Math.round(this.#terminal.state.physicalCellHeight || 16));
    const geometry = record.metadata.geometry;
    if (geometry?.cols === size.cols && geometry?.rows === size.rows && geometry?.cellWidthPx === cellWidthPx && geometry?.cellHeightPx === cellHeightPx) return;
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
    writeUint32LE(payload, 16, this.#admitCredit(record, credit));
    return this.#send(FrameType.ACK, payload, record);
  }

  #sendCredit(record, credit) {
    credit = this.#admitCredit(record, credit);
    if (!credit) return;
    const payload = new Uint8Array(8);
    writeUint32LE(payload, 0, Math.min(0xffffffff, credit));
    this.#send(FrameType.CREDIT, payload, record);
  }

  #admitCredit(record, credit) {
    const pending = Math.min(INITIAL_CREDIT, (record.pendingCredit ?? 0) + credit);
    if (this.#attempt?.queueBytes > this.#applicationBudget() / 2) {
      record.pendingCredit = pending;
      return 0;
    }
    record.pendingCredit = 0;
    return pending;
  }

  #flushCredits() {
    if (this.#attempt?.queueBytes > this.#applicationBudget() / 2) return;
    for (const record of this.#records.values()) if (record.pendingCredit && record.epoch) this.#sendCredit(record, 0);
  }

  #applicationBudget() {
    return Math.min(MAX_APPLICATION_BYTES, INITIAL_CREDIT * (this.#attempt?.maxAttachments ?? 8) + MAX_FRAME_LENGTH);
  }

  #send(type, payload, record, requestId = 0n, epoch = record?.epoch ?? 0n) {
    const attempt = this.#attempt;
    if (!this.#current(attempt) || attempt.socket.readyState !== 1 || (record && (!record.active || record.attempt !== attempt))) return false;
    const control = type === FrameType.HELLO || type === FrameType.PING || type === FrameType.PONG;
    const item = { type, payload, requestId, attachmentId: record?.attachmentId ?? 0n,
      attachmentEpoch: epoch, sessionId: record?.sessionId ?? ZERO_SESSION_ID,
      bytes: 64 + payload.byteLength, created: this.#clock.now() };
    const limit = control ? MAX_BUFFERED_AMOUNT : MAX_BUFFERED_AMOUNT - CONTROL_RESERVE;
    if (!(control ? attempt.controls.length : attempt.controls.length + attempt.sends.length) && attempt.socket.bufferedAmount + item.bytes <= limit) return this.#submit(attempt, item);
    // Never retain input whose delivery would be uncertain across retirement.
    if (type === FrameType.INPUT) return false;
    if ((control ? attempt.controlBytes : attempt.sendBytes) + item.bytes > (control ? CONTROL_RESERVE : MAX_SEND_QUEUE_BYTES)) {
      this.#retire(attempt, new Error("outbound queue limit exceeded"), "send-overload");
      return false;
    }
    (control ? attempt.controls : attempt.sends).push(item);
    if (control) attempt.controlBytes += item.bytes; else attempt.sendBytes += item.bytes;
    this.#state.queuedSendBytes = attempt.controlBytes + attempt.sendBytes;
    return true;
  }

  #submit(attempt, item) {
    if (!this.#current(attempt) || attempt.socket.readyState !== 1) return false;
    // Sequence assignment belongs to submission, after bounded admission and
    // control prioritization. Already-submitted WebSocket bytes never reorder.
    const frame = encodeFrame({
      ...item, connectionSequence: ++attempt.sendSequence,
    });
    try {
      attempt.socket.send(frame);
    } catch (error) {
      this.#retire(attempt, error, "socket-io");
      return false;
    }
    if (item.type === FrameType.PING && attempt.probe?.nonce === item.requestId) attempt.probe.submitted = this.#clock.now();
    if (item.type === FrameType.ATTACH) {
      const record = this.#records.get(item.attachmentId.toString());
      if (record?.attachRequestId === item.requestId) record.attachSubmitted = true;
    }
    this.#state.txWireBytes += frame.byteLength;
    return true;
  }

  #drainSends(attempt) {
    for (const control of [true, false]) {
      const queue = control ? attempt.controls : attempt.sends;
      const limit = control ? MAX_BUFFERED_AMOUNT : MAX_BUFFERED_AMOUNT - CONTROL_RESERVE;
      // Bound synchronous dispatch as well as bytes retained.
      for (let count = 0; this.#current(attempt) && queue.length && count < 128; count++) {
        const item = queue[0];
        if (attempt.socket.bufferedAmount + item.bytes > limit) break;
        queue.shift();
        if (control) attempt.controlBytes -= item.bytes; else attempt.sendBytes -= item.bytes;
        if (!this.#submit(attempt, item)) return;
      }
      if (attempt.controls.length) break;
    }
    if (this.#current(attempt)) this.#state.queuedSendBytes = attempt.controlBytes + attempt.sendBytes;
  }

  #ping() {
    const attempt = this.#attempt;
    if (!this.#state.connected || attempt.probe || attempt.suspended || this.#document?.hidden) return;
    const nonce = this.#nextRequestId();
    const payload = new Uint8Array(8);
    writeUint64LE(payload, 0, nonce);
    attempt.probe = { nonce, created: this.#clock.now(), submitted: null, suspect: false };
    this.#send(FrameType.PING, payload, null, nonce);
  }

  #pong(frame) {
    const nonce = readUint64LE(frame.payload, 0);
    if (nonce !== frame.requestId) throw new Error("invalid PONG");
    const attempt = this.#attempt;
    this.#observeExecution(attempt);
    const pending = attempt.probe;
    if (!pending || pending.nonce !== nonce || pending.submitted === null || attempt.suspended || this.#document?.hidden) {
      this.#state.unmatchedPongs++;
      return;
    }
    const now = this.#clock.now(), elapsed = now - pending.submitted;
    if (pending.suspect || elapsed >= this.#profile.hedgeDelayMs) this.#state.latePongs++;
    this.#sampleRtt(elapsed);
    this.#state.lastRoundTripAt = now;
    attempt.probe = null;
    attempt.nextProbeAt = now + this.#profile.probeIntervalMs;
    this.#cancelHedge(this.#hedge);
    this.#setStatus("ready", true);
    if (attempt.readyAt !== null && pending.created >= attempt.readyAt) {
      attempt.healthy = true;
      this.#failures = 0;
    }
  }

  #sampleRtt(sample) {
    updateRtt(this.#state, Math.max(1, sample));
  }

  #markHealthy() {
    if (!this.#state.connected) return;
    const recordsReady = [...this.#records.values()].every(record => record.bindingLive);
    const controlReady = this.#activeRecord ? !this.#activeRecord.claim || this.#activeRecord.controller : ![...this.#records.values()].some(record => record.claim && !record.controller);
    if (!recordsReady || !controlReady) {
      this.#attempt.readyAt = null;
      return;
    }
    this.#attempt.readyAt ??= this.#clock.now();
    if (this.#state.status === "roaming") this.#setStatus("ready", true);
  }

  #wake() {
    if (this.#disposed || this.#fatal) return;
    if (!this.#attempt) return this.#admit();
    this.#observeExecution(this.#attempt);
    if (!this.#document?.hidden && !this.#frozen && this.#attempt.socket.readyState !== 1) {
      this.#retire(this.#attempt, new Error("session socket unavailable after resume"), "socket-unavailable");
    }
  }

  #suspend(attempt) {
    if (!this.#current(attempt) || attempt.suspended) return;
    attempt.suspended = true;
    this.#state.suspended = true;
    attempt.helloSuspended = true;
    this.#state.suspensionCount++;
    this.#cancelHedge(this.#hedge);
    this.#invalidateProbe(attempt);
  }

  #invalidateProbe(attempt) {
    attempt.probe = null;
    // Unsubmitted probes from before suspension must not leave later.
    attempt.controls = attempt.controls.filter(item => item.type !== FrameType.PING);
    attempt.controlBytes = attempt.controls.reduce((sum, item) => sum + item.bytes, 0);
    attempt.nextProbeAt = this.#clock.now();
  }

  #observeExecution(attempt) {
    const now = this.#clock.now();
    if (this.#document?.hidden || this.#frozen) this.#suspend(attempt);
    const gap = now - attempt.lastTick > this.#profile.schedulingGapMs;
    if (!this.#document?.hidden && !this.#frozen && (attempt.suspended || gap)) {
      if (gap && !attempt.suspended) this.#state.suspensionCount++;
      attempt.suspended = false;
      this.#state.suspended = false;
      attempt.helloSuspended = true;
      attempt.phaseStarted = now;
      attempt.lastTick = now;
      this.#invalidateProbe(attempt);
      for (const item of attempt.controls) item.created = now;
      if (attempt.phase === "ready") {
        this.#setStatus("checking", true);
        this.#ping();
      }
    }
    // Only supervision ticks or invalidation renew lastTick, not ordinary traffic.
  }

  #armTick(attempt) {
    if (!this.#current(attempt)) return;
    this.#clock.clearTimeout(attempt.timer);
    const now = this.#clock.now();
    const probe = attempt.probe;
    let deadline = now + 100;
    if (!attempt.suspended) {
      if (attempt.phase !== "ready") deadline = Math.min(deadline, attempt.phaseStarted + (attempt.phase === "connecting" ? this.#profile.connectMs : this.#profile.helloMs));
      else if (probe) deadline = Math.min(deadline, (probe.submitted ?? probe.created) + (probe.submitted === null ? this.#profile.controlSubmitMs : this.#profile.responseMs));
      else deadline = Math.min(deadline, attempt.nextProbeAt);
    }
    attempt.timer = this.#clock.setTimeout(() => this.#tick(attempt), Math.max(1, deadline - now));
  }

  #tick(attempt) {
    if (!this.#current(attempt)) return;
    this.#observeExecution(attempt);
    const now = this.#clock.now();
    attempt.lastTick = now;
    this.#state.bufferedAmount = attempt.socket.bufferedAmount;
    if (attempt.socket.readyState === 3) {
      this.#releaseSlot(attempt.slot);
      return this.#retire(attempt, new Error("session socket closed"), "socket-close");
    }
    if (!attempt.suspended) {
      if (attempt.phase !== "ready" && now - attempt.phaseStarted >= (attempt.phase === "connecting" ? this.#profile.connectMs : this.#profile.helloMs)) {
        return this.#retire(attempt, new Error(`session ${attempt.phase === "connecting" ? "connection" : "HELLO"} deadline exceeded`), `${attempt.phase}-unavailable`);
      }
      const pending = attempt.probe;
      if (attempt.controls.some(item => now - item.created >= this.#profile.controlSubmitMs) || (pending?.submitted === null && now - pending.created >= this.#profile.controlSubmitMs)) {
        return this.#retire(attempt, new Error("connection control submission stalled"), "local-control-stall");
      }
      if (pending?.submitted !== null && pending?.submitted !== undefined) {
        const elapsed = now - pending.submitted;
        if (elapsed >= this.#profile.responseMs) return this.#retire(attempt, new Error("session PONG response unavailable"), "response-unavailable");
        if (elapsed >= this.#profile.hedgeDelayMs) {
          if (!pending.suspect) {
            pending.suspect = true;
            this.#setStatus("suspect", true);
          }
          this.#startHedge(attempt);
        }
      }
      if (attempt.phase === "ready" && !attempt.probe && now >= attempt.nextProbeAt) this.#ping();
    }
    this.#drainSends(attempt);
    this.#armTick(attempt);
  }

  #listenSocket(attempt) {
    const socket = attempt.socket;
    socket.binaryType = "arraybuffer";
    const open = () => this.#socketOpen(attempt);
    const message = event => {
      if (!this.#current(attempt) || attempt.phase === "connecting") return;
      try {
        this.#socketMessage(attempt, event);
      } catch (error) {
        this.#fail(error, socket);
      }
    };
    const error = () => this.#retire(attempt, new Error("session socket error"), "socket-io");
    socket.addEventListener("open", open);
    socket.addEventListener("message", message);
    socket.addEventListener("error", error);
    attempt.unlisten = () => {
      socket.removeEventListener("open", open);
      socket.removeEventListener("message", message);
      socket.removeEventListener("error", error);
    };
    // This listener retains only accounting, not canceled application buffers.
    const slot = attempt.slot;
    const close = () => {
      socket.removeEventListener("close", close);
      this.#releaseSlot(slot);
      if (this.#socket === socket) this.#retire(this.#attempt, new Error("session socket closed"), "socket-close");
      else this.#admit();
    };
    socket.addEventListener("close", close);
  }

  #flushFrozen(record) {
    if (!record?.frozen.length) return;
    const frozen = record.frozen.splice(0);
    record.frozenBytes = 0;
    for (const event of frozen) this.#applyEvent(record, event.flags, event.payload);
  }

  #resetOutputDecoder(record) {
    record.outputDecodeTarget = null;
    record.outputDecodeOffset = 0;
    record.outputPreambleOffset = 0;
    record.outputDecoder = new Decompress(chunk => {
      const target = record.outputDecodeTarget;
      if (!target) throw new Error("output decoded outside a decode operation");
      let offset = 0;
      while (offset < chunk.byteLength && record.outputPreambleOffset < OUTPUT_STREAM_PREAMBLE.byteLength) {
        if (chunk[offset] !== OUTPUT_STREAM_PREAMBLE[record.outputPreambleOffset]) throw new Error("invalid output stream preamble");
        offset++;
        record.outputPreambleOffset++;
      }
      const output = chunk.subarray(offset);
      if (record.outputDecodeOffset + output.byteLength > target.byteLength) throw new Error("output decoder overflow");
      target.set(output, record.outputDecodeOffset);
      record.outputDecodeOffset += output.byteLength;
    });
  }

  #decodeOutput(record, body, rawLength) {
    if (!record.outputDecoder) throw new Error("output decoder is unavailable");
    if (!this.#eventScratch || this.#eventScratch.byteLength < rawLength) this.#eventScratch = new Uint8Array(rawLength);
    const target = this.#eventScratch.subarray(0, rawLength);
    record.outputDecodeTarget = target;
    record.outputDecodeOffset = 0;
    try {
      record.outputDecoder.push(body, false);
      if (record.outputPreambleOffset !== OUTPUT_STREAM_PREAMBLE.byteLength || record.outputDecodeOffset !== rawLength) throw new Error("output decoder length mismatch");
      return target;
    } finally {
      record.outputDecodeTarget = null;
    }
  }

  #current(attempt) { return !!attempt && attempt === this.#attempt && !attempt.retired && !this.#disposed && !this.#fatal; }

  #releaseSlot(slot) {
    if (slot.released) return;
    slot.released = true;
    this.#slots.delete(slot);
    this.#state.unreleasedSockets = this.#slots.size;
  }

  #retire(attempt, error, outcome) {
    if (!attempt || attempt !== this.#attempt || attempt.retired) return;
    attempt.retired = true;
    const now = this.#clock.now();
    this.#state.lastOutcome = {
      kind: outcome, message: error.message, generation: attempt.generation, at: now,
      bufferedAmount: attempt.socket?.bufferedAmount ?? 0, queuedApplicationBytes: attempt.queueBytes,
      queuedSendBytes: attempt.controlBytes + attempt.sendBytes,
      probeSubmittedAt: attempt.probe?.submitted ?? null, fatal: !!this.#fatal,
    };
    this.#setStatus("retiring", false);
    // Fence first, before abort callbacks, rollback, or synchronous close events.
    this.#attempt = null;
    this.#clock.clearTimeout(attempt.timer);
    this.#clock.clearTimeout(attempt.appTimer);
    attempt.unlisten?.();
    attempt.unlisten = null;
    attempt.cancel.abort();
    attempt.queue.length = 0;
    attempt.queueHead = 0;
    attempt.queueBytes = 0;
    attempt.controls.length = 0;
    attempt.sends.length = 0;
    attempt.sendBytes = attempt.controlBytes = 0;
    attempt.probe = null;
    this.#state.queuedApplicationBytes = this.#state.queuedSendBytes = 0;
    attempt.canceledAttaches.clear();
    this.#state.connected = false;
    for (const record of this.#records.values()) {
      resetCheckpointTransaction(record);
      markRecordDetached(record);
      record.bindingLive = false;
      record.attempt = null;
      record.outputDecoder = null;
      record.outputDecodeTarget = null;
      record.pendingCredit = 0;
    }
    if (!this.#disposed && !this.#fatal) {
      const base = Math.min(this.#profile.retryCeilingMs, this.#profile.retryFloorMs * 2 ** Math.min(this.#failures++, 16));
      this.#retryAt = now + base;
      this.#state.retryAt = this.#retryAt;
    }
    const socket = attempt.socket;
    if (socket?.readyState === 3) this.#releaseSlot(attempt.slot);
    else { try { socket?.close(); } catch {} }
    // A synchronous close callback may already have admitted a replacement.
    if (!this.#disposed && !this.#fatal && !this.#attempt) this.#scheduleAdmission();
    for (const record of this.#records.values()) if (record.attempt === null) this.#attachmentEmitter.emit(record, "detached");
  }

  #scheduleAdmission() {
    if (this.#reconnectTimer || this.#attempt || this.#hedge || this.#disposed || this.#fatal || !this.#desired) return;
    if (this.#slots.size >= 2 && this.#clock.now() >= this.#retryAt) return this.#setStatus("resource-wait", false);
    this.#setStatus("backoff", false);
    this.#reconnectTimer = this.#clock.setTimeout(() => {
      this.#reconnectTimer = 0;
      this.#admit();
    }, Math.max(0, this.#retryAt - this.#clock.now()));
  }

  #clearReconnect() {
    this.#clock.clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = 0;
  }

  #fail(error, socket = this.#socket) {
    if (this.#disposed || this.#fatal || !socket || socket !== this.#socket) return;
    // A bad connection is fenced before retry. Even peer-declared fatal errors
    // can be caused by a stale rolling-deployment path and must not strand the UI.
    error.reported = true;
    this.#retire(this.#attempt, error, "protocol-error");
    this.#errorEmitter.emit(error);
  }

  #failAttachment(record, error) {
    const hasCaller = !!record.reject;
    this.#removeRecord(record, error);
    if (!hasCaller) this.#errorEmitter.emit(error);
  }

  #removeRecord(record, error) {
    if (!record.active) return;
    record.cleanupAbort?.();
    const attempt = this.#attempt;
    if (this.#current(attempt) && record.attempt === attempt && record.attachSubmitted && !record.epoch) {
      // attach() reserves this bounded cleanup capacity before sending ATTACH.
      attempt.canceledAttaches.set(record.attachmentId.toString(), {
        active: true, attempt, attachmentId: record.attachmentId, sessionId: record.sessionId,
        attachRequestId: record.attachRequestId, epoch: 0n,
      });
    }
    this.#cancelRecordSends(record);
    rememberStaleAttachment(this.#staleAttachmentIds, record);
    record.active = false;
    record.outputDecoder = null;
    record.outputDecodeTarget = null;
    record.outputDecodeOffset = 0;
    record.outputPreambleOffset = 0;
    markRecordDetached(record);
    record.bindingLive = false;
    resetCheckpointTransaction(record);
    this.#records.delete(record.attachmentId.toString());
    record.inputDisposable?.dispose();
    record.reject?.(error);
    record.resolve = null;
    record.reject = null;
    if (this.#activeRecord === record) this.#activeRecord = null;
    this.#state.attachmentCount = this.#records.size;
    this.#attachmentEmitter.emit(record, "removed");
  }

  #cancelRecordSends(record) {
    const attempt = this.#attempt;
    if (!attempt || record.attempt !== attempt) return;
    // Nothing queued has a wire sequence yet. Do not let old binding ACKs or
    // resize/claim requests leak into a same-attempt resync or detach.
    attempt.sends = attempt.sends.filter(item => item.attachmentId !== record.attachmentId || item.type === FrameType.DETACH);
    attempt.sendBytes = attempt.sends.reduce((sum, item) => sum + item.bytes, 0);
    this.#state.queuedSendBytes = attempt.sendBytes + attempt.controlBytes;
  }

  #setStatus(status, connected) {
    if (this.#state.status === status && this.#state.connected === connected) return;
    this.#state.status = status;
    this.#state.connected = connected;
    this.#statusEmitter.emit(status, this.#state);
  }

  #requireRecord(record, frame) {
    if (!record || !record.active || record.attempt !== this.#attempt || this.#records.get(frame.attachmentId.toString()) !== record || !equalBytes(frame.sessionId, record.sessionId) || (record.epoch === 0n ? frame.type !== FrameType.ATTACH_BEGIN : frame.attachmentEpoch !== record.epoch)) throw new Error("stale attachment frame");
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
