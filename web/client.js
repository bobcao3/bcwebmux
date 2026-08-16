import { GpuTerminal } from "./gpu.js";
import { Decompress } from "/fzstd.js";

const terminal = document.querySelector("#terminal");
const perf = document.querySelector("#perf");
const scroll = document.querySelector("#scroll");
const spacer = document.querySelector("#spacer");
const screen = document.querySelector("#screen");
const input = document.querySelector("#input");
const compositionView = document.querySelector("#composition");
const softkeys = document.querySelector("#softkeys");
const status = document.querySelector("#status");
const inputDebugPanel = document.querySelector("#input-debug");
const inputDebugLog = document.querySelector("#input-debug-log");
const inputDebugClear = document.querySelector("#input-debug-clear");
const inputDebugCopy = document.querySelector("#input-debug-copy");
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const resizeMessage = new Uint8Array(12);
const resizeView = new DataView(resizeMessage.buffer);
resizeView.setUint32(0, 0x52574342, true);
const state = {
  connected: false,
  frames: 0,
  rxBytes: 0,
  rxWireBytes: 0,
  txBytes: 0,
  cols: 0,
  rows: 0,
  wasmParseMs: null,
  wasmFrameMs: null,
  rxLatencyMs: null,
  inputLatencyMs: null,
  wsRttLatestMs: null,
  wsRttMedianMs: null,
  wsRttP95Ms: null,
};

let wasm;
let socket;
let renderer;
let outputDecoder;
let framePending = false;
let frameDirty = false;
let submittedSinceAnimationFrame = false;
let resizePending = false;
let reconnectDelay = 250;
let openedOnce = false;
let softModifiers = 0;
let suppressScroll = false;
let encodedRightClick = false;
let pendingRxAt = 0;
let pendingInputAt = 0;
let rttProbeSequence = 0;
const outstandingRttProbes = new Map();
const rttSamples = [];
await Promise.all([
  document.fonts.load("normal 400 15px 'JetBrains Mono Nerd Font'"),
  document.fonts.load("normal 700 15px 'JetBrains Mono Nerd Font'"),
  document.fonts.load("italic 400 15px 'JetBrains Mono Nerd Font'"),
  document.fonts.load("italic 700 15px 'JetBrains Mono Nerd Font'"),
]);
await document.fonts.ready;
const metrics = measureCells();
const coarsePointer = window.matchMedia("(hover: none) and (pointer: coarse)");
const namedEventCodes = {
  Enter: "Enter",
  Backspace: "Backspace",
  Tab: "Tab",
  Escape: "Escape",
  Esc: "Escape",
  Delete: "Delete",
  Del: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Shift: "Shift",
  Control: "Control",
  Alt: "Alt",
  Meta: "Meta",
};
const legacyEventCodes = {
  8: "Backspace",
  9: "Tab",
  13: "Enter",
  16: "Shift",
  17: "Control",
  18: "Alt",
  27: "Escape",
  33: "PageUp",
  34: "PageDown",
  35: "End",
  36: "Home",
  37: "ArrowLeft",
  38: "ArrowUp",
  39: "ArrowRight",
  40: "ArrowDown",
  45: "Insert",
  46: "Delete",
};

class InputDiagnostics {
  enabled = new URLSearchParams(location.search).has("input-debug");
  entries = [];
  started = performance.now();

  constructor() {
    if (!this.enabled) return;
    inputDebugPanel?.removeAttribute("hidden");
    for (const type of [
      "keydown", "keyup", "keypress", "beforeinput", "input",
      "compositionstart", "compositionupdate", "compositionend",
      "textInput", "focus", "blur",
    ]) {
      input.addEventListener(type, (event) => {
        this.event("event", event);
        queueMicrotask(() => this.event("post", event));
      }, { capture: true });
    }
    inputDebugClear?.addEventListener("click", () => this.clear());
    inputDebugCopy?.addEventListener("click", () => this.copy());
    this.log("environment", {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      secureContext: window.isSecureContext,
    });
  }

  log(kind, data) {
    if (!this.enabled) return;
    this.entries.push({ t: performance.now() - this.started, kind, data });
    if (this.entries.length > 400) this.entries.splice(0, this.entries.length - 400);
    inputDebugLog.textContent = this.entries.slice(-80).map((entry) => JSON.stringify(entry)).join("\n");
  }

