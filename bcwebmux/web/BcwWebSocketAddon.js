// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import {
  Decompress,
} from "./fzstd.js";
import {
  CURRENT_SUBPROTOCOL,
  PROBE_PREFIX,
  encodeResize,
} from "./protocol.js";

const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 5000;
const RTT_INTERVAL_MS = 1000;
const RTT_PRUNE_MS = 10000;
const RTT_MAX_SAMPLES = 32;
const FROZEN_OUTPUT_LIMIT = 4 * 1024 * 1024;
const BCWP_RESPONSE_RE = /^BCWP:(\d+)$/;

function createDisposable(dispose) {
  let disposed = false;
  return Object.freeze({
    dispose() {
      if (disposed) return;
      disposed = true;
      dispose();
    },
  });
}

function now() {
  return globalThis.performance?.now() ?? Date.now();
}

function updateRttStats(samples, state) {
  if (!samples.length) {
    state.wsRttLatestMs = null;
    state.wsRttMedianMs = null;
    state.wsRttP95Ms = null;
    return;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  state.wsRttLatestMs = samples[samples.length - 1];
  state.wsRttMedianMs = sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
  state.wsRttP95Ms = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

export class BcwWebSocketAddon {
  #url;
  #webSocketFactory;
  #terminal = null;
  #terminalDisposables = [];
  #statusListeners = new Set();
  #pageHideListener = null;
  #pageHideBound = false;
  #socket = null;
  #outputDecoder = null;
  #resizeMessage = new Uint8Array(12);
  #selectionMode = false;
  #frozenMessages = [];
  #frozenBytes = 0;
  #reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  #reconnectTimer = 0;
  #rttTimer = 0;
  #openedOnce = false;
  #disposed = false;
  #rttProbeSequence = 0;
  #outstandingRttProbes = new Map();
  #rttSamples = [];
  #state = {
    connected: false,
    status: "disconnected",
    selectionMode: false,
    rxBytes: 0,
    rxWireBytes: 0,
    txBytes: 0,
    wsRttLatestMs: null,
    wsRttMedianMs: null,
    wsRttP95Ms: null,
  };

  constructor(options = {}) {
    if (typeof options === "string" || options instanceof URL) {
      options = { url: options };
    }
    this.#url = options.url ?? null;
    this.#webSocketFactory = typeof options.webSocketFactory === "function"
      ? options.webSocketFactory
      : (url, protocol) => new WebSocket(url, protocol);
    this.#pageHideListener = () => {
      this.#socket?.close();
    };
  }

  activate(terminal) {
    if (this.#disposed) return;
    if (!terminal) throw new TypeError("BcwWebSocketAddon.activate(terminal) requires a terminal");
    if (this.#terminal === terminal) {
      this.#ensureRuntimeBindings();
      return;
    }
    this.#disposeTerminalBindings();
    this.#terminal = terminal;
    this.#selectionMode = false;
    this.#state.selectionMode = false;
    this.#terminalDisposables = [
      terminal.onData((data) => this.#handleTerminalData(data)),
      terminal.onResize((size) => this.#handleTerminalResize(size)),
      terminal.onSelectionModeChange((value) => this.#handleSelectionModeChange(value)),
    ];
    this.#ensureRuntimeBindings();
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearReconnectTimer();
    this.#clearRttTimer();
    if (this.#pageHideBound && typeof window !== "undefined") {
      window.removeEventListener("pagehide", this.#pageHideListener);
      this.#pageHideBound = false;
    }
    this.#disposeTerminalBindings();
    if (this.#selectionMode) {
      this.#requestSelectionModeExit({ flush: false, restoreFocus: false });
    }
    this.#discardFrozenMessages();
    this.#outstandingRttProbes.clear();
    this.#outputDecoder = null;
    const socket = this.#socket;
    this.#socket = null;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      try {
        socket.close();
      } catch {
        // Ignore close failures during disposal.
      }
    }
    this.#setStatus("disconnected", false);
    this.#statusListeners.clear();
  }

  connect() {
    if (this.#disposed) return false;
    if (!this.#terminal) {
      throw new Error("BcwWebSocketAddon.connect() requires activate(terminal) first");
    }
    this.#ensureRuntimeBindings();
    this.#clearReconnectTimer();
    if (this.#socket && this.#socket.readyState !== WebSocket.CLOSED) {
      return false;
    }
    this.#setStatus("connecting", false);
    const socket = this.#webSocketFactory(this.#resolveUrl(), CURRENT_SUBPROTOCOL);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => this.#handleSocketOpen(socket));
    socket.addEventListener("message", (event) => this.#handleSocketMessage(socket, event));
    socket.addEventListener("close", () => this.#handleSocketClose(socket));
    socket.addEventListener("error", () => {
      if (socket !== this.#socket || this.#disposed) return;
      socket.close();
    });
    this.#socket = socket;
    return true;
  }

  onStatus(listener) {
    if (typeof listener !== "function") {
      throw new TypeError("BcwWebSocketAddon.onStatus(listener) requires a function");
    }
    this.#statusListeners.add(listener);
    return createDisposable(() => {
      this.#statusListeners.delete(listener);
    });
  }

  get state() {
    return this.#state;
  }

  #ensureRuntimeBindings() {
    if (!this.#rttTimer) {
      this.#rttTimer = globalThis.setInterval(() => this.#sendRttProbe(), RTT_INTERVAL_MS);
    }
    if (!this.#pageHideBound && typeof window !== "undefined") {
      window.addEventListener("pagehide", this.#pageHideListener);
      this.#pageHideBound = true;
    }
  }

  #disposeTerminalBindings() {
    for (const disposable of this.#terminalDisposables) {
      disposable?.dispose?.();
    }
    this.#terminalDisposables = [];
  }

  #clearReconnectTimer() {
    if (!this.#reconnectTimer) return;
    globalThis.clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = 0;
  }

  #clearRttTimer() {
    if (!this.#rttTimer) return;
    globalThis.clearInterval(this.#rttTimer);
    this.#rttTimer = 0;
  }

  #emitStatus() {
    for (const listener of this.#statusListeners) {
      try {
        listener(this.#state.status, this.#state);
      } catch (error) {
        console.error("BcwWebSocketAddon onStatus listener failed", error);
      }
    }
  }

  #setStatus(status, connected) {
    const changed = this.#state.status !== status || this.#state.connected !== connected;
    this.#state.status = status;
    this.#state.connected = connected;
    if (changed) this.#emitStatus();
  }

  #resolveUrl() {
    if (this.#url) {
      return String(this.#url instanceof URL ? this.#url : new URL(String(this.#url), globalThis.location?.href));
    }
    if (!globalThis.location) {
      throw new Error("BcwWebSocketAddon requires window.location or an explicit url option");
    }
    const scheme = globalThis.location.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${globalThis.location.host}/ws`;
  }

  #handleTerminalData(data) {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) return;
    this.#socket.send(data);
    this.#state.txBytes += data.byteLength;
  }

  #handleTerminalResize(size) {
    if (this.#selectionMode) {
      this.#requestSelectionModeExit({ restoreFocus: false });
    }
    const cols = Number.isInteger(size?.cols) ? size.cols : this.#terminal?.cols;
    const rows = Number.isInteger(size?.rows) ? size.rows : this.#terminal?.rows;
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
    this.#sendResize(cols, rows);
  }

  #handleSelectionModeChange(value) {
    const wasSelectionMode = this.#selectionMode;
    this.#selectionMode = value.active;
    this.#state.selectionMode = this.#selectionMode;
    if (!wasSelectionMode || this.#selectionMode) return;
    const flush = value.flush !== false;
    if (flush) this.#flushFrozenMessages();
    else this.#discardFrozenMessages();
  }

  #handleSocketOpen(socket) {
    if (socket !== this.#socket || this.#disposed) return;
    if (socket.protocol !== CURRENT_SUBPROTOCOL) {
      this.#setStatus("compression error", false);
      socket.close();
      return;
    }
    const onDecodedChunk = (chunk) => this.#feedOutputChunk(socket, chunk);
    const decoder = new Decompress(onDecodedChunk);
    decoder.onerror = () => {
      if (socket !== this.#socket || this.#disposed) return;
      this.#setStatus("compression error", false);
      socket.close();
    };
    this.#outputDecoder = decoder;
    if (this.#openedOnce) {
      this.#terminal?.reset();
    }
    this.#openedOnce = true;
    this.#reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    this.#setStatus("connected", true);
    this.#sendResize();
    this.#sendRttProbe();
    this.#terminal?.focus?.();
  }

  #handleSocketMessage(socket, event) {
    if (socket !== this.#socket || this.#disposed) return;
    if (typeof event.data === "string") {
      const match = BCWP_RESPONSE_RE.exec(event.data);
      if (!match) return;
      const sequence = Number(match[1]);
      const sentAt = this.#outstandingRttProbes.get(sequence);
      if (sentAt === undefined) return;
      this.#outstandingRttProbes.delete(sequence);
      const sample = now() - sentAt;
      this.#rttSamples.push(sample);
      if (this.#rttSamples.length > RTT_MAX_SAMPLES) {
        this.#rttSamples.shift();
      }
      updateRttStats(this.#rttSamples, this.#state);
      return;
    }
    if (!(event.data instanceof ArrayBuffer)) return;
    this.#state.rxWireBytes += event.data.byteLength;
    if (this.#selectionMode) {
      this.#frozenMessages.push(event.data);
      this.#frozenBytes += event.data.byteLength;
      if (this.#frozenBytes > FROZEN_OUTPUT_LIMIT) {
        this.#requestSelectionModeExit({ restoreFocus: false });
      }
      return;
    }
    this.#processBinaryOutput(socket, event.data);
  }

  #handleSocketClose(socket) {
    if (socket !== this.#socket) return;
    this.#socket = null;
    this.#state.connected = false;
    if (this.#selectionMode) {
      this.#requestSelectionModeExit({ flush: false, restoreFocus: false });
    }
    this.#discardFrozenMessages();
    this.#outputDecoder = null;
    this.#outstandingRttProbes.clear();
    this.#terminal?.clearPendingLatency?.();
    this.#setStatus("disconnected", false);
    if (this.#disposed) return;
    this.#reconnectTimer = globalThis.setTimeout(() => {
      this.#reconnectTimer = 0;
      this.connect();
    }, this.#reconnectDelay);
    this.#reconnectDelay = Math.min(MAX_RECONNECT_DELAY_MS, this.#reconnectDelay * 2);
  }

  #feedOutputChunk(socket, chunk) {
    if (socket !== this.#socket || this.#disposed || !this.#terminal) return;
    this.#terminal.write(chunk);
    this.#state.rxBytes += chunk.length;
  }

  #processBinaryOutput(socket, message) {
    if (socket !== this.#socket || !this.#outputDecoder) return;
    try {
      this.#outputDecoder.push(new Uint8Array(message), false);
    } catch {
      this.#setStatus("compression error", false);
      socket.close();
    }
  }

  #sendResize(cols = this.#terminal?.cols, rows = this.#terminal?.rows) {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) return;
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
    this.#socket.send(encodeResize(cols, rows, this.#resizeMessage));
  }

  #sendRttProbe() {
    const probeNow = now();
    for (const [sequence, sentAt] of this.#outstandingRttProbes) {
      if (probeNow - sentAt > RTT_PRUNE_MS) {
        this.#outstandingRttProbes.delete(sequence);
      }
    }
    if (globalThis.document?.hidden) return;
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) return;
    const sequence = this.#rttProbeSequence++;
    this.#socket.send(`${PROBE_PREFIX}${sequence}`);
    this.#outstandingRttProbes.set(sequence, now());
  }

  #requestSelectionModeExit(options = {}) {
    if (!this.#selectionMode || !this.#terminal) return false;
    this.#terminal.exitSelectionMode(options);
    return true;
  }

  #discardFrozenMessages() {
    this.#frozenMessages.splice(0);
    this.#frozenBytes = 0;
  }

  #flushFrozenMessages() {
    if (!this.#frozenMessages.length) return;
    const messages = this.#frozenMessages.splice(0);
    this.#frozenBytes = 0;
    const socket = this.#socket;
    if (!socket) return;
    for (const message of messages) {
      this.#processBinaryOutput(socket, message);
    }
  }
}
