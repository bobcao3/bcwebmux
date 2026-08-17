// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { GpuTerminal } from "./gpu.js";
import { TerminalTextView } from "./text-view.js";
import { Decompress } from "/fzstd.js";
import { initializeSettings } from "./settings.js";

const terminal = document.querySelector("#terminal");
const terminalViewport = document.querySelector("#terminal-viewport");
const selectionButton = document.querySelector("#selection-button");
const perf = document.querySelector("#perf");
const scroll = document.querySelector("#scroll");
const spacer = document.querySelector("#spacer");
const textView = document.querySelector("#text-view");
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
const strictDecoder = new TextDecoder("utf-8", { fatal: true });
const settings = initializeSettings();
const requestedRenderer = new URLSearchParams(location.search).get("renderer");
const textRenderer = requestedRenderer === "kb-canvas" ? "kb-canvas" : settings.renderer;
let activeTextRenderer = textRenderer;
const resizeMessage = new Uint8Array(12);
const resizeView = new DataView(resizeMessage.buffer);
resizeView.setUint32(0, 0x52574342, true);
const state = {
  connected: false,
  selectionMode: false,
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
let fontChangeGeneration = 0;
let framePending = false;
let frameDirty = false;
let submittedSinceAnimationFrame = false;
let resizePending = false;
let reconnectDelay = 250;
let openedOnce = false;
let softModifiers = 0;
let suppressScroll = false;
let latestScrollTotal = 0;
let latestScrollLength = 0;
let encodedRightClick = false;
let activeMouseGesture = null;
let touchCandidate = null;
const touchMoveThreshold = 8;
const touchLongPressThreshold = 400;
const suppressedMousePointerUps = new Set();
const suppressedShortcutKeyUps = new Set();
let pendingRxAt = 0;
let pendingInputAt = 0;
let rttProbeSequence = 0;
const outstandingRttProbes = new Map();
const rttSamples = [];
let selectionMode = false;
let restoreInputFocus = false;
const frozenMessages = [];
let frozenBytes = 0;
let flushingFrozenMessages = false;
const frozenOutputLimit = 4 * 1024 * 1024;
const terminalTextView = new TerminalTextView(textView, {
  setSelection(start, end) {
    const handled = wasm.term_selection_set_range(start.row, start.col, end.row, end.col) === 1;
    if (handled) scheduleFrame(true);
    return handled;
  },
  clearSelection() {
    if (!wasm) return false;
    const handled = wasm.term_selection_clear() === 1;
    if (handled) scheduleFrame(true);
    return handled;
  },
  selectionText() {
    return getSelectedText();
  },
});

function loadTerminalFonts(font) {
  const loads = [
    document.fonts.load(`normal 400 ${font.size}px "${font.cssFamily}"`),
    document.fonts.load(`normal 700 ${font.size}px "${font.cssFamily}"`),
    document.fonts.load(`italic 400 ${font.size}px "${font.cssFamily}"`),
    document.fonts.load(`italic 700 ${font.size}px "${font.cssFamily}"`),
  ];
  if (font.fallbacks?.some((fallback) => /noto emoji/i.test(fallback))) {
    loads.push(document.fonts.load(`normal 400 ${font.size}px "Noto Emoji"`, "😀"));
  }
  return loads;
}

await Promise.all(loadTerminalFonts(settings.font));
await document.fonts.ready;
const measuredMetrics = measureCells();
const cssCellMetrics = { ...measuredMetrics };
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
    gpu_text_backend() {
      return textRenderer === "kb-canvas" ? 1 : 0;
    },
    gpu_init(cellPtr, cellLen, grainPtr, grainLen, grainSize, maxCells, maxGlyphs, atlasSlots, cellSize) {
      try {
        const memory = wasm.memory.buffer;
        const cellSource = decoder.decode(new Uint8Array(memory, cellPtr, cellLen));
        const grain = new Int8Array(memory, grainPtr, grainLen);
        return renderer.initialize(cellSource, grain, grainSize, maxCells, maxGlyphs, atlasSlots, cellSize);
      } catch (error) {
        console.error(error);
        return 0;
      }
    },
    gpu_glyph_canvas_batch(requestsPtr, requestCount, textPtr, textLen) {
      try {
        const memory = wasm.memory.buffer;
        if (!Number.isSafeInteger(requestCount) || requestCount < 0 ||
            !Number.isSafeInteger(requestsPtr) || requestsPtr < 0 ||
            requestsPtr > memory.byteLength ||
            requestCount > Math.floor((memory.byteLength - requestsPtr) / 24)) {
          throw new Error("invalid glyph canvas batch request count");
        }
        if (!Number.isSafeInteger(textPtr) || textPtr < 0 ||
            !Number.isSafeInteger(textLen) || textLen < 0 ||
            textPtr > memory.byteLength ||
            textLen > memory.byteLength - textPtr) {
          throw new Error("invalid glyph canvas batch text block");
        }
        const requests = new DataView(memory, requestsPtr, requestCount * 24);
        const textBlock = new Uint8Array(memory, textPtr, textLen);
        for (let index = 0; index < requestCount; index += 1) {
          const offset = requests.getUint32(index * 24 + 12, true);
          const length = requests.getUint32(index * 24 + 16, true);
          if (offset > textLen || length > textLen - offset) {
            throw new Error("invalid glyph canvas batch text range");
          }
          if (renderer.glyphCanvasRun(
            requests.getUint32(index * 24, true),
            requests.getUint32(index * 24 + 4, true),
            requests.getUint32(index * 24 + 8, true),
            strictDecoder.decode(textBlock.subarray(offset, offset + length)),
            requests.getUint32(index * 24 + 20, true),
          ) !== 1) {
            throw new Error("glyph canvas batch failed");
          }
        }
        return 1;
      } catch (error) {
        console.error(error);
        return 0;
      }
    },
    gpu_glyph_bitmap(slot, pixelsPtr, width, height, stride) {
      try {
        const pixels = new Uint8Array(wasm.memory.buffer, pixelsPtr, stride * height);
        return renderer.glyphBitmap(slot, pixels, width, height, stride);
      } catch (error) {
        console.error(error);
        return 0;
      }
    },
    gpu_submit(framePtr, cellsPtr, textRowsPtr, textCellsPtr, textBytesPtr, textBytesLen, textChanged) {
      try {
        const metadata = submitGpuFrame(framePtr, cellsPtr);
        terminalTextView.update(
          wasm.memory.buffer,
          metadata,
          textRowsPtr,
          textCellsPtr,
          textBytesPtr,
          textBytesLen,
          textChanged !== 0,
        );
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

const initialPixelViewport = nativePixelViewport();
let latestPixelViewport = initialPixelViewport;
const initialLayout = physicalLayout(initialPixelViewport);
const initial = { cols: initialLayout.cols, rows: initialLayout.rows };
settings.setOnChange(applyColorProfile);
settings.setOnFontChange(applyFontSettings);
settings.setOnPerfChange(applyPerfMode);
settings.setOnRendererChange(applyTextRenderer);
try {
  renderer = await GpuTerminal.create(screen, initialPixelViewport, textRenderer);
  renderer.setPhysicalCellMetrics(
    initialLayout.cellWidth,
    initialLayout.cellHeight,
    initialLayout.fontSize,
  );
} catch (error) {
  setConnectionStatus(false, error.message || "gpu error");
  throw error;
}
const result = await WebAssembly.instantiateStreaming(fetch("/terminal.wasm"), imports);
wasm = result.instance.exports;
if (wasm.term_init(initial.cols, initial.rows) !== 1) throw new Error("terminal initialization failed");
resizeTerminal();
applyColorProfile(settings.profile);
await applyFontSettings(settings.font);
applyPerfMode(settings.perfMode);
connect();
scheduleFrame();
updateTelemetry();
setInterval(updateTelemetry, 250);
setInterval(sendRttProbe, 1000);

function measureCells() {
  const probe = document.createElement("span");
  probe.textContent = "MMMMMMMMMM";
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font:inherit";
  terminalViewport.append(probe);
  const rect = probe.getBoundingClientRect();
  probe.remove();
  const width = Math.max(1, rect.width / 10);
  const height = Math.max(1, rect.height);
  return { width, height };
}

function dimensions() {
  const { cols, rows } = physicalLayout(latestPixelViewport ?? nativePixelViewport());
  return { cols, rows };
}

function physicalLayout(pixelViewport) {
  const scaleX = pixelViewport.width / Math.max(1, screen.clientWidth);
  const scaleY = pixelViewport.height / Math.max(1, screen.clientHeight);
  const cellWidth = Math.max(1, Math.min(pixelViewport.width, Math.round(measuredMetrics.width * scaleX)));
  const cellHeight = Math.max(1, Math.min(pixelViewport.height, Math.round(measuredMetrics.height * scaleY)));
  const fontSize = Math.max(1, Math.round(parseFloat(getComputedStyle(terminal).fontSize) * scaleY));
  const cols = Math.max(1, Math.floor(pixelViewport.width / cellWidth));
  const rows = Math.max(1, Math.floor(pixelViewport.height / cellHeight));
  if (cols * cellWidth > pixelViewport.width || rows * cellHeight > pixelViewport.height) {
    throw new Error("physical layout exceeds viewport");
  }
  return { cols, rows, cellWidth, cellHeight, fontSize, scaleX, scaleY };
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
  latestScrollTotal = metadata.scrollTotal;
  latestScrollLength = metadata.scrollLength;
  spacer.style.height = `${Math.max(metadata.scrollTotal, metadata.scrollLength) * cssCellMetrics.height}px`;
  const logicalBottom = Math.max(0, metadata.scrollTotal - metadata.scrollLength);
  const targetScroll = metadata.scrollOffset >= logicalBottom
    ? Math.max(0, scroll.scrollHeight - scroll.clientHeight)
    : metadata.scrollOffset * cssCellMetrics.height;
  if (Math.abs(scroll.scrollTop - targetScroll) > 0.5) {
    suppressScroll = true;
    scroll.scrollTop = targetScroll;
    queueMicrotask(() => {
      suppressScroll = false;
    });
  }
  terminalInput.sync();
  state.frames += 1;
  return metadata;
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

function packedColor(color) {
  return Number.parseInt(color.slice(1), 16) >>> 0;
}

function applyColorProfile(profile) {
  if (!wasm) return;
  const colors = [profile.background, profile.foreground, ...profile.ansi];
  const view = new DataView(wasm.memory.buffer);
  const ptr = wasm.term_theme_ptr();
  colors.forEach((color, index) => {
    view.setUint32(ptr + index * 4, packedColor(color), true);
  });
  const result = wasm.term_apply_theme();
  if (result !== 1) throw new Error(`WASM theme application failed: ${result}`);
  scheduleFrame(true);
}

function applyTextRenderer(rendererName) {
  if (!wasm || !renderer) {
    location.reload();
    return;
  }
  const mode = rendererName === "kb-canvas" ? 1 : 0;
  const result = wasm.term_set_renderer(mode);
  if (result !== 1) {
    setConnectionStatus(false, `WASM renderer configuration failed: ${result}`);
    throw new Error(`WASM renderer configuration failed: ${result}`);
  }
  renderer.setTextRenderer(rendererName);
  activeTextRenderer = rendererName;
  reloadRendererFont();
  scheduleFrame(true);
}

function reloadRendererFont() {
  renderer.reloadFont(getComputedStyle(terminal).fontFamily);
  wasm.term_invalidate_glyph_cache();
}

async function configureWasmFont(font) {
  if (font.canvasOnly && activeTextRenderer !== "kb-canvas") {
    throw new Error("Canvas-only font requires the kb-canvas renderer");
  }
  if (wasm.term_set_font(font.wasmId, font.ligatures ? 1 : 0) !== 1) {
    throw new Error("WASM font configuration failed");
  }
}

async function applyFontSettings(font) {
  const generation = ++fontChangeGeneration;
  try {
    await Promise.all(loadTerminalFonts(font));
    await document.fonts.ready;
    if (generation !== fontChangeGeneration) return;
    await configureWasmFont(font);
    if (generation !== fontChangeGeneration) return;
    Object.assign(measuredMetrics, measureCells());
    resizeTerminal(latestPixelViewport);
    reloadRendererFont();
    scheduleFrame(true);
  } catch (error) {
    if (generation === fontChangeGeneration) {
      try {
        reloadRendererFont();
      } catch {}
      scheduleFrame(true);
      setConnectionStatus(false, error.message || "font error");
    }
  }
}

function applyPerfMode(mode) {
  const normalized = ["off", "simple", "detailed"].includes(mode) ? mode : "detailed";
  perf.dataset.mode = normalized;
  perf.hidden = normalized === "off";
  if (renderer) updateTelemetry();
}

function updateTelemetry() {
  const mode = perf.dataset.mode || "detailed";
  if (mode === "off") return;
  const stats = renderer.stats;
  const atlasUsed = stats.atlasGlyphs ?? 0;
  const atlasCapacity = stats.atlasCapacity ?? 0;
  const atlasPercent = atlasCapacity ? Math.round(atlasUsed * 100 / atlasCapacity) : 0;
  const cacheHits = stats.cacheHits ?? 0;
  const cacheMisses = stats.cacheMisses ?? 0;
  const line = mode === "simple"
    ? `R: ${formatBytes(state.rxWireBytes)} · S: ${formatBytes(state.txBytes)} · WS RTT: ${formatMs(state.wsRttLatestMs)} ms · WASM: ${formatMs(state.wasmFrameMs)} ms`
    : [
    `WASM frame: ${formatMs(state.wasmFrameMs)} ms · parse: ${formatMs(state.wasmParseMs)} ms`,
    `GPU submit: ${formatMs(stats.frameMs)} ms · presentation opportunity: ${formatMs(stats.presentationOpportunityMs)} ms`,
    `Queue drain: ${formatMs(stats.queueDrainMs)} ms`,
    `Socket → frame: ${formatMs(state.rxLatencyMs)} ms · Input → echo frame: ${formatMs(state.inputLatencyMs)} ms`,
    `WebSocket RTT latest / median / p95: ${formatMs(state.wsRttLatestMs)} / ${formatMs(state.wsRttMedianMs)} / ${formatMs(state.wsRttP95Ms)} ms`,
    `Viewport: ${state.cols} × ${state.rows} · cell: ${stats.physicalCellWidth}x${stats.physicalCellHeight} px · font: ${stats.physicalFontSize} px · Glyph atlas: ${atlasUsed} / ${atlasCapacity} (${atlasPercent}%) · cache: ${cacheHits} hit / ${cacheMisses} miss`,
    `Network received: ${formatBytes(state.rxBytes)} decoded · wire: ${formatBytes(state.rxWireBytes)} · compression: ${formatCompressionRatio(state.rxBytes, state.rxWireBytes)} · sent: ${formatBytes(state.txBytes)}`,
  ].join("\n");
  perf.value = line;
  const description = `WASM frame ${formatMs(state.wasmFrameMs)} ms; WASM parse ${formatMs(state.wasmParseMs)} ms; presentation opportunity ${formatMs(stats.presentationOpportunityMs)} ms; queue drain ${formatMs(stats.queueDrainMs)} ms; Socket → frame ${formatMs(state.rxLatencyMs)} ms; Input → echo frame ${formatMs(state.inputLatencyMs)} ms; WebSocket RTT latest / median / p95 ${formatMs(state.wsRttLatestMs)} / ${formatMs(state.wsRttMedianMs)} / ${formatMs(state.wsRttP95Ms)} ms; terminal ${state.cols} by ${state.rows}; atlas ${atlasUsed} of ${atlasCapacity} (${atlasPercent}%); down ${formatBytes(state.rxBytes)} decoded, ${formatBytes(state.rxWireBytes)} wire (${formatCompressionRatio(state.rxBytes, state.rxWireBytes)}), up ${formatBytes(state.txBytes)}; CPU submit ${formatMs(stats.frameMs)} ms; canvas ${screen.width} by ${screen.height} pixels`;
  perf.title = description;
  perf.setAttribute("aria-label", description);
}

function feedOutputChunk(chunk) {
  const ptr = wasm.term_reserve(chunk.length);
  if (!ptr) throw new Error("WASM receive buffer exhausted");
  new Uint8Array(wasm.memory.buffer, ptr, chunk.length).set(chunk);
  const parseStartedAt = performance.now();
  wasm.term_feed(chunk.length);
  sampleMetric("wasmParseMs", performance.now() - parseStartedAt);
  state.rxBytes += chunk.length;
  if (!flushingFrozenMessages) scheduleFrame(true);
}

function processBinaryOutput(message) {
  if (!outputDecoder) return;
  if (!pendingRxAt) pendingRxAt = performance.now();
  try {
    outputDecoder.push(new Uint8Array(message), false);
  } catch {
    setConnectionStatus(false, "compression error");
    socket.close();
  }
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
    decoder.ondata = feedOutputChunk;
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
    terminalFocus.windowFocus();
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
    state.rxWireBytes += event.data.byteLength;
    if (selectionMode) {
      frozenMessages.push(event.data);
      frozenBytes += event.data.byteLength;
      if (frozenBytes > frozenOutputLimit) {
        exitSelectionMode({ restoreFocus: false });
      }
      return;
    }
    processBinaryOutput(event.data);
  });
  socket.addEventListener("close", () => {
    state.connected = false;
    if (selectionMode) {
      exitSelectionMode({ flush: false, restoreFocus: false });
    } else {
      discardFrozenMessages();
    }
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
  heldHardwareModifiers = 0;

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

  discardBufferedComposition() {
    clearTimeout(this.commitTimer);
    this.commitTimer = 0;
    this.isComposing = false;
    this.isSendingComposition = false;
    this.manualCommit = false;
    this.pendingComposition = "";
    input.value = "";
    compositionView.textContent = "";
    compositionView.classList.remove("active");
    this.resetGeometry();
  }

  updateHardwareModifiers(event) {
    // Keep Android's virtual-keyboard Shift under IME control; changing inputMode retracts it.
    const modifiers = modifierBits(event) & 0x0e;
    const wasHeld = this.heldHardwareModifiers !== 0;
    const isHeld = modifiers !== 0;
    if (isHeld && !wasHeld) this.discardBufferedComposition();
    if (isHeld !== wasHeld) input.inputMode = isHeld ? "none" : "text";
    this.heldHardwareModifiers = modifiers;
  }

  releaseModifiers() {
    this.heldHardwareModifiers = 0;
    input.inputMode = "text";
  }

  sync() {
    if (!this.isComposing) return;
    const x = Math.max(0, renderer.cursorX === 0xffff ? 0 : renderer.cursorX) * cssCellMetrics.width;
    const y = Math.max(0, renderer.cursorY === 0xffff ? 0 : renderer.cursorY) * cssCellMetrics.height;
    if (coarsePointer.matches) {
      input.style.paddingLeft = `${x}px`;
      input.style.paddingTop = `${y}px`;
      input.style.lineHeight = `${cssCellMetrics.height}px`;
    } else {
      input.style.left = `${x}px`;
      input.style.top = `${y}px`;
      input.style.width = `${Math.max(1, cssCellMetrics.width)}px`;
      input.style.height = `${Math.max(1, cssCellMetrics.height)}px`;
      input.style.lineHeight = `${cssCellMetrics.height}px`;
    }
    compositionView.style.left = `${x}px`;
    compositionView.style.top = `${y}px`;
    compositionView.style.width = `${Math.max(1, Math.min(state.cols || 1, compositionView.textContent.length || 1)) * cssCellMetrics.width}px`;
    compositionView.style.height = `${Math.max(1, cssCellMetrics.height)}px`;
    compositionView.style.maxWidth = `${Math.max(1, (state.cols || 1) - Math.floor(x / cssCellMetrics.width)) * cssCellMetrics.width}px`;
    compositionView.style.lineHeight = `${cssCellMetrics.height}px`;
  }

  compositionStart() {
    if (this.heldHardwareModifiers) {
      this.discardBufferedComposition();
      return;
    }
    this.clear();
    this.isComposing = true;
    this.isSendingComposition = false;
    this.manualCommit = false;
    compositionView.classList.add("active");
    this.sync();
  }

  compositionUpdate(event) {
    if (this.heldHardwareModifiers || !this.isComposing) {
      this.discardBufferedComposition();
      return;
    }
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
    if (this.heldHardwareModifiers) {
      this.discardBufferedComposition();
      return;
    }
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
    if (!this.isComposing) {
      this.discardBufferedComposition();
      return;
    }
    this.isComposing = false;
    this.isSendingComposition = true;
    this.pendingComposition = event.data || this.pendingComposition;
    compositionView.classList.remove("active");
    this.commitTimer = setTimeout(() => this.finishComposition(), 0);
  }

  keyDown(event) {
    this.updateHardwareModifiers(event);
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
    if (this.heldHardwareModifiers) {
      this.discardBufferedComposition();
      return true;
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

  keyUp(event) {
    this.updateHardwareModifiers(event);
  }

  beforeInput(event) {
    const compositionEvent = event.isComposing || event.inputType?.includes("Composition");
    if (this.heldHardwareModifiers || (compositionEvent && !this.isComposing && !this.isSendingComposition)) {
      if (event.cancelable) event.preventDefault();
      this.discardBufferedComposition();
    }
  }

  inputEvent(event) {
    const compositionEvent = event.isComposing || event.inputType?.includes("Composition");
    if (this.heldHardwareModifiers || (compositionEvent && !this.isComposing && !this.isSendingComposition)) {
      this.discardBufferedComposition();
      return;
    }
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
class TerminalFocusController {
  suspended = false;

  focus() {
    if (this.suspended || document.hidden || terminalTextView.hasSelection()) return;
    input.focus({ preventScroll: true });
    terminalInput.sync();
    if (wasm && document.hasFocus()) wasm.term_focus(1);
  }

  restore() {
    if (terminalTextView.hasSelection()) return;
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active !== input && active !== document.body && active !== document.documentElement) return;
      this.focus();
    });
  }

  suspend() {
    this.suspended = true;
    if (document.activeElement === input) input.blur();
    if (wasm) wasm.term_focus(0);
  }

  resume() {
    this.suspended = false;
    if (wasm) wasm.term_focus(document.hasFocus() ? 1 : 0);
  }

  windowFocus() {
    if (wasm) wasm.term_focus(this.suspended ? 0 : 1);
    this.restore();
  }

  windowBlur() {
    terminalInput.releaseModifiers();
    if (wasm) wasm.term_focus(0);
  }
}

const terminalFocus = new TerminalFocusController();
settings.setLifecycle({
  onOpen: () => terminalFocus.suspend(),
  onClose: () => terminalFocus.resume(),
});
coarsePointer.addEventListener("change", () => {
  if (!coarsePointer.matches && selectionMode) {
    exitSelectionMode({ restoreFocus: false });
  }
  terminalInput.resetGeometry();
  if (terminalInput.isComposing) terminalInput.sync();
});

function updateSelectionModeUi() {
  terminal.classList.toggle("selection-mode", selectionMode);
  state.selectionMode = selectionMode;
  selectionButton?.setAttribute("aria-pressed", String(selectionMode));
  selectionButton?.setAttribute("aria-label", selectionMode
    ? "Exit selection mode"
    : "Enter selection mode");
  selectionButton?.setAttribute("title", selectionMode
    ? "Resume live terminal"
    : "Select frozen terminal text");
}

function enterSelectionMode() {
  if (selectionMode || !wasm || !coarsePointer.matches) return false;
  restoreInputFocus = document.activeElement === input;
  touchCandidate = null;
  activeMouseGesture = null;
  clearSoftModifiers();
  selectionMode = true;
  updateSelectionModeUi();
  terminalFocus.suspend();
  terminalTextView.setEnabled(true);
  wasm.term_set_text_view_enabled(1);
  wasm.term_invalidate_text_view();
  scheduleFrame(true);
  return true;
}

function discardFrozenMessages() {
  frozenMessages.splice(0);
  frozenBytes = 0;
}

function flushFrozenMessages() {
  const messages = frozenMessages.splice(0);
  frozenBytes = 0;
  if (!messages.length) return;
  flushingFrozenMessages = true;
  try {
    for (const message of messages) processBinaryOutput(message);
  } finally {
    flushingFrozenMessages = false;
  }
}

function exitSelectionMode({ flush = true, restoreFocus = true } = {}) {
  if (!selectionMode) return false;
  const shouldRestoreFocus = restoreFocus && restoreInputFocus;
  restoreInputFocus = false;
  terminalTextView.clearBrowserSelection(true);
  terminalTextView.setEnabled(false);
  wasm.term_set_text_view_enabled(0);
  selectionMode = false;
  updateSelectionModeUi();
  if (flush) flushFrozenMessages();
  else discardFrozenMessages();
  terminalFocus.resume();
  if (shouldRestoreFocus) terminalFocus.restore();
  scheduleFrame(true);
  return true;
}

updateSelectionModeUi();
selectionButton?.addEventListener("pointerdown", (event) => {
  event.preventDefault();
});
selectionButton?.addEventListener("click", () => {
  if (selectionMode) exitSelectionMode();
  else enterSelectionMode();
});

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

function isTerminalPointer(event) {
  const rect = screen.getBoundingClientRect();
  return event.clientX >= rect.left && event.clientX < rect.right &&
    event.clientY >= rect.top && event.clientY < rect.bottom;
}

function sendMouse(event, action, button, anyButtonPressed = event.buttons !== 0) {
  const rect = scroll.getBoundingClientRect();
  const x = Math.max(0, event.clientX - rect.left) * renderer.pixelScaleX;
  const y = Math.max(0, event.clientY - rect.top) * renderer.pixelScaleY;
  return wasm.term_mouse(action, button, modifierBits(event), x, y, anyButtonPressed ? 1 : 0) === 1;
}

function sendSelection(event, action) {
  const rect = scroll.getBoundingClientRect();
  const x = Math.max(0, event.clientX - rect.left) * renderer.pixelScaleX;
  const y = Math.max(0, event.clientY - rect.top) * renderer.pixelScaleY;
  const handled = wasm.term_selection(action, x, y) === 1;
  if (handled) scheduleFrame(true);
  return handled;
}

function getSelectedText() {
  const status = wasm.term_selection_snapshot();
  if (status === 0) return null;
  if (status < 0) throw new Error(`WASM selection snapshot failed: ${status}`);
  try {
    const ptr = wasm.term_selection_snapshot_ptr();
    const len = wasm.term_selection_snapshot_len();
    return strictDecoder.decode(new Uint8Array(wasm.memory.buffer, ptr, len));
  } finally {
    wasm.term_selection_snapshot_release();
  }
}

async function copySelectedText() {
  const text = getSelectedText();
  if (text === null) return false;
  await navigator.clipboard.writeText(text);
  return true;
}

function finishMouseGesture(event, cancelled = false) {
  const gesture = activeMouseGesture;
  if (!gesture || gesture.pointerId !== event.pointerId) return false;
  activeMouseGesture = null;
  if (cancelled) suppressedMousePointerUps.add(gesture.pointerId);
  if (gesture.owner === "terminal") {
    sendMouse(event, 1, gesture.button);
  } else {
    sendSelection(event, cancelled ? 3 : 1);
  }
  if (scroll.hasPointerCapture(event.pointerId)) scroll.releasePointerCapture(event.pointerId);
  return true;
}

function sendResize() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  resizeView.setUint16(4, state.cols, true);
  resizeView.setUint16(6, state.rows, true);
  socket.send(resizeMessage);
}

function resizeTerminal(pixelViewport = nativePixelViewport()) {
  if (selectionMode) exitSelectionMode({ restoreFocus: false });
  const layout = physicalLayout(pixelViewport);
  cssCellMetrics.width = layout.cellWidth / layout.scaleX;
  cssCellMetrics.height = layout.cellHeight / layout.scaleY;
  renderer.setPhysicalCellMetrics(layout.cellWidth, layout.cellHeight, layout.fontSize);
  renderer.resize(pixelViewport.width, pixelViewport.height);
  terminal.style.setProperty("--cell-width", `${cssCellMetrics.width}px`);
  terminal.style.setProperty("--cell-height", `${cssCellMetrics.height}px`);
  state.cols = layout.cols;
  state.rows = layout.rows;
  wasm.term_resize(
    layout.cols,
    layout.rows,
    layout.cellWidth,
    layout.cellHeight,
    layout.cellWidth,
    layout.cellHeight,
    layout.fontSize,
  );
  sendResize();
  scheduleFrame();
}

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
  const atBottom = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 1;
  const row = atBottom
    ? Math.max(0, latestScrollTotal - latestScrollLength)
    : Math.max(0, Math.round(scroll.scrollTop / cssCellMetrics.height));
  if (wasm.term_scroll_row(row) === 1) scheduleFrame(true);
}, { passive: true });

scroll.addEventListener("pointerdown", (event) => {
  if (selectionMode) return;
  if (event.pointerType !== "touch") suppressedMousePointerUps.delete(event.pointerId);
  if (event.pointerType === "touch") {
    if (isTerminalPointer(event)) {
      touchCandidate = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startedAt: Date.now(),
        moved: false,
        ended: false,
        duration: 0,
        suppress: false,
      };
    }
    return;
  }
  if (event.pointerType !== "touch" && !isTerminalPointer(event)) {
    encodedRightClick = false;
    return;
  }
  if (event.pointerType !== "touch" && terminalTextView.hasSelection()) {
    terminalTextView.clearBrowserSelection(true);
  }
  if (event.pointerType !== "touch") terminalFocus.focus();
  if (event.pointerType !== "touch" && activeMouseGesture) {
    event.preventDefault();
    return;
  }
  if (event.pointerType !== "touch" && event.button === 0 && event.shiftKey) {
    encodedRightClick = false;
    if (sendSelection(event, 0)) {
      event.preventDefault();
      activeMouseGesture = { pointerId: event.pointerId, button: 1, owner: "selection" };
      scroll.setPointerCapture(event.pointerId);
    }
    return;
  }
  const button = mouseButton(event.button);
  const encoded = sendMouse(event, 0, button);
  encodedRightClick = button === 2 && encoded;
  if (event.pointerType !== "touch" && encoded) {
    activeMouseGesture = { pointerId: event.pointerId, button, owner: "terminal" };
    event.preventDefault();
    scroll.setPointerCapture(event.pointerId);
  } else if (event.pointerType !== "touch" && event.button === 0 && sendSelection(event, 0)) {
    activeMouseGesture = { pointerId: event.pointerId, button: 1, owner: "selection" };
    event.preventDefault();
    scroll.setPointerCapture(event.pointerId);
  }
}, { passive: false });
scroll.addEventListener("pointerup", (event) => {
  if (selectionMode) return;
  if (event.pointerType === "touch") {
    const candidate = touchCandidate;
    if (candidate?.pointerId === event.pointerId) {
      candidate.ended = true;
      candidate.duration = Date.now() - candidate.startedAt;
      candidate.suppress = candidate.moved || candidate.duration >= touchLongPressThreshold;
    }
    return;
  }
  if (suppressedMousePointerUps.has(event.pointerId)) {
    suppressedMousePointerUps.delete(event.pointerId);
    if (event.pointerType !== "touch") event.preventDefault();
    return;
  }
  if (finishMouseGesture(event)) {
    event.preventDefault();
    return;
  }
  if (event.pointerType !== "touch" && !isTerminalPointer(event)) return;
  const encoded = sendMouse(event, 1, mouseButton(event.button));
  if (encoded && event.pointerType !== "touch") event.preventDefault();
}, { passive: false });
scroll.addEventListener("pointermove", (event) => {
  if (selectionMode) return;
  if (event.pointerType === "touch") {
    if (touchCandidate?.pointerId === event.pointerId) {
      const dx = event.clientX - touchCandidate.startX;
      const dy = event.clientY - touchCandidate.startY;
      if (Math.hypot(dx, dy) > touchMoveThreshold) touchCandidate.moved = true;
    }
    return;
  }
  if (activeMouseGesture &&
      activeMouseGesture.pointerId === event.pointerId &&
      event.pointerType !== "touch") {
    if (activeMouseGesture.owner === "terminal") {
      sendMouse(event, 2, activeMouseGesture.button);
    } else {
      sendSelection(event, 2);
    }
    event.preventDefault();
    return;
  }
  if (event.pointerType !== "touch" && !isTerminalPointer(event)) return;
  const encoded = sendMouse(event, 2, 0xff);
  if (encoded && event.pointerType !== "touch") event.preventDefault();
}, { passive: false });
scroll.addEventListener("pointercancel", (event) => {
  if (selectionMode) return;
  if (event.pointerType === "touch") {
    if (touchCandidate?.pointerId === event.pointerId) touchCandidate = null;
    return;
  }
  if (finishMouseGesture(event, true)) event.preventDefault();
}, { passive: false });
scroll.addEventListener("lostpointercapture", (event) => {
  finishMouseGesture(event, true);
});
scroll.addEventListener("wheel", (event) => {
  if (selectionMode) return;
  if (!isTerminalPointer(event)) return;
  if (event.deltaY === 0) return;
  if (sendMouse(event, 0, event.deltaY < 0 ? 4 : 5)) event.preventDefault();
}, { passive: false });
scroll.addEventListener("contextmenu", (event) => {
  if (selectionMode) return;
  if (!encodedRightClick) return;
  encodedRightClick = false;
  event.preventDefault();
});
scroll.addEventListener("click", (event) => {
  if (selectionMode) return;
  if (terminalTextView.hasSelection()) {
    touchCandidate = null;
    return;
  }
  if (!isTerminalPointer(event)) return;
  if (touchCandidate?.ended) {
    const suppress = touchCandidate.suppress;
    touchCandidate = null;
    if (suppress) return;
    sendMouse(event, 0, 1, true);
    sendMouse(event, 1, 1, false);
  }
  event.preventDefault();
  terminalFocus.focus();
});
input.addEventListener("keydown", async (event) => {
  if (!terminalInput.keyDown(event)) return;
  const code = eventCode(event);
  if (code === "KeyC" && ((event.ctrlKey && event.shiftKey) || event.metaKey)) {
    const selectedText = getSelectedText();
    if (selectedText !== null) {
      event.preventDefault();
      suppressedShortcutKeyUps.add(code);
      try {
        await navigator.clipboard.writeText(selectedText);
      } catch (error) {
        console.error("clipboard copy failed", error);
      }
      return;
    }
  }
  if (event.ctrlKey && event.shiftKey && event.code === "KeyV") {
    event.preventDefault();
    suppressedShortcutKeyUps.add(code);
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
  terminalInput.keyUp(event);
  const code = eventCode(event);
  if (suppressedShortcutKeyUps.delete(code)) return;
  if (event.isComposing || isImeKeyEvent(event)) return;
  sendKey(event, 0);
});
input.addEventListener("beforeinput", (event) => terminalInput.beforeInput(event));
input.addEventListener("compositionstart", () => terminalInput.compositionStart());
input.addEventListener("compositionupdate", (event) => terminalInput.compositionUpdate(event));
input.addEventListener("compositionend", (event) => terminalInput.compositionEnd(event));
input.addEventListener("input", (event) => terminalInput.inputEvent(event));
input.addEventListener("paste", (event) => {
  event.preventDefault();
  sendText(event.clipboardData.getData("text/plain"), true);
  terminalInput.clear();
});
input.addEventListener("copy", (event) => {
  const text = getSelectedText();
  if (text === null) return;
  event.clipboardData.setData("text/plain", text);
  event.preventDefault();
});
input.addEventListener("focus", () => {
  terminalInput.sync();
});
input.addEventListener("blur", () => terminalInput.releaseModifiers());
softkeys.addEventListener("pointerdown", (event) => {
  const button = event.target.closest?.("button");
  if (button) event.preventDefault();
});
softkeys.addEventListener("click", (event) => {
  if (selectionMode) return;
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.mod) {
    setSoftModifiers(softModifiers ^ Number(button.dataset.mod));
  } else {
    if (terminalInput.isComposing || terminalInput.isSendingComposition) {
      terminalInput.commit(true);
    }
    sendSoftKey(button.dataset.code, button.dataset.key);
  }
  terminalFocus.focus();
});
window.addEventListener("focus", () => terminalFocus.windowFocus());
window.addEventListener("blur", () => {
  suppressedShortcutKeyUps.clear();
  terminalFocus.windowBlur();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    terminalFocus.windowFocus();
    scheduleFrame();
  }
});
window.addEventListener("pagehide", () => socket?.close());

window.bcwebmux = {
  get connected() { return state.connected; },
  get selectionMode() { return selectionMode; },
  enterSelectionMode() { return enterSelectionMode(); },
  exitSelectionMode() { return exitSelectionMode(); },
  get state() { return { ...state, ...renderer.stats }; },
  get inputTrace() { return inputDiagnostics.text(); },
  selectionText() { return getSelectedText(); },
  copySelection() { return copySelectedText(); },
  write(text) { sendText(text); },
  paste(text) { sendText(text, true); },
};
if (new URLSearchParams(location.search).has("gpu-test")) {
  window.bcwebmux.readPixels = () => renderer.readPixels();
}