  event(stage, event) {
    if (!this.enabled) return;
    this.log("event", {
      stage,
      type: event.type,
      key: event.key ?? null,
      code: event.code ?? null,
      keyCode: event.keyCode ?? null,
      which: event.which ?? null,
      inputType: event.inputType ?? null,
      data: event.data ?? null,
      isComposing: !!event.isComposing,
      repeat: !!event.repeat,
      cancelable: !!event.cancelable,
      defaultPrevented: !!event.defaultPrevented,
      value: input.value,
      selectionStart: input.selectionStart,
      selectionEnd: input.selectionEnd,
    });
  }

  clear() {
    if (!this.enabled) return;
    this.entries = [];
    this.log("environment", {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      secureContext: window.isSecureContext,
    });
  }

  text() {
    if (!this.enabled) return "";
    return this.entries.map((entry) => JSON.stringify(entry)).join("\n");
  }

  async copy() {
    if (!this.enabled) return;
    try {
      await navigator.clipboard.writeText(`bcwebmux input diagnostics\n${this.text()}`);
      inputDebugCopy.textContent = "COPIED";
    } catch {
      inputDebugCopy.textContent = "COPY FAILED";
    }
    setTimeout(() => {
      inputDebugCopy.textContent = "COPY";
    }, 1200);
  }
}

const inputDiagnostics = new InputDiagnostics();

const imports = {
  host: {
    gpu_init(cellPtr, cellLen, maxCells, maxGlyphs, atlasSlots, cellSize) {
      try {
        const memory = wasm.memory.buffer;
        const cellSource = decoder.decode(new Uint8Array(memory, cellPtr, cellLen));
        return renderer.initialize(cellSource, maxCells, maxGlyphs, atlasSlots, cellSize);
      } catch (error) {
        console.error(error);
        return 0;
      }
    },
    gpu_glyph(slot, textPtr, textLen, flags) {
      try {
        const text = decoder.decode(new Uint8Array(wasm.memory.buffer, textPtr, textLen));
        return renderer.glyph(slot, text, flags);
      } catch (error) {
        console.error(error);
        return 0;
      }
    },
    gpu_submit(framePtr, cellsPtr) {
      try {
        submitGpuFrame(framePtr, cellsPtr);
        return 1;
      } catch (error) {
        console.error(error);
        return 0;
      }
    },
    pty_write(ptr, len) {
      if (!socket || socket.readyState !== WebSocket.OPEN) return 0;
      const view = new Uint8Array(wasm.memory.buffer, ptr, len);
      if (inputDiagnostics.enabled) {
        const sample = view.subarray(0, 64);
        inputDiagnostics.log("pty_write", {
          len,
          hex: Array.from(sample, (byte) => byte.toString(16).padStart(2, "0")).join(" "),
          text: decoder.decode(sample),
        });
      }
      if (!pendingInputAt) pendingInputAt = performance.now();
      socket.send(view);
      state.txBytes += len;
      return 1;
    },
    set_title(ptr, len) {
      document.title = decoder.decode(new Uint8Array(wasm.memory.buffer, ptr, len)) || "bcwebmux";
    },
    ring_bell() {
      terminal.classList.add("flash");
      setTimeout(() => terminal.classList.remove("flash"), 80);
    },
  },
};

const initial = dimensions();
const initialPixelViewport = nativePixelViewport();
try {
  renderer = await GpuTerminal.create(screen, metrics, initialPixelViewport);
} catch (error) {
  setConnectionStatus(false, error.message || "gpu error");
  throw error;
}
const result = await WebAssembly.instantiateStreaming(fetch("/terminal.wasm"), imports);
wasm = result.instance.exports;
if (wasm.term_init(initial.cols, initial.rows) !== 1) throw new Error("terminal initialization failed");
resizeTerminal();
connect();
scheduleFrame();
updateTelemetry();
setInterval(updateTelemetry, 250);
setInterval(sendRttProbe, 1000);

function measureCells() {
  const probe = document.createElement("span");
  probe.textContent = "MMMMMMMMMM";
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font:inherit";
  terminal.append(probe);
  const rect = probe.getBoundingClientRect();
  probe.remove();
  const width = Math.max(1, rect.width / 10);
  const height = Math.max(1, rect.height);
  terminal.style.setProperty("--cell-width", `${width}px`);
  terminal.style.setProperty("--cell-height", `${height}px`);
  return { width, height };
}

function dimensions() {
  return {
    cols: Math.max(2, Math.floor(screen.clientWidth / metrics.width)),
    rows: Math.max(2, Math.floor(screen.clientHeight / metrics.height)),
  };
}

