// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { parseFramePacket } from "./FramePacket.js";
import { EventEmitter } from "./common/EventEmitter.js";
import {
  DEFAULT_FONT,
  DEFAULT_THEME,
  decoder,
  encoder,
  normalizeBinary,
  normalizeFont,
  packedColor,
  strictDecoder,
} from "./TerminalOptions.js";
import { loadWasmFontFaces, resolveWasmFontUrls } from "./WasmFonts.js";

const WASM_STAGING_CAPACITY = 64 * 1024;
const TEXT_STAGING_CHUNK = 48 * 1024;
const moduleCache = new Map();

function listenerError(error) {
  console.error("terminal core event listener failed", error);
}

function createEmitter() {
  return new EventEmitter({ onListenerError: listenerError });
}

function compiledModule(url) {
  const key = String(url);
  let pending = moduleCache.get(key);
  if (!pending) {
    pending = WebAssembly.compileStreaming(fetch(url));
    moduleCache.set(key, pending);
    pending.catch(() => moduleCache.delete(key));
  }
  return pending;
}

export class TerminalCore {
  constructor(options = {}) {
    if (!options || typeof options !== "object") throw new TypeError("terminal core options must be an object");
    const wasmUrl = options.wasmUrl || "/terminal.wasm";
    this.options = {
      wasmUrl,
      wasmFontUrls: resolveWasmFontUrls(wasmUrl, options.wasmFontUrls),
      renderer: options.renderer === "kb-canvas" ? "kb-canvas" : "kb-stb",
      font: normalizeFont(options.font || DEFAULT_FONT),
      theme: options.theme || DEFAULT_THEME,
      clipboardWrite: options.clipboardWrite,
    };
    this._borrow = false;
    this._inWasm = false;
    this._partition = null;
    this._partitionAtlasColumns = 0;
    this._renderLayout = null;
    this._wasm = null;
    this._fontFaces = null;
    this._host = null;
    this._opened = false;
    this._disposed = false;
    this._opening = null;
    this._clipboardWriteQueue = Promise.resolve();
    this._pendingRxAt = 0;
    this._state = {
      frames: 0,
      rxBytes: 0,
      txBytes: 0,
      replyBytes: 0,
      cols: 0,
      rows: 0,
      wasmParseMs: null,
      wasmFrameMs: null,
    };
    this._dataEmitter = createEmitter();
    this._replyEmitter = createEmitter();
    this._titleEmitter = createEmitter();
    this._bellEmitter = createEmitter();
    this._notificationEmitter = createEmitter();
    this._errorEmitter = createEmitter();
  }

  get ready() { return this._wasm !== null; }
  get memoryBytes() { return this._wasm?.memory.buffer.byteLength ?? 0; }
  get opened() { return this._opened; }
  get disposed() { return this._disposed; }
  get cols() { return this._state.cols; }
  get rows() { return this._state.rows; }
  get state() { return this._state; }

  onData(listener) { return this._dataEmitter.event(listener); }
  onReply(listener) { return this._replyEmitter.event(listener); }
  onTitleChange(listener) { return this._titleEmitter.event(listener); }
  onBell(listener) { return this._bellEmitter.event(listener); }
  onNotification(listener) { return this._notificationEmitter.event(listener); }
  onError(listener) { return this._errorEmitter.event(listener); }

