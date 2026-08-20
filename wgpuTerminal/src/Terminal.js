// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { EventEmitter } from "./common/EventEmitter.js";
import { GpuTerminal } from "./browser/render/webgpu/GpuTerminal.js";
import { TerminalTextView } from "./browser/selection/TerminalTextView.js";
import { TerminalView } from "./browser/TerminalView.js";
import { FrameScheduler } from "./browser/FrameScheduler.js";
import { ViewportController } from "./browser/ViewportController.js";
import {
  FocusController,
  InputController,
  characterCode,
  eventCode,
  isModifierCode,
  modifierBits,
} from "./browser/input/InputController.js";
import { PointerController } from "./browser/input/PointerController.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });
const WASM_STAGING_CAPACITY = 64 * 1024;
const TEXT_STAGING_CHUNK = 48 * 1024;
const COLOR_FIELDS = ["background", "foreground", "surface", "border", "accent", "muted", "success", "danger"];

const DEFAULT_THEME = Object.freeze({
  background: "#0a0c10",
  foreground: "#f0f3f6",
  surface: "#161b22",
  border: "#7a828e",
  accent: "#58a6ff",
  muted: "#9ea7b3",
  success: "#3fb950",
  danger: "#ff6a69",
  ansi: Object.freeze([
    "#0a0c10", "#ff6a69", "#56d364", "#e3b341", "#58a6ff", "#d2a8ff", "#39c5cf", "#b1bac4",
    "#7a828e", "#ff938a", "#6bc46d", "#f2cc60", "#79c0ff", "#d2a8ff", "#56d4dd", "#ffffff",
  ]),
});

const DEFAULT_FONT = Object.freeze({
  id: "jetbrains-mono",
  name: "JetBrains Mono Nerd Font",
  cssFamily: "JetBrains Mono Nerd Font",
  wasmId: 0,
  size: 15,
  ligatures: true,
  fallbacks: Object.freeze([
    "ui-monospace", "Noto Emoji", "SFMono-Regular", "Cascadia Mono", "Noto Sans Mono CJK SC",
    "Noto Sans CJK SC", "Microsoft YaHei UI", "PingFang SC", "Noto Sans Symbols 2", "monospace",
  ]),
});

function listenerError(error) {
  console.error("terminal event listener failed", error);
}

function createEmitter() {
  return new EventEmitter({ onListenerError: listenerError });
}

function packedColor(color) {
  if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) {
    throw new TypeError(`invalid terminal color: ${color}`);
  }
  return Number.parseInt(color.slice(1), 16) >>> 0;
}