function nativePixelViewport(entry) {
  const box = entry?.devicePixelContentBoxSize;
  const size = Array.isArray(box) ? box[0] : box;
  if (size) {
    return {
      width: Math.max(1, Math.round(size.inlineSize)),
      height: Math.max(1, Math.round(size.blockSize)),
    };
  }
  const rect = screen.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  return {
    width: Math.max(1, Math.round(rect.width * scale)),
    height: Math.max(1, Math.round(rect.height * scale)),
  };
}

function submitGpuFrame(framePtr, cellsPtr) {
  const metadata = renderer.update(wasm.memory.buffer, framePtr, cellsPtr);
  const submittedAt = performance.now();
  if (pendingRxAt) {
    sampleMetric("rxLatencyMs", submittedAt - pendingRxAt);
    pendingRxAt = 0;
  }
  if (pendingInputAt) {
    sampleMetric("inputLatencyMs", submittedAt - pendingInputAt);
    pendingInputAt = 0;
  }
  state.cols = metadata.cols;
  state.rows = metadata.rows;
  spacer.style.height = `${Math.max(metadata.scrollTotal, metadata.scrollLength) * metrics.height}px`;
  const targetScroll = metadata.scrollOffset * metrics.height;
  if (Math.abs(scroll.scrollTop - targetScroll) > 0.5) {
    suppressScroll = true;
    scroll.scrollTop = targetScroll;
    queueMicrotask(() => {
      suppressScroll = false;
    });
  }
  terminalInput.sync();
  state.frames += 1;
}

function renderFrame() {
  frameDirty = false;
  const startedAt = performance.now();
  wasm.term_frame();
  sampleMetric("wasmFrameMs", performance.now() - startedAt);
}

function scheduleFrame(immediate = false) {
  frameDirty = true;
  if (document.hidden) return;
  if (immediate && !submittedSinceAnimationFrame) {
    renderFrame();
    submittedSinceAnimationFrame = true;
  }
  requestDisplayFrame();
}

function requestDisplayFrame() {
  if (document.hidden || framePending) return;
  framePending = true;
  requestAnimationFrame(() => {
    framePending = false;
    submittedSinceAnimationFrame = false;
    if (document.hidden || !frameDirty) return;
    renderFrame();
    submittedSinceAnimationFrame = true;
    requestAnimationFrame(() => {
      submittedSinceAnimationFrame = false;
    });
  });
}

function sampleMetric(name, value) {
  if (!Number.isFinite(value)) return;
  state[name] = state[name] == null ? value : state[name] * 0.8 + value * 0.2;
}

function setConnectionStatus(connected, label) {
  status.classList.toggle("connected", connected);
  status.setAttribute("aria-label", label);
  status.setAttribute("title", label);
}

function formatMs(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return value < 10 ? value.toFixed(1) : String(Math.round(value));
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "—";
  if (value < 1024) return `${Math.round(value)}B`;
  const unit = value < 1024 * 1024 ? "K" : "M";
  const amount = unit === "K" ? value / 1024 : value / (1024 * 1024);
  return `${amount.toFixed(1).replace(/\.0$/, "")}${unit}`;
}

function formatCompressionRatio(decoded, wire) {
  if (!wire) return "—";
  return `${(decoded / wire).toFixed(2)}x`;
}