  async open(options = {}) {
    this.assertMutable();
    if (this._disposed) throw new Error("terminal core is disposed");
    if (this._opened) throw new Error("terminal core is already open");
    if (this._opening) return this._opening;
    const cols = Number(options.cols ?? 80);
    const rows = Number(options.rows ?? 24);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
      throw new TypeError("terminal core dimensions must be positive integers");
    }
    if (options.host) this._setHost(options.host);
    this._opening = this._open(cols, rows);
    try {
      await this._opening;
      this._opened = true;
      return this;
    } catch (error) {
      this._errorEmitter.emit(error);
      if (this._wasm) this._invoke("term_deinit");
      this._wasm = null;
      this._fontFaces = null;
      throw error;
    } finally {
      this._opening = null;
    }
  }

  async _open(cols, rows) {
    const [module, fontFaces] = await Promise.all([
      compiledModule(this.options.wasmUrl),
      loadWasmFontFaces(this.options.wasmFontUrls),
    ]);
    this._fontFaces = fontFaces;
    const instance = await WebAssembly.instantiate(module, this._createWasmImports());
    this._wasm = instance.exports;
    this._invoke("term_bootstrap");
    if (this._invoke("term_init", cols, rows) !== 1) throw new Error("terminal core initialization failed");
    if ((this._host?._installGlyphPartition(this) ?? 1) !== 1) {
      throw new Error("terminal glyph partition installation failed");
    }
    this._state.cols = cols;
    this._state.rows = rows;
    this.setTheme(this.options.theme);
    this.setRenderer(this.options.renderer);
    this.setFont(this.options.font);
  }

  _createWasmImports() {
    const emitBytes = (emitter, ptr, len, reply) => {
      const host = this._host;
      const hostEmitter = host?._core === this && !reply ? host._dataEmitter : null;
      if (!this._wasm) return 0;
      if (host?._core === this && !reply && !host._pendingInputAt) {
        host._pendingInputAt = performance.now();
      }
      if (emitter.size === 0 && (hostEmitter?.size ?? 0) === 0) return 0;
      const view = new Uint8Array(this._wasm.memory.buffer, ptr, len);
      if (emitter.size > 0) emitter.emit(view);
      if (host?._core === this && hostEmitter?.size > 0) {
        const diagnostics = host._inputController?.diagnostics;
        if (diagnostics?.enabled) {
          const sample = view.subarray(0, 64);
          diagnostics.log("pty_write", {
            len,
            reply,
            hex: Array.from(sample, (byte) => byte.toString(16).padStart(2, "0")).join(" "),
            text: decoder.decode(sample),
          });
        }
        hostEmitter.emit(view);
      }
      this._state.txBytes += len;
      if (reply) this._state.replyBytes += len;
      return 1;
    };
    return {
      host: {
        terminal_log: (level, ptr, len) => {
          const message = decoder.decode(new Uint8Array(this._wasm.memory.buffer, ptr, len));
          const method = ["error", "warn", "info", "debug"][level] ?? "log";
          console[method]("terminal WASM:", message);
        },
        font_size: (style) => {
          if (!Number.isInteger(style) || style < 0 || style >= (this._fontFaces?.length ?? 0)) return 0;
          return this._fontFaces[style]?.byteLength ?? 0;
        },
        font_copy: (style, ptr, len) => {
          if (!Number.isInteger(style) || style < 0 || style >= (this._fontFaces?.length ?? 0)) return 0;
          const face = this._fontFaces[style];
          if (!face || !Number.isInteger(ptr) || !Number.isInteger(len) || ptr < 0 || len !== face.byteLength) return 0;
          const memory = this._wasm?.memory?.buffer;
          if (!memory || ptr > memory.byteLength - len) return 0;
          new Uint8Array(memory, ptr, len).set(face);
          return 1;
        },
        user_write: (ptr, len) => emitBytes(this._dataEmitter, ptr, len, false),
        terminal_reply: (ptr, len) => emitBytes(this._replyEmitter, ptr, len, true),
        clipboard_write: (location, ptr, len) => this._clipboardWrite(location, ptr, len),
        set_title: (ptr, len) => {
          const title = decoder.decode(new Uint8Array(this._wasm.memory.buffer, ptr, len));
          this._titleEmitter.emit(title);
          this._host?._coreTitleChanged(this, title);
        },
        ring_bell: () => {
          this._bellEmitter.emit();
          this._host?._coreBell(this);
        },
        desktop_notification: (titlePtr, titleLen, bodyPtr, bodyLen) => {
          const memory = this._wasm.memory.buffer;
          const notification = {
            title: decoder.decode(new Uint8Array(memory, titlePtr, titleLen)),
            body: decoder.decode(new Uint8Array(memory, bodyPtr, bodyLen)),
          };
          this._notificationEmitter.emit(notification);
          this._host?._coreNotification(this, notification);
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

  _setHost(host) {
    this.assertMutable();
    if (this._host && this._host !== host) throw new Error("terminal core already belongs to another host");
    this._host = host;
  }

  _clearHost(host) {
    this.assertMutable();
    if (this._host === host) this._host = null;
  }

  _sampleMetric(name, value) {
    if (!Number.isFinite(value)) return;
    this._state[name] = this._state[name] == null ? value : this._state[name] * 0.8 + value * 0.2;
  }

  _schedule(immediate = false) {
    if (this._host?._core === this) this._host._scheduler?.schedule(immediate);
  }

  assertMutable() {
    if (this._borrow || this._inWasm) throw new Error("terminal mutation during live frame borrow or reentrant operation");
  }

  _invoke(name, ...args) {
    this.assertMutable();
    if (!this._wasm) return 0;
    this._inWasm = true;
    try { return this._wasm[name](...args); }
    finally { this._inWasm = false; }
  }

  consumeFrame(consumer, expectations) {
    this.assertMutable();
    if (!this._wasm) return 0;
    if (typeof consumer !== "function") throw new TypeError("frame consumer must be synchronous");
    const startedAt = performance.now();
    let token = 0;
    let accepted = false;
    this._borrow = true;
    try {
      const ptr = this._wasm.term_frame_prepare();
      if (ptr === 0) return 0;
      if (ptr < 0) throw new Error(`frame preparation failed: ${ptr}`);
      token = this._wasm.term_frame_token();
      const packet = parseFramePacket(this._wasm.memory.buffer, ptr, {
        abi: 5,
        coreGeneration: this._wasm.term_core_generation(),
        configGeneration: this._wasm.term_config_generation(),
        partition: this._partition,
        token,
        ...expectations,
      });
      const result = consumer(packet);
      if (result != null && typeof result.then === "function") {
        // Observe rejected promises without extending the borrowed lifetime.
        Promise.resolve(result).catch(() => {});
        throw new TypeError("frame consumer returned a thenable");
      }
      if (result === false) throw new Error("frame consumer rejected packet");
      accepted = true;
      return 1;
    } finally {
      try {
        if (token && this._wasm.term_frame_finish(token, accepted ? 1 : 0) !== 1) {
          throw new Error("frame finish token mismatch");
        }
      } finally {
        this._borrow = false;
        this._sampleMetric("wasmFrameMs", performance.now() - startedAt);
      }
    }
  }

  renderFrame() {
    this.assertMutable();
    return this._host?._consumeCoreFrame(this) ?? 0;
  }

  setGlyphPartition(partition, atlasColumns) {
    this.assertMutable();
    const result = this._invoke("term_set_glyph_partition", partition.baseSlot, partition.slotCapacity, atlasColumns, partition.generation);
    if (result === 1) {
      this._partition = { ...partition };
      this._partitionAtlasColumns = atlasColumns;
    }
    return result;
  }

  invalidateFrame() { return this._invoke("term_invalidate_frame_cache", 1); }
  invalidateTextView() { return this._invoke("term_invalidate_text_view"); }
  setTextViewEnabled(enabled) { return this._invoke("term_set_text_view_enabled", enabled ? 1 : 0); }
  scrollBottom() { return this._invoke("term_scroll_bottom"); }
  scrollRow(row) { return this._invoke("term_scroll_row", row); }
  scrollDelta(rows) { return this._invoke("term_scroll_delta", rows); }
  scrollInput(rows, mods, x, y) { return this._invoke("term_scroll_input", rows, mods, x, y); }
  mouse(action, button, mods, x, y, pressed) { return this._invoke("term_mouse", action, button, mods, x, y, pressed); }
  selection(action, x, y) { return this._invoke("term_selection", action, x, y); }
  selectWord(x, y) { return this._invoke("term_selection_word", x, y); }
  focus(focused) { return this._invoke("term_focus", focused ? 1 : 0); }

  hyperlinkAt(x, y) {
    this.assertMutable();
    const status = this._invoke("term_hyperlink_at", x, y);
    if (status < 0) throw new Error(`WASM hyperlink lookup failed: ${status}`);
    if (status !== 1) return null;
    try {
      return strictDecoder.decode(new Uint8Array(this._wasm.memory.buffer,
        this._invoke("term_hyperlink_ptr"), this._invoke("term_hyperlink_len")));
    } catch { return null; }
  }

  frameSubmitted() {
    this._state.frames += 1;
  }

  write(data) {
    this.assertMutable();
    if (!this._wasm) throw new Error("terminal core is not open");
    const bytes = normalizeBinary(data);
    if (!bytes.length) return;
    if (!this._pendingRxAt) this._pendingRxAt = performance.now();
    const parseStartedAt = performance.now();
    let offset = 0;
    while (offset < bytes.length) {
      const length = Math.min(WASM_STAGING_CAPACITY, bytes.length - offset);
      const ptr = this._invoke("term_reserve", length);
      if (!ptr) throw new Error("WASM receive buffer exhausted");
      const chunk = offset === 0 && length === bytes.length ? bytes : bytes.subarray(offset, offset + length);
      new Uint8Array(this._wasm.memory.buffer, ptr, length).set(chunk);
      if (this._invoke("term_feed", length) !== 1) throw new Error("WASM terminal feed failed");
      offset += length;
    }
    this._sampleMetric("wasmParseMs", performance.now() - parseStartedAt);
    this._state.rxBytes += bytes.length;
    this._schedule(true);
  }

  _input(text, paste) {
    this.assertMutable();
    if (!this._wasm) throw new Error("terminal core is not open");
    let remaining = String(text ?? "");
    if (!remaining.length) return;
    while (remaining.length) {
      const ptr = this._invoke("term_reserve", TEXT_STAGING_CHUNK);
      if (!ptr) throw new Error("WASM staging buffer exhausted");
      const buffer = new Uint8Array(this._wasm.memory.buffer, ptr, TEXT_STAGING_CHUNK);
      const result = encoder.encodeInto(remaining, buffer);
      if (!result.read && !result.written) throw new Error("text encoding made no progress");
      if (this._invoke("term_text", result.written, paste ? 1 : 0) !== 1) {
        throw new Error("WASM text submission failed");
      }
      remaining = result.read < remaining.length ? remaining.slice(result.read) : "";
    }
    this._schedule(true);
  }

  input(text, options) {
    this._input(text, options?.paste === true);
  }

  paste(text) {
    this._input(text, true);
  }

  sendEncodedKey(code, text, action, modifiers, consumed) {
    this.assertMutable();
    if (!this._wasm) return 0;
    const ptr = this._invoke("term_reserve", 512);
    if (!ptr) return 0;
    const buffer = new Uint8Array(this._wasm.memory.buffer, ptr, 512);
    const codeResult = encoder.encodeInto(code, buffer);
    if (codeResult.read !== code.length) return 0;
    const textResult = encoder.encodeInto(text, buffer.subarray(codeResult.written));
    if (textResult.read !== text.length) return 0;
    const result = this._invoke("term_key", action, modifiers, consumed ? 1 : 0, codeResult.written, textResult.written);
    if (result === 1) this._schedule(true);
    return result;
  }

  resize(layout) {
    this.assertMutable();
    if (!this._wasm) return 0;
    const result = this._invoke("term_resize",
      layout.cols,
      layout.rows,
      layout.cellWidth,
      layout.cellHeight,
      layout.cellWidth,
      layout.cellHeight,
      layout.fontSize,
    );
    if (result === 1) {
      this._state.cols = layout.cols;
      this._state.rows = layout.rows;
      this._renderLayout = { ...layout };
    }
    return result;
  }

  setRenderMetrics(layout) {
    this.assertMutable();
    if (!this._wasm) throw new Error("terminal core is not open");
    const result = this._invoke("term_set_render_metrics",
      layout.cellWidth,
      layout.cellHeight,
      layout.cellWidth,
      layout.cellHeight,
      layout.fontSize,
    );
    if (result === 1) this._renderLayout = { ...layout };
    return result;
  }

  resizeCanonical(geometry) {
    this.assertMutable();
    if (!this._wasm) throw new Error("terminal core is not open");
    const cols = Number(geometry?.cols);
    const rows = Number(geometry?.rows);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
      throw new TypeError("terminal core dimensions must be positive integers");
    }
    this._host?._prepareTerminalFrame(this, cols * rows);
    const result = this._invoke("term_resize_canonical",
      cols,
      rows,
      geometry?.cellWidthPx ?? 8,
      geometry?.cellHeightPx ?? 16,
    );
    if (result === 1) {
      this._state.cols = cols;
      this._state.rows = rows;
      this._schedule(true);
    }
    return result;
  }

  setReplayMode(enabled) {
    this.assertMutable();
    if (!this._wasm) throw new Error("terminal core is not open");
    const result = this._invoke("term_set_replay_mode", enabled ? 1 : 0);
    if (result !== 1) throw new Error(`WASM replay mode configuration failed: ${result}`);
    return result;
  }

  setTheme(theme) {
    this.assertMutable();
    this.options.theme = theme;
    if (!this._wasm) return;
    const colors = [theme.background, theme.foreground, ...(theme.ansi || [])];
    if (colors.length !== 18) throw new TypeError("terminal theme must provide 16 ANSI colors");
    const view = new DataView(this._wasm.memory.buffer);
    const ptr = this._invoke("term_theme_ptr");
    colors.forEach((color, index) => view.setUint32(ptr + index * 4, packedColor(color), true));
    const result = this._invoke("term_apply_theme");
    if (result !== 1) throw new Error(`WASM theme application failed: ${result}`);
    this._schedule(true);
  }

  setFont(fontOptions) {
    this.assertMutable();
    const font = normalizeFont({ ...this.options.font, ...(fontOptions || {}) });
    this.options.font = font;
    if (this._wasm && this._invoke("term_set_font", font.wasmId, font.ligatures ? 1 : 0) !== 1) {
      throw new Error("WASM font configuration failed");
    }
    return font;
  }

  setRenderer(rendererName) {
    this.assertMutable();
    const renderer = rendererName === "kb-canvas" ? "kb-canvas" : "kb-stb";
    this.options.renderer = renderer;
    if (this._wasm && this._invoke("term_set_renderer", renderer === "kb-canvas" ? 1 : 0) !== 1) {
      throw new Error("WASM renderer configuration failed");
    }
    return renderer;
  }

  restoreSnapshot(data) {
    this.assertMutable();
    if (!this._wasm) throw new Error("terminal core is not open");
    const bytes = normalizeBinary(data);
    if (!bytes.length) throw new TypeError("terminal snapshot must not be empty");
    const ptr = this._invoke("term_snapshot_reserve", bytes.length);
    if (!ptr) throw new Error("terminal snapshot exceeds the WASM restore limit");
    new Uint8Array(this._wasm.memory.buffer, ptr, bytes.length).set(bytes);
    if (this._invoke("term_snapshot_restore", bytes.length) !== 1) throw new Error("terminal snapshot restore failed");
    this._pendingRxAt = 0;
    this._invoke("term_invalidate_frame_cache");
    if (this._host) this._host._coreRestored(this);
    else this._schedule(true);
  }

  invalidateForAttach() {
    this.assertMutable();
    if (!this._wasm) throw new Error("terminal core is not open");
    this._invoke("term_invalidate_frame_cache", 0);
    this._invoke("term_invalidate_text_view");
  }

  getSelection() {
    this.assertMutable();
    if (!this._wasm) return null;
    const status = this._invoke("term_selection_snapshot");
    if (status === 0) return null;
    if (status < 0) throw new Error(`WASM selection snapshot failed: ${status}`);
    try {
      const ptr = this._invoke("term_selection_snapshot_ptr");
      const len = this._invoke("term_selection_snapshot_len");
      return strictDecoder.decode(new Uint8Array(this._wasm.memory.buffer, ptr, len));
    } finally {
      this._invoke("term_selection_snapshot_release");
    }
  }

  clearSelection() {
    this.assertMutable();
    return Boolean(this._wasm && this._invoke("term_selection_clear") === 1);
  }

  setSelectionRange(start, end) {
    this.assertMutable();
    return Boolean(this._wasm && this._invoke("term_selection_set_range", start.row, start.col, end.row, end.col) === 1);
  }

  reset() {
    this.assertMutable();
    this._host?._assertMutable();
    if (!this._wasm) return false;
    this._invoke("term_deinit");
    if (this._invoke("term_init", this._state.cols, this._state.rows) !== 1) throw new Error("terminal core reset failed");
    const installed = this._host ? this._host._installGlyphPartition(this)
      : this._partition ? this.setGlyphPartition(this._partition, this._partitionAtlasColumns) : 1;
    if (installed !== 1) {
      throw new Error("terminal glyph partition installation failed");
    }
    this.setTheme(this.options.theme);
    this.setRenderer(this.options.renderer);
    this.setFont(this.options.font);
    if (this._renderLayout) this.setRenderMetrics(this._renderLayout);
    this._pendingRxAt = 0;
    this._schedule(true);
    return true;
  }

  clearPendingLatency() {
    this._pendingRxAt = 0;
  }

  dispose() {
    this.assertMutable();
    this._host?._assertMutable();
    if (this._disposed) return;
    this._disposed = true;
    if (this._wasm) this._invoke("term_deinit");
    this._wasm = null;
    this._fontFaces = null;
    this._host?._coreDisposed(this);
    this._host = null;
    for (const emitter of [
      this._dataEmitter,
      this._replyEmitter,
      this._titleEmitter,
      this._bellEmitter,
      this._notificationEmitter,
      this._errorEmitter,
    ]) emitter.dispose();
  }
}