function renderFontFamily(families) {
  return families.map((family) => {
    const generic = family.toLowerCase();
    if (generic === "monospace" || generic === "ui-monospace") return generic;
    return `"${family.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }).join(", ");
}

function normalizeFont(font) {
  const value = { ...DEFAULT_FONT, ...(font || {}) };
  value.size = Math.min(32, Math.max(8, Math.round(Number(value.size) || DEFAULT_FONT.size)));
  value.ligatures = value.ligatures !== false;
  value.wasmId = Number.isInteger(value.wasmId) ? value.wasmId : 0;
  value.fallbacks = Array.isArray(value.fallbacks) ? [...value.fallbacks] : [...DEFAULT_FONT.fallbacks];
  if (!value.fallbacks.includes("monospace")) value.fallbacks.push("monospace");
  if (!value.cssFamily) throw new TypeError("terminal font cssFamily is required");
  return value;
}

function loadTerminalFonts(font) {
  const loads = [
    document.fonts.load(`normal 400 ${font.size}px "${font.cssFamily}"`),
    document.fonts.load(`normal 700 ${font.size}px "${font.cssFamily}"`),
    document.fonts.load(`italic 400 ${font.size}px "${font.cssFamily}"`),
    document.fonts.load(`italic 700 ${font.size}px "${font.cssFamily}"`),
  ];
  if (font.fallbacks.some((fallback) => /noto emoji/i.test(fallback))) {
    loads.push(document.fonts.load(`normal 400 ${font.size}px "Noto Emoji"`, "😀"));
  }
  return loads;
}

function normalizeBinary(data) {
  if (typeof data === "string") return encoder.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError("terminal data must be a string, ArrayBuffer, or ArrayBufferView");
}

export class Terminal {
  constructor(options = {}) {
    if (!options || typeof options !== "object") throw new TypeError("terminal options must be an object");
    this.options = {
      wasmUrl: options.wasmUrl || "/terminal.wasm",
      renderer: options.renderer === "kb-canvas" ? "kb-canvas" : "kb-stb",
      font: normalizeFont(options.font),
      theme: options.theme || DEFAULT_THEME,
      grainStrength: Number.isFinite(Number(options.grainStrength)) ? Number(options.grainStrength) : 4,
      elements: options.elements,
      terminalElement: options.terminalElement,
      inputDebug: Boolean(options.inputDebug),
      debugElements: options.debugElements,
      clipboardWrite: options.clipboardWrite,
    };
    this._opened = false;
    this._disposed = false;
    this._opening = null;
    this._addons = new Set();
    this._activeAddons = new Set();
    this._wasm = null;
    this._renderer = null;
    this._view = null;
    this._viewportController = null;
    this._inputController = null;
    this._focusController = null;
    this._pointerController = null;
    this._textView = null;
    this._scheduler = null;
    this._coarsePointer = null;
    this._coarsePointerListener = null;
    this._windowListeners = [];
    this._fontChangeGeneration = 0;
    this._activeTextRenderer = this.options.renderer;
    this._selectionMode = false;
    this._restoreInputFocus = false;
    this._softModifiers = 0;
    this._clipboardWriteQueue = Promise.resolve();
    this._pendingRxAt = 0;
    this._pendingInputAt = 0;
    this._state = {
      selectionMode: false,
      frames: 0,
      rxBytes: 0,
      txBytes: 0,
      cols: 0,
      rows: 0,
      wasmParseMs: null,
      wasmFrameMs: null,
      rxLatencyMs: null,
      inputLatencyMs: null,
    };

    this._dataEmitter = createEmitter();
    this._resizeEmitter = createEmitter();
    this._selectionModeEmitter = createEmitter();
    this._softModifiersEmitter = createEmitter();
    this._titleEmitter = createEmitter();
    this._bellEmitter = createEmitter();
    this._notificationEmitter = createEmitter();
    this._linkEmitter = createEmitter();
    this._errorEmitter = createEmitter();
  }

  get element() { return this._view?.viewport; }
  get screenElement() { return this._view?.screen; }
  get textarea() { return this._view?.input; }
  get cols() { return this._state.cols; }
  get rows() { return this._state.rows; }
  get selectionMode() { return this._selectionMode; }
  get softModifiers() { return this._softModifiers; }
  get isComposing() {
    return Boolean(this._inputController?.isComposing || this._inputController?.isSendingComposition);
  }
  get inputTrace() { return this._inputController?.trace || ""; }
  get state() {
    const snapshot = this._renderer?.initialized ? this._renderer.stats : {};
    Object.assign(snapshot, this._state);
    return snapshot;
  }

  onData(listener) { return this._dataEmitter.event(listener); }
  onResize(listener) { return this._resizeEmitter.event(listener); }
  onSelectionModeChange(listener) { return this._selectionModeEmitter.event(listener); }
  onSoftModifiersChange(listener) { return this._softModifiersEmitter.event(listener); }
  onTitleChange(listener) { return this._titleEmitter.event(listener); }
  onBell(listener) { return this._bellEmitter.event(listener); }
  onNotification(listener) { return this._notificationEmitter.event(listener); }
  onLinkActivate(listener) { return this._linkEmitter.event(listener); }
  onError(listener) { return this._errorEmitter.event(listener); }

  loadAddon(addon) {
    if (!addon || typeof addon.activate !== "function" || typeof addon.dispose !== "function") {
      throw new TypeError("terminal addon must implement activate() and dispose()");
    }
    if (this._disposed) throw new Error("terminal is disposed");
    if (this._addons.has(addon)) return;
    this._addons.add(addon);
    if (this._opened) this._activateAddon(addon);
  }

  _activateAddon(addon) {
    if (this._activeAddons.has(addon)) return;
    addon.activate(this);
    this._activeAddons.add(addon);
  }

  async open(parent) {
    if (this._disposed) throw new Error("terminal is disposed");
    if (this._opened) throw new Error("terminal is already open");
    if (this._opening) return this._opening;
    this._opening = this._open(parent);
    try {
      await this._opening;
      this._opened = true;
      for (const addon of this._addons) this._activateAddon(addon);
      this._scheduler.schedule();
      return this;
    } catch (error) {
      this._errorEmitter.emit(error);
      this._disposeRuntime();
      throw error;
    } finally {
      this._opening = null;
    }
  }

  async _open(parent) {
    if (!(parent instanceof HTMLElement)) throw new TypeError("terminal parent element is required");
    this._view = this.options.elements
      ? TerminalView.hydrate(this.options.elements)
      : TerminalView.create(parent);
    this._terminalElement = this.options.terminalElement || parent;
    this._coarsePointer = window.matchMedia("(hover: none) and (pointer: coarse)");
    this._applyCssTheme(this.options.theme);
    this._applyCssFont(this.options.font);
    await Promise.all(loadTerminalFonts(this.options.font));
    await document.fonts.ready;

    this._scheduler = new FrameScheduler(this);
    this._viewportController = new ViewportController({
      terminalElement: this._terminalElement,
      viewport: this._view.viewport,
      scroll: this._view.scroll,
      spacer: this._view.spacer,
      screen: this._view.screen,
      getWasm: () => this._wasm,
      getRenderer: () => this._renderer,
      getInputController: () => this._inputController,
      onResize: ({ cols, rows }) => {
        this._state.cols = cols;
        this._state.rows = rows;
        this._resizeEmitter.emit({ cols, rows });
      },
      onBeforeResize: () => {
        if (this._selectionMode) this.exitSelectionMode({ restoreFocus: false });
      },
      scheduleFrame: (immediate) => this._scheduler.schedule(immediate),
    });
    const initialPixelViewport = this._viewportController.latestPixelViewport;
    const initialLayout = this._viewportController.physicalLayout(initialPixelViewport);
    this._renderer = await GpuTerminal.create(this._view.screen, initialPixelViewport, this.options.renderer);
    this._renderer.setPhysicalCellMetrics(initialLayout.cellWidth, initialLayout.cellHeight, initialLayout.fontSize);
    this._renderer.setGrainStrength(this.options.grainStrength);

    const imports = this._createWasmImports();
    const result = await WebAssembly.instantiateStreaming(fetch(this.options.wasmUrl), imports);
    this._wasm = result.instance.exports;
    if (this._wasm.term_init(initialLayout.cols, initialLayout.rows) !== 1) {
      throw new Error("terminal initialization failed");
    }

    this._textView = new TerminalTextView(this._view.textView, {
      setSelection: (start, end) => {
        const handled = this._wasm.term_selection_set_range(start.row, start.col, end.row, end.col) === 1;
        if (handled) this._scheduler.schedule(true);
        return handled;
      },
      clearSelection: () => {
        if (!this._wasm) return false;
        const handled = this._wasm.term_selection_clear() === 1;
        if (handled) this._scheduler.schedule(true);
        return handled;
      },
      selectionText: () => this.getSelection(),
    });

    this._inputController = new InputController({
      input: this._view.input,
      compositionView: this._view.composition,
      coarsePointer: this._coarsePointer,
      getRenderer: () => this._renderer,
      getState: () => this._state,
      getCellMetrics: () => this._viewportController.cellMetrics,
      sendCommittedInput: (text) => this._sendCommittedInput(text),
      sendKey: (event, action) => this._sendKey(event, action),
      sendSoftKey: (code, key) => this.sendKey(code, key),
      sendText: (text, paste) => this._input(text, paste),
      getSelectedText: () => this.getSelection(),
      clearActiveSelection: () => this.clearSelection(),
      inputDebug: this.options.inputDebug,
      debugElements: this.options.debugElements,
    });
    this._focusController = new FocusController({
      input: this._view.input,
      inputController: this._inputController,
      textView: this._textView,
      getWasm: () => this._wasm,
    });
    this._pointerController = new PointerController({
      scroll: this._view.scroll,
      screen: this._view.screen,
      getWasm: () => this._wasm,
      getRenderer: () => this._renderer,
      getSelectionMode: () => this._selectionMode,
      textView: this._textView,
      focusController: this._focusController,
      scheduleFrame: (immediate) => this._scheduler.schedule(immediate),
      onLink: (event) => this._linkEmitter.emit(event),
    });

    this._viewportController.resize(initialPixelViewport);
    this.setTheme(this.options.theme);
    await this.setFont(this.options.font);
    this._viewportController.start();
    this._installWindowListeners();
  }

  _createWasmImports() {
    return {
      host: {
        gpu_text_backend: () => this._activeTextRenderer === "kb-canvas" ? 1 : 0,
        gpu_init: (cellPtr, cellLen, grainPtr, grainLen, grainSize, maxCells, maxGlyphs, maxStyles, styleSize, atlasSlots, cellSize) => {
          try {
            const memory = this._wasm.memory.buffer;
            const cellSource = decoder.decode(new Uint8Array(memory, cellPtr, cellLen));
            const grain = new Int8Array(memory, grainPtr, grainLen);
            return this._renderer.initialize(cellSource, grain, grainSize, maxCells, maxGlyphs, maxStyles, styleSize, atlasSlots, cellSize);
          } catch (error) {
            console.error(error);
            this._errorEmitter.emit(error);
            return 0;
          }
        },
        gpu_submit: (submissionPtr) => {
          try {
            const memory = this._wasm.memory.buffer;
            const metadata = this._renderer.submitWasm(memory, submissionPtr);
            this._submitFrameMetadata(metadata);
            this._viewportController.submitFrameMetadata(metadata);
            this._textView?.update(
              memory,
              metadata,
              metadata.textRowsPtr,
              metadata.textCellsPtr,
              metadata.textBytesPtr,
              metadata.textBytesLen,
              metadata.textChanged,
            );
            return 1;
          } catch (error) {
            console.error(error);
            this._errorEmitter.emit(error);
            return 0;
          }
        },
        pty_write: (ptr, len) => {
          if (this._dataEmitter.size === 0) return 0;
          const view = new Uint8Array(this._wasm.memory.buffer, ptr, len);
          if (this._inputController?.diagnostics.enabled) {
            const sample = view.subarray(0, 64);
            this._inputController.diagnostics.log("pty_write", {
              len,
              hex: Array.from(sample, (byte) => byte.toString(16).padStart(2, "0")).join(" "),
              text: decoder.decode(sample),
            });
          }
          if (!this._pendingInputAt) this._pendingInputAt = performance.now();
          this._dataEmitter.emit(view);
          this._state.txBytes += len;
          return 1;
        },
        clipboard_write: (location, ptr, len) => this._clipboardWrite(location, ptr, len),
        set_title: (ptr, len) => {
          const title = decoder.decode(new Uint8Array(this._wasm.memory.buffer, ptr, len));
          this._titleEmitter.emit(title);
        },
        ring_bell: () => this._bellEmitter.emit(),
        desktop_notification: (titlePtr, titleLen, bodyPtr, bodyLen) => {
          const memory = this._wasm.memory.buffer;
          this._notificationEmitter.emit({
            title: decoder.decode(new Uint8Array(memory, titlePtr, titleLen)),
            body: decoder.decode(new Uint8Array(memory, bodyPtr, bodyLen)),
          });
        },
      },
    };
  }

  _clipboardWrite(location, ptr, len) {
    const writer = this.options.clipboardWrite || navigator.clipboard?.writeText?.bind(navigator.clipboard);
    if (location !== 0 || typeof writer !== "function") return 2;
    let text;
    try {
      text = strictDecoder.decode(new Uint8Array(this._wasm.memory.buffer, ptr, len));
    } catch {
      return 4;
    }
    this._clipboardWriteQueue = this._clipboardWriteQueue
      .then(() => writer(text))
      .catch((error) => console.error("clipboard write failed", error));
    return 0;
  }

  _installWindowListeners() {
    const listen = (target, type, listener) => {
      target.addEventListener(type, listener);
      this._windowListeners.push(() => target.removeEventListener(type, listener));
    };
    listen(window, "focus", () => this._focusController.windowFocus());
    listen(window, "blur", () => {
      this._inputController.clearShortcutState();
      this._focusController.windowBlur();
    });
    listen(document, "visibilitychange", () => {
      if (!document.hidden) {
        this._focusController.windowFocus();
        this._scheduler.resume();
      }
    });
    this._coarsePointerListener = () => {
      if (!this._coarsePointer.matches && this._selectionMode) {
        this.exitSelectionMode({ restoreFocus: false });
      }
      this._inputController.resetGeometry();
      if (this._inputController.isComposing) this._inputController.sync();
    };
    this._coarsePointer.addEventListener("change", this._coarsePointerListener);
  }

  _sampleMetric(name, value) {
    if (!Number.isFinite(value)) return;
    this._state[name] = this._state[name] == null ? value : this._state[name] * 0.8 + value * 0.2;
  }

  _renderFrame() {
    if (!this._wasm) return;
    const startedAt = performance.now();
    this._wasm.term_frame();
    this._sampleMetric("wasmFrameMs", performance.now() - startedAt);
  }

  _submitFrameMetadata(metadata) {
    const submittedAt = performance.now();
    if (this._pendingRxAt) {
      this._sampleMetric("rxLatencyMs", submittedAt - this._pendingRxAt);
      this._pendingRxAt = 0;
    }
    if (this._pendingInputAt) {
      this._sampleMetric("inputLatencyMs", submittedAt - this._pendingInputAt);
      this._pendingInputAt = 0;
    }
    this._state.cols = metadata.cols;
    this._state.rows = metadata.rows;
    this._state.frames += 1;
  }

  _applyCssTheme(theme) {
    for (const field of COLOR_FIELDS) {
      if (theme?.[field]) this._terminalElement.style.setProperty(`--color-${field}`, theme[field]);
    }
  }

  _applyCssFont(font) {
    const family = `"${font.cssFamily.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}", ${renderFontFamily(font.fallbacks)}`;
    this._terminalElement.style.setProperty("--terminal-font", family);
    this._terminalElement.style.fontSize = `${font.size}px`;
  }

  setTheme(theme) {
    this.options.theme = theme;
    if (!this._terminalElement) return;
    this._applyCssTheme(theme);
    if (!this._wasm) return;
    const colors = [theme.background, theme.foreground, ...(theme.ansi || [])];
    if (colors.length !== 18) throw new TypeError("terminal theme must provide 16 ANSI colors");
    const view = new DataView(this._wasm.memory.buffer);
    const ptr = this._wasm.term_theme_ptr();
    colors.forEach((color, index) => view.setUint32(ptr + index * 4, packedColor(color), true));
    const result = this._wasm.term_apply_theme();
    if (result !== 1) throw new Error(`WASM theme application failed: ${result}`);
    this._scheduler.schedule(true);
  }

  async setFont(fontOptions) {
    const font = normalizeFont({ ...this.options.font, ...(fontOptions || {}) });
    this.options.font = font;
    if (!this._terminalElement) return;
    const generation = ++this._fontChangeGeneration;
    this._applyCssFont(font);
    try {
      await Promise.all(loadTerminalFonts(font));
      await document.fonts.ready;
      if (generation !== this._fontChangeGeneration || !this._wasm) return;
      if (font.canvasOnly && this._activeTextRenderer !== "kb-canvas") {
        throw new Error("Canvas-only font requires the kb-canvas renderer");
      }
      if (this._wasm.term_set_font(font.wasmId, font.ligatures ? 1 : 0) !== 1) {
        throw new Error("WASM font configuration failed");
      }
      this._viewportController.remeasureCells();
      this._viewportController.resize(this._viewportController.latestPixelViewport);
      this._reloadRendererFont();
      this._scheduler.schedule(true);
    } catch (error) {
      if (generation === this._fontChangeGeneration) {
        try { this._reloadRendererFont(); } catch {}
        this._scheduler.schedule(true);
        this._errorEmitter.emit(error);
      }
      throw error;
    }
  }

  setRenderer(rendererName) {
    const normalized = rendererName === "kb-canvas" ? "kb-canvas" : "kb-stb";
    this.options.renderer = normalized;
    this._activeTextRenderer = normalized;
    if (!this._wasm || !this._renderer) return;
    const result = this._wasm.term_set_renderer(normalized === "kb-canvas" ? 1 : 0);
    if (result !== 1) throw new Error(`WASM renderer configuration failed: ${result}`);
    this._renderer.setTextRenderer(normalized);
    this._reloadRendererFont();
    this._scheduler.schedule(true);
  }

  setGrainStrength(value) {
    const strength = Number(value);
    if (!Number.isFinite(strength) || strength < 0 || strength > 32) {
      throw new TypeError("invalid grain strength");
    }
    this.options.grainStrength = strength;
    this._renderer?.setGrainStrength(strength);
  }

  _reloadRendererFont() {
    if (!this._renderer || !this._wasm) return;
    this._renderer.reloadFont(getComputedStyle(this._terminalElement).fontFamily);
    this._wasm.term_invalidate_glyph_cache();
  }

  write(data) {
    if (!this._wasm) throw new Error("terminal is not open");
    const bytes = normalizeBinary(data);
    if (!bytes.length) return;
    if (!this._pendingRxAt) this._pendingRxAt = performance.now();
    let offset = 0;
    const parseStartedAt = performance.now();
    while (offset < bytes.length) {
      const length = Math.min(WASM_STAGING_CAPACITY, bytes.length - offset);
      const ptr = this._wasm.term_reserve(length);
      if (!ptr) throw new Error("WASM receive buffer exhausted");
      const chunk = offset === 0 && length === bytes.length
        ? bytes
        : bytes.subarray(offset, offset + length);
      new Uint8Array(this._wasm.memory.buffer, ptr, length).set(chunk);
      if (this._wasm.term_feed(length) !== 1) throw new Error("WASM terminal feed failed");
      offset += length;
    }
    this._sampleMetric("wasmParseMs", performance.now() - parseStartedAt);
    this._state.rxBytes += bytes.length;
    this._scheduler.schedule(true);
  }

  _input(text, paste) {
    if (!this._wasm) throw new Error("terminal is not open");
    if (text) this.clearSelection();
    let remaining = String(text ?? "");
    while (remaining.length) {
      const ptr = this._wasm.term_reserve(TEXT_STAGING_CHUNK);
      if (!ptr) throw new Error("WASM staging buffer exhausted");
      const buffer = new Uint8Array(this._wasm.memory.buffer, ptr, TEXT_STAGING_CHUNK);
      const result = encoder.encodeInto(remaining, buffer);
      if (!result.read && !result.written) throw new Error("text encoding made no progress");
      if (this._wasm.term_text(result.written, paste ? 1 : 0) !== 1) {
        throw new Error("WASM text submission failed");
      }
      remaining = result.read < remaining.length ? remaining.slice(result.read) : "";
    }
  }

  input(text, options) {
    this._input(text, options?.paste === true);
  }

  paste(text) {
    this._input(text, true);
  }

  _sendKey(event, action) {
    const code = eventCode(event);
    let key = event.key || "";
    const mods = modifierBits(event) | this._softModifiers;
    if ((this._softModifiers & 1) && /^[a-z]$/.test(key)) key = key.toUpperCase();
    const codepoint = key.codePointAt(0);
    const printable = codepoint !== undefined && key.length === (codepoint > 0xffff ? 2 : 1);
    if (this._inputController?.diagnostics.enabled) {
      this._inputController.diagnostics.log("key_encode", {
        originalCode: event.code,
        originalKey: event.key,
        originalKeyCode: event.keyCode,
        resolvedCode: code,
        action,
        modifiers: mods,
      });
    }
    const result = this._sendEncodedKey(code, key, action, mods, printable && (mods & 1));
    if (action === 0 && !/^(Alt|Control|Meta|Shift)/.test(code)) this.clearSoftModifiers();
    return result;
  }

  _sendEncodedKey(code, key, action, mods, consumed) {
    if (action !== 0 && !isModifierCode(code)) this.clearSelection();
    const codepoint = key.codePointAt(0);
    const printable = codepoint !== undefined && key.length === (codepoint > 0xffff ? 2 : 1);
    const text = printable ? key : "";
    const ptr = this._wasm.term_reserve(512);
    if (!ptr) return 0;
    const buffer = new Uint8Array(this._wasm.memory.buffer, ptr, 512);
    const codeResult = encoder.encodeInto(code, buffer);
    if (codeResult.read !== code.length) return 0;
    const textResult = encoder.encodeInto(text, buffer.subarray(codeResult.written));
    if (textResult.read !== text.length) return 0;
    return this._wasm.term_key(action, mods, consumed ? 1 : 0, codeResult.written, textResult.written);
  }

  setSoftModifiers(value) {
    const normalized = Number(value) & 7;
    if (normalized === this._softModifiers) return;
    this._softModifiers = normalized;
    this._softModifiersEmitter.emit(normalized);
  }

  clearSoftModifiers() {
    this.setSoftModifiers(0);
  }

  sendKey(code, key, modifiers = this._softModifiers) {
    if (!this._wasm) return 0;
    let effectiveKey = key;
    if ((modifiers & 1) && /^[a-z]$/.test(effectiveKey)) effectiveKey = effectiveKey.toUpperCase();
    const codepoint = effectiveKey.codePointAt(0);
    const printable = codepoint !== undefined && effectiveKey.length === (codepoint > 0xffff ? 2 : 1);
    const down = this._sendEncodedKey(code, effectiveKey, 1, modifiers, printable && (modifiers & 1));
    const up = this._sendEncodedKey(code, effectiveKey, 0, modifiers, printable && (modifiers & 1));
    this.clearSoftModifiers();
    return down && up;
  }

  _sendCommittedInput(text) {
    for (const part of text.split(/(\r\n|\r|\n)/)) {
      if (part === "\r\n" || part === "\r" || part === "\n") this.sendKey("Enter", "Enter");
      else if (part) this._sendCommittedText(part);
    }
  }

  _sendCommittedText(text) {
    if (!this._softModifiers) {
      this.input(text);
      return;
    }
    if (!text) return;
    const codepoint = text.codePointAt(0);
    const firstLength = codepoint > 0xffff ? 2 : 1;
    let first = text.slice(0, firstLength);
    const mods = this._softModifiers;
    if ((mods & 1) && /^[a-z]$/.test(first)) first = first.toUpperCase();
    const printable = first.length === (first.codePointAt(0) > 0xffff ? 2 : 1);
    this._sendEncodedKey(characterCode(first), first, 1, mods, printable && (mods & 1));
    this._sendEncodedKey(characterCode(first), first, 0, mods, printable && (mods & 1));
    this.clearSoftModifiers();
    if (text.length > firstLength) this.input(text.slice(firstLength));
  }

  getSelection() {
    if (!this._wasm) return null;
    const status = this._wasm.term_selection_snapshot();
    if (status === 0) return null;
    if (status < 0) throw new Error(`WASM selection snapshot failed: ${status}`);
    try {
      const ptr = this._wasm.term_selection_snapshot_ptr();
      const len = this._wasm.term_selection_snapshot_len();
      return strictDecoder.decode(new Uint8Array(this._wasm.memory.buffer, ptr, len));
    } finally {
      this._wasm.term_selection_snapshot_release();
    }
  }

  async copySelection() {
    const text = this.getSelection();
    if (text === null) return false;
    await navigator.clipboard.writeText(text);
    this.clearSelection();
    return true;
  }

  clearSelection() {
    if (!this._wasm) return false;
    if (this._textView?.hasSelection()) {
      this._textView.clearBrowserSelection(true);
      return true;
    }
    const handled = this._wasm.term_selection_clear() === 1;
    if (handled) this._scheduler.schedule(true);
    return handled;
  }

  enterSelectionMode() {
    if (this._selectionMode || !this._wasm || !this._coarsePointer.matches) return false;
    this._restoreInputFocus = document.activeElement === this._view.input;
    this._pointerController.resetGestures();
    this.clearSoftModifiers();
    this._selectionMode = true;
    this._state.selectionMode = true;
    this._view.viewport.classList.add("selection-mode");
    this._focusController.suspend();
    this._textView.setEnabled(true);
    this._wasm.term_set_text_view_enabled(1);
    this._wasm.term_invalidate_text_view();
    this._selectionModeEmitter.emit({ active: true, flush: true });
    this._scheduler.schedule(true);
    return true;
  }

  exitSelectionMode({ flush = true, restoreFocus = true } = {}) {
    if (!this._selectionMode) return false;
    const shouldRestoreFocus = restoreFocus && this._restoreInputFocus;
    this._restoreInputFocus = false;
    this._textView.clearBrowserSelection(true);
    this._textView.setEnabled(false);
    this._wasm.term_set_text_view_enabled(0);
    this._selectionMode = false;
    this._state.selectionMode = false;
    this._view.viewport.classList.remove("selection-mode");
    this._selectionModeEmitter.emit({ active: false, flush, restoreFocus });
    this._focusController.resume();
    if (shouldRestoreFocus) this._focusController.restore();
    this._scheduler.schedule(true);
    return true;
  }

  focus() { this._focusController?.focus(); }
  blur() {
    this._view?.input?.blur();
    if (this._wasm) this._wasm.term_focus(0);
  }
  commitComposition() {
    if (!this._inputController?.isComposing && !this._inputController?.isSendingComposition) return false;
    this._inputController.commit(true);
    return true;
  }
  suspendFocus() { this._focusController?.suspend(); }
  resumeFocus({ focus = false } = {}) {
    this._focusController?.resume();
    if (focus) this._focusController?.focus();
  }

  resize() {
    return this._viewportController?.resize();
  }

  reset() {
    if (!this._wasm) return false;
    if (this._selectionMode) this.exitSelectionMode({ flush: false, restoreFocus: false });
    this.clearPendingLatency();
    this._wasm.term_deinit();
    const { cols, rows } = this._viewportController.dimensions;
    if (this._wasm.term_init(cols, rows) !== 1) throw new Error("terminal reset failed");
    this._viewportController.resize();
    return true;
  }

  clearPendingLatency() {
    this._pendingRxAt = 0;
    this._pendingInputAt = 0;
  }

  readPixels() {
    if (!this._renderer) throw new Error("terminal is not open");
    return this._renderer.readPixels();
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const addon of [...this._addons].reverse()) {
      try { addon.dispose(); } catch (error) { console.error("terminal addon disposal failed", error); }
    }
    this._addons.clear();
    this._activeAddons.clear();
    this._disposeRuntime();
    for (const emitter of [
      this._dataEmitter, this._resizeEmitter, this._selectionModeEmitter, this._softModifiersEmitter,
      this._titleEmitter, this._bellEmitter, this._notificationEmitter, this._linkEmitter,
      this._errorEmitter,
    ]) emitter.dispose();
  }

  _disposeRuntime() {
    this._coarsePointer?.removeEventListener("change", this._coarsePointerListener);
    this._coarsePointerListener = null;
    for (const dispose of this._windowListeners.splice(0)) dispose();
    this._pointerController?.dispose();
    this._inputController?.dispose();
    this._viewportController?.dispose();
    this._scheduler?.dispose();
    this._textView?.setEnabled(false);
    if (this._wasm) this._wasm.term_deinit();
    this._renderer?.dispose?.();
    this._view?.dispose();
    this._wasm = null;
    this._renderer = null;
    this._view = null;
    this._opened = false;
  }
}

export { DEFAULT_FONT, DEFAULT_THEME };