function updateTelemetry() {
  const stats = renderer.stats;
  const atlasUsed = stats.atlasGlyphs ?? 0;
  const atlasCapacity = stats.atlasCapacity ?? 0;
  const atlasPercent = atlasCapacity ? Math.round(atlasUsed * 100 / atlasCapacity) : 0;
  const line = [
    `WASM frame: ${formatMs(state.wasmFrameMs)} ms · parse: ${formatMs(state.wasmParseMs)} ms`,
    `GPU submit: ${formatMs(stats.frameMs)} ms · presentation opportunity: ${formatMs(stats.presentationOpportunityMs)} ms`,
    `Queue drain: ${formatMs(stats.queueDrainMs)} ms`,
    `Socket → frame: ${formatMs(state.rxLatencyMs)} ms · Input → echo frame: ${formatMs(state.inputLatencyMs)} ms`,
    `WebSocket RTT latest / median / p95: ${formatMs(state.wsRttLatestMs)} / ${formatMs(state.wsRttMedianMs)} / ${formatMs(state.wsRttP95Ms)} ms`,
    `Viewport: ${state.cols} × ${state.rows} · Glyph atlas: ${atlasUsed} / ${atlasCapacity} (${atlasPercent}%)`,
    `Network received: ${formatBytes(state.rxBytes)} decoded · wire: ${formatBytes(state.rxWireBytes)} · compression: ${formatCompressionRatio(state.rxBytes, state.rxWireBytes)} · sent: ${formatBytes(state.txBytes)}`,
  ].join("\n");
  perf.value = line;
  const description = `WASM frame ${formatMs(state.wasmFrameMs)} ms; WASM parse ${formatMs(state.wasmParseMs)} ms; presentation opportunity ${formatMs(stats.presentationOpportunityMs)} ms; queue drain ${formatMs(stats.queueDrainMs)} ms; Socket → frame ${formatMs(state.rxLatencyMs)} ms; Input → echo frame ${formatMs(state.inputLatencyMs)} ms; WebSocket RTT latest / median / p95 ${formatMs(state.wsRttLatestMs)} / ${formatMs(state.wsRttMedianMs)} / ${formatMs(state.wsRttP95Ms)} ms; terminal ${state.cols} by ${state.rows}; atlas ${atlasUsed} of ${atlasCapacity} (${atlasPercent}%); down ${formatBytes(state.rxBytes)} decoded, ${formatBytes(state.rxWireBytes)} wire (${formatCompressionRatio(state.rxBytes, state.rxWireBytes)}), up ${formatBytes(state.txBytes)}; CPU submit ${formatMs(stats.frameMs)} ms; canvas ${screen.width} by ${screen.height} pixels`;
  perf.title = description;
  perf.setAttribute("aria-label", description);
}

function connect() {
  setConnectionStatus(false, "connecting");
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${scheme}://${location.host}/ws`, "bcw.zstd.v1");
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => {
    if (socket.protocol !== "bcw.zstd.v1") {
      setConnectionStatus(false, "compression error");
      socket.close();
      return;
    }
    const decoder = new Decompress();
    decoder.ondata = (chunk) => {
      const ptr = wasm.term_reserve(chunk.length);
      if (!ptr) throw new Error("WASM receive buffer exhausted");
      new Uint8Array(wasm.memory.buffer, ptr, chunk.length).set(chunk);
      const parseStartedAt = performance.now();
      wasm.term_feed(chunk.length);
      sampleMetric("wasmParseMs", performance.now() - parseStartedAt);
      state.rxBytes += chunk.length;
      scheduleFrame(true);
    };
    decoder.onerror = () => {
      setConnectionStatus(false, "compression error");
      socket.close();
    };
    outputDecoder = decoder;
    if (openedOnce) {
      wasm.term_deinit();
      const size = dimensions();
      wasm.term_init(size.cols, size.rows);
      resizeTerminal();
    }
    openedOnce = true;
    state.connected = true;
    reconnectDelay = 250;
    setConnectionStatus(true, "connected");
    sendResize();
    sendRttProbe();
    wasm.term_focus(document.hasFocus() ? 1 : 0);
    input.focus({ preventScroll: true });
  });
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      const match = /^BCWP:(\d+)$/.exec(event.data);
      if (!match) return;
      const sequence = Number(match[1]);
      const sentAt = outstandingRttProbes.get(sequence);
      if (sentAt === undefined) return;
      outstandingRttProbes.delete(sequence);
      const sample = performance.now() - sentAt;
      state.wsRttLatestMs = sample;
      rttSamples.push(sample);
      if (rttSamples.length > 32) rttSamples.shift();
      const sorted = [...rttSamples].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      state.wsRttMedianMs = sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
      state.wsRttP95Ms = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
      return;
    }
    if (!pendingRxAt) pendingRxAt = performance.now();
    state.rxWireBytes += event.data.byteLength;
    try {
      outputDecoder.push(new Uint8Array(event.data), false);
    } catch {
      setConnectionStatus(false, "compression error");
      socket.close();
    }
  });
  socket.addEventListener("close", () => {
    state.connected = false;
    outputDecoder = undefined;
    pendingRxAt = 0;
    pendingInputAt = 0;
    outstandingRttProbes.clear();
    setConnectionStatus(false, "disconnected");
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(5000, reconnectDelay * 2);
  });
  socket.addEventListener("error", () => socket.close());
}

function sendRttProbe() {
  const now = performance.now();
  for (const [sequence, sentAt] of outstandingRttProbes) {
    if (now - sentAt > 10000) outstandingRttProbes.delete(sequence);
  }
  if (document.hidden || !socket || socket.readyState !== WebSocket.OPEN) return;
  const sequence = rttProbeSequence++;
  socket.send(`BCWP:${sequence}`);
  outstandingRttProbes.set(sequence, performance.now());
}

function sendText(text, paste = false) {
  let remaining = text;
  while (remaining.length) {
    const ptr = wasm.term_reserve(48 * 1024);
    if (!ptr) throw new Error("WASM staging buffer exhausted");
    const buffer = new Uint8Array(wasm.memory.buffer, ptr, 48 * 1024);
    const result = encoder.encodeInto(remaining, buffer);
    if (!result.read && !result.written) throw new Error("text encoding made no progress");
    if (wasm.term_text(result.written, paste ? 1 : 0) !== 1) {
      throw new Error("WASM text submission failed");
    }
    if (result.read < remaining.length) remaining = remaining.slice(result.read);
    else break;
  }
}

function eventCode(event) {
  if (namedEventCodes[event.key]) return namedEventCodes[event.key];
  if (legacyEventCodes[event.keyCode]) return legacyEventCodes[event.keyCode];
  if (event.code && event.code !== "Unidentified") return event.code;
  const codepoint = event.key?.codePointAt(0);
  if (codepoint !== undefined && event.key.length === (codepoint > 0xffff ? 2 : 1)) {
    return characterCode(event.key);
  }
  return legacyEventCodes[event.keyCode] || "Unidentified";
}

function isImeKeyEvent(event) {
  return event.key === "Process" || event.key === "Dead" ||
    event.keyCode === 229 || eventCode(event) === "Unidentified";
}

function sendKey(event, action) {
  const code = eventCode(event);
  let key = event.key || "";
  const mods = modifierBits(event) | softModifiers;
  if ((softModifiers & 1) && /^[a-z]$/.test(key)) key = key.toUpperCase();
  const codepoint = key.codePointAt(0);
  const printable = codepoint !== undefined && key.length === (codepoint > 0xffff ? 2 : 1);
  if (inputDiagnostics.enabled) {
    inputDiagnostics.log("key_encode", {
      originalCode: event.code,
      originalKey: event.key,
      originalKeyCode: event.keyCode,
      resolvedCode: code,
      action,
      modifiers: mods,
    });
  }
  const result = sendEncodedKey(code, key, action, mods, printable && (mods & 1));
  if (action === 0 && !/^(Alt|Control|Meta|Shift)/.test(code)) clearSoftModifiers();
  return result;
}

function sendEncodedKey(code, key, action, mods, consumed) {
  const codepoint = key.codePointAt(0);
  const printable = codepoint !== undefined && key.length === (codepoint > 0xffff ? 2 : 1);
  const text = printable ? key : "";
  const ptr = wasm.term_reserve(512);
  if (!ptr) return 0;
  const buffer = new Uint8Array(wasm.memory.buffer, ptr, 512);
  const codeResult = encoder.encodeInto(code, buffer);
  if (codeResult.read !== code.length) return 0;
  const textResult = encoder.encodeInto(text, buffer.subarray(codeResult.written));
  if (textResult.read !== text.length) return 0;
  return wasm.term_key(
    action,
    mods,
    consumed ? 1 : 0,
    codeResult.written,
    textResult.written,
  );
}

function modifierBits(event) {
  let bits = 0;
  if (event.shiftKey) bits |= 1;
  if (event.ctrlKey) bits |= 2;
  if (event.altKey) bits |= 4;
  if (event.metaKey) bits |= 8;
  if (event.getModifierState?.("CapsLock")) bits |= 16;
  if (event.getModifierState?.("NumLock")) bits |= 32;
  return bits;
}

function sendCommittedInput(text) {
  for (const part of text.split(/(\r\n|\r|\n)/)) {
    if (part === "\r\n" || part === "\r" || part === "\n") {
      sendSoftKey("Enter", "Enter");
    } else if (part) {
      sendCommittedText(part);
    }
  }
}

class TerminalInput {
  isComposing = false;
  isSendingComposition = false;
  pendingComposition = "";
  commitTimer = 0;
  manualCommit = false;

  constructor() {
    this.clear();
  }

  resetGeometry() {
    if (coarsePointer.matches) {
      for (const property of [
        "left", "top", "right", "bottom", "width", "height", "line-height",
        "padding", "padding-left", "padding-top", "padding-right", "padding-bottom",
      ]) {
        input.style.removeProperty(property);
      }
    } else {
      input.style.left = "0px";
      input.style.top = "0px";
      input.style.width = "1px";
      input.style.height = "1px";
      input.style.lineHeight = "1px";
    }
  }

  emit(text) {
    if (inputDiagnostics.enabled) inputDiagnostics.log("ime_emit", { text });
    if (!text) return;
    sendCommittedInput(text);
  }

  clear() {
    clearTimeout(this.commitTimer);
    this.commitTimer = 0;
    this.isComposing = false;
    this.isSendingComposition = false;
    input.value = "";
    this.pendingComposition = "";
    compositionView.textContent = "";
    compositionView.classList.remove("active");
    this.resetGeometry();
  }

  sync() {
    if (!this.isComposing) return;
    const x = Math.max(0, renderer.cursorX === 0xffff ? 0 : renderer.cursorX) * metrics.width;
    const y = Math.max(0, renderer.cursorY === 0xffff ? 0 : renderer.cursorY) * metrics.height;
    if (coarsePointer.matches) {
      input.style.paddingLeft = `${x}px`;
      input.style.paddingTop = `${y}px`;
      input.style.lineHeight = `${metrics.height}px`;
    } else {
      input.style.left = `${x}px`;
      input.style.top = `${y}px`;
      input.style.width = `${Math.max(1, metrics.width)}px`;
      input.style.height = `${Math.max(1, metrics.height)}px`;
      input.style.lineHeight = `${metrics.height}px`;
    }
    compositionView.style.left = `${x}px`;
    compositionView.style.top = `${y}px`;
    compositionView.style.width = `${Math.max(1, Math.min(state.cols || 1, compositionView.textContent.length || 1)) * metrics.width}px`;
    compositionView.style.height = `${Math.max(1, metrics.height)}px`;
    compositionView.style.maxWidth = `${Math.max(1, (state.cols || 1) - Math.floor(x / metrics.width)) * metrics.width}px`;
    compositionView.style.lineHeight = `${metrics.height}px`;
  }

  compositionStart() {
    this.clear();
    this.isComposing = true;
    this.isSendingComposition = false;
    this.manualCommit = false;
    compositionView.classList.add("active");
    this.sync();
  }

  compositionUpdate(event) {
    if (inputDiagnostics.enabled) {
      inputDiagnostics.log("ime_composition_update", {
        data: event.data || "",
        value: input.value,
        selectionStart: input.selectionStart,
        selectionEnd: input.selectionEnd,
      });
    }
    this.pendingComposition = event.data || "";
    compositionView.textContent = `\u200e${event.data || ""}\u200e`;
    this.sync();
  }

  compositionEnd(event) {
    if (inputDiagnostics.enabled) {
      inputDiagnostics.log("ime_composition_end", {
        isComposing: this.isComposing,
        isSendingComposition: this.isSendingComposition,
        value: input.value,
      });
    }
    if (this.manualCommit) {
      this.manualCommit = false;
      return;
    }
    this.isComposing = false;
    this.isSendingComposition = true;
    this.pendingComposition = event.data || this.pendingComposition;
    compositionView.classList.remove("active");
    this.commitTimer = setTimeout(() => this.finishComposition(), 0);
  }

  keyDown(event) {
    const code = eventCode(event);
    if (inputDiagnostics.enabled) {
      inputDiagnostics.log("ime_keydown", {
        key: event.key,
        code,
        keyCode: event.keyCode,
        composing: this.isComposing,
        sending: this.isSendingComposition,
      });
    }
    if (this.commitTimer) this.finishComposition();
    if (this.isComposing) {
      if (code === "Enter") {
        this.commit(true);
        return true;
      }
      return false;
    }
    if (isImeKeyEvent(event)) return false;
    return true;
  }

  keyUp() {
  }

  inputEvent(event) {
    if (inputDiagnostics.enabled) {
      inputDiagnostics.log("ime_input", {
        inputType: event.inputType,
        data: event.data,
        composing: this.isComposing,
        sending: this.isSendingComposition,
      });
    }
    if (this.isComposing || this.isSendingComposition) return;
    if (event.inputType?.endsWith("Backward")) {
      sendSoftKey("Backspace", "Backspace");
    } else if (event.inputType?.endsWith("Forward")) {
      sendSoftKey("Delete", "Delete");
    } else if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") {
      sendSoftKey("Enter", "Enter");
    } else {
      this.emit(event.data || input.value);
    }
    this.clear();
  }

  commit(manual = false) {
    if (this.isComposing) {
      this.manualCommit = manual;
      this.pendingComposition = input.value || this.pendingComposition;
      this.isComposing = false;
      this.isSendingComposition = true;
    }
    this.finishComposition();
  }

  finishComposition() {
    clearTimeout(this.commitTimer);
    this.commitTimer = 0;
    if (!this.isSendingComposition) return;
    this.isSendingComposition = false;
    this.emit(input.value || this.pendingComposition);
    this.clear();
  }
}

const terminalInput = new TerminalInput();
coarsePointer.addEventListener("change", () => {
  terminalInput.resetGeometry();
  if (terminalInput.isComposing) terminalInput.sync();
});

function focusTerminalInput() {
  input.focus({ preventScroll: true });
  terminalInput.sync();
}

function restoreTerminalInputFocus() {
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (softkeys.contains(active) || inputDebugPanel?.contains(active)) return;
    focusTerminalInput();
  });
}

function setSoftModifiers(value) {
  softModifiers = value;
  softkeys.querySelectorAll("[data-mod]").forEach((button) => {
    button.setAttribute("aria-pressed", (value & Number(button.dataset.mod)) !== 0);
  });
}

function clearSoftModifiers() {
  setSoftModifiers(0);
}

function characterCode(character) {
  if (/^[A-Za-z]$/.test(character)) return `Key${character.toUpperCase()}`;
  if (/^[0-9]$/.test(character)) return `Digit${character}`;
  if (character === " ") return "Space";
  return "Unidentified";
}

function sendSoftKey(code, key) {
  const mods = softModifiers;
  const shifted = (mods & 1) && /^[a-z]$/.test(key);
  if (shifted) key = key.toUpperCase();
  const codepoint = key.codePointAt(0);
  const printable = codepoint !== undefined && key.length === (codepoint > 0xffff ? 2 : 1);
  sendEncodedKey(code, key, 1, mods, printable && (mods & 1));
  sendEncodedKey(code, key, 0, mods, printable && (mods & 1));
  clearSoftModifiers();
}

function sendCommittedText(text) {
  if (!softModifiers) {
    sendText(text);
    return;
  }
  if (!text) return;
  const codepoint = text.codePointAt(0);
  const firstLength = codepoint > 0xffff ? 2 : 1;
  let first = text.slice(0, firstLength);
  const mods = softModifiers;
  if ((mods & 1) && /^[a-z]$/.test(first)) first = first.toUpperCase();
  const printable = first.length === (first.codePointAt(0) > 0xffff ? 2 : 1);
  sendEncodedKey(characterCode(first), first, 1, mods, printable && (mods & 1));
  sendEncodedKey(characterCode(first), first, 0, mods, printable && (mods & 1));
  clearSoftModifiers();
  if (text.length > firstLength) sendText(text.slice(firstLength));
}

function mouseButton(button) {
  if (button === 0) return 1;
  if (button === 2) return 2;
  if (button === 1) return 3;
  return 0xff;
}

function sendMouse(event, action, button) {
  const rect = scroll.getBoundingClientRect();
  const x = Math.max(0, event.clientX - rect.left);
  const y = Math.max(0, event.clientY - rect.top);
  return wasm.term_mouse(action, button, modifierBits(event), x, y, event.buttons !== 0 ? 1 : 0) === 1;
}

function sendResize() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  resizeView.setUint16(4, state.cols, true);
  resizeView.setUint16(6, state.rows, true);
  socket.send(resizeMessage);
}

function resizeTerminal(pixelViewport = nativePixelViewport()) {
  renderer.resize(pixelViewport.width, pixelViewport.height);
  const size = dimensions();
  state.cols = size.cols;
  state.rows = size.rows;
  wasm.term_resize(size.cols, size.rows, Math.ceil(metrics.width), Math.ceil(metrics.height));
  sendResize();
  scheduleFrame();
}

let latestPixelViewport = initialPixelViewport;
const screenResizeObserver = new ResizeObserver((entries) => {
  latestPixelViewport = nativePixelViewport(entries[0]);
  if (resizePending) return;
  resizePending = true;
  requestAnimationFrame(() => {
    resizePending = false;
    resizeTerminal(latestPixelViewport);
  });
});
try {
  screenResizeObserver.observe(screen, { box: "device-pixel-content-box" });
} catch {
  screenResizeObserver.observe(screen);
}

scroll.addEventListener("scroll", () => {
  if (suppressScroll) return;
  const row = Math.max(0, Math.round(scroll.scrollTop / metrics.height));
  if (wasm.term_scroll_row(row) === 1) scheduleFrame(true);
}, { passive: true });

scroll.addEventListener("pointerdown", (event) => {
  if (event.pointerType !== "touch") focusTerminalInput();
  const button = mouseButton(event.button);
  const encoded = sendMouse(event, 0, button);
  encodedRightClick = button === 2 && encoded;
  if (encoded && event.pointerType !== "touch") {
    event.preventDefault();
    scroll.setPointerCapture(event.pointerId);
  }
}, { passive: false });
scroll.addEventListener("pointerup", (event) => {
  const encoded = sendMouse(event, 1, mouseButton(event.button));
  if (encoded && event.pointerType !== "touch") event.preventDefault();
}, { passive: false });
scroll.addEventListener("pointermove", (event) => {
  const encoded = sendMouse(event, 2, 0xff);
  if (encoded && event.pointerType !== "touch") event.preventDefault();
}, { passive: false });
scroll.addEventListener("wheel", (event) => {
  if (event.deltaY === 0) return;
  if (sendMouse(event, 0, event.deltaY < 0 ? 4 : 5)) event.preventDefault();
}, { passive: false });
scroll.addEventListener("contextmenu", (event) => {
  if (!encodedRightClick) return;
  encodedRightClick = false;
  event.preventDefault();
});

terminal.addEventListener("pointerdown", (event) => {
  if (scroll.contains(event.target) || softkeys.contains(event.target) || inputDebugPanel?.contains(event.target)) return;
  if (event.pointerType !== "touch") focusTerminalInput();
});
terminal.addEventListener("click", (event) => {
  if (event.target === input) return;
  if (!scroll.contains(event.target) || softkeys.contains(event.target) || inputDebugPanel?.contains(event.target)) return;
  event.preventDefault();
  focusTerminalInput();
});
input.addEventListener("keydown", async (event) => {
  if (!terminalInput.keyDown(event)) return;
  const code = eventCode(event);
  if (event.ctrlKey && event.shiftKey && event.code === "KeyV") {
    event.preventDefault();
    sendText(await navigator.clipboard.readText(), true);
    return;
  }
  event.preventDefault();
  sendKey(event, event.repeat ? 2 : 1);
  if (code === "Enter" || (event.ctrlKey && code === "KeyC")) {
    terminalInput.clear();
  }
});
input.addEventListener("keyup", (event) => {
  terminalInput.keyUp();
  if (event.isComposing || isImeKeyEvent(event)) return;
  sendKey(event, 0);
});
input.addEventListener("compositionstart", () => terminalInput.compositionStart());
input.addEventListener("compositionupdate", (event) => terminalInput.compositionUpdate(event));
input.addEventListener("compositionend", (event) => terminalInput.compositionEnd(event));
input.addEventListener("input", (event) => terminalInput.inputEvent(event));
input.addEventListener("paste", (event) => {
  event.preventDefault();
  sendText(event.clipboardData.getData("text/plain"), true);
  terminalInput.clear();
});
input.addEventListener("focus", () => {
  terminalInput.sync();
});
softkeys.addEventListener("pointerdown", (event) => {
  const button = event.target.closest("button");
  if (button && softkeys.contains(button)) event.preventDefault();
});
softkeys.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || !softkeys.contains(button)) return;
  if (button.dataset.mod) {
    setSoftModifiers(softModifiers ^ Number(button.dataset.mod));
  } else {
    if (terminalInput.isComposing || terminalInput.isSendingComposition) {
      terminalInput.commit(true);
    }
    sendSoftKey(button.dataset.code, button.dataset.key);
  }
  focusTerminalInput();
});
window.addEventListener("focus", () => {
  wasm.term_focus(1);
  restoreTerminalInputFocus();
});
window.addEventListener("blur", () => wasm.term_focus(0));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    wasm.term_focus(1);
    restoreTerminalInputFocus();
    scheduleFrame();
  }
});
window.addEventListener("pagehide", () => socket?.close());

window.bcwebmux = {
  get connected() { return state.connected; },
  get state() { return { ...state, ...renderer.stats }; },
  get inputTrace() { return inputDiagnostics.text(); },
  write(text) { sendText(text); },
  paste(text) { sendText(text, true); },
};
if (new URLSearchParams(location.search).has("gpu-test")) {
  window.bcwebmux.readPixels = () => renderer.readPixels();
}
