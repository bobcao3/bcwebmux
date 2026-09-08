// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { TerminalCore } from "./TerminalCore.js";
import {
  createCore as createHostedCore,
  attachCore as attachHostedCore,
  restoreSnapshot as restoreHostedSnapshot,
} from "./TerminalCoreHost.js";
import { EventEmitter } from "./common/EventEmitter.js";
import {
  normalizeRenderBackend,
  acquireRenderBackend,
  releaseRenderBackend,
} from "./browser/render/RenderBackend.js";
import {
  ABSOLUTE_GLYPH_CACHE_MAX_BYTES,
  TERMINAL_CELL_PROTOCOL_LIMIT,
  normalizeByteLimit,
} from "./browser/render/GlyphAtlasLimits.js";
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
import {
  COLOR_FIELDS,
  DEFAULT_FONT,
  DEFAULT_THEME,
  decoder,
  loadTerminalFonts,
  normalizeFont,
  renderFontFamily,
} from "./TerminalOptions.js";

function listenerError(error) {
  console.error("terminal event listener failed", error);
}

function createEmitter() {
  return new EventEmitter({ onListenerError: listenerError });
}

export class Terminal {
  constructor(options = {}) {
    if (!options || typeof options !== "object") throw new TypeError("terminal options must be an object");
    this.options = {
      wasmUrl: options.wasmUrl || "/terminal.wasm",
      wasmFontUrls: options.wasmFontUrls,
      renderer: options.renderer === "kb-canvas" ? "kb-canvas" : "kb-stb",
      renderBackend: normalizeRenderBackend(options.renderBackend),
      font: normalizeFont(options.font),
      theme: options.theme || DEFAULT_THEME,
      grainStrength: Number.isFinite(Number(options.grainStrength)) ? Number(options.grainStrength) : 4,
      glyphCacheMaxBytes: normalizeByteLimit(
        options.glyphCacheMaxBytes,
        ABSOLUTE_GLYPH_CACHE_MAX_BYTES,
        "glyph cache byte limit",
      ),
      elements: options.elements,
      terminalElement: options.terminalElement,
      inputDebug: Boolean(options.inputDebug),
      debugElements: options.debugElements,
      clipboardWrite: options.clipboardWrite,
      canonicalGeometry: Boolean(options.canonicalGeometry),
    };
    this._opened = false;
    this._disposed = false;
    this._opening = null;
    this._addons = new Set();
    this._activeAddons = new Set();
    this._cores = new Set();
    this._core = null;
    this._renderingCore = null;
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
    this._windowListenerController = null;
    this._fontChangeGeneration = 0;
    this._pendingFont = null;
    this._activeTextRenderer = this.options.renderer;
    this._selectionMode = false;
    this._selectionFallbackFrame = null;
    this._restoreInputFocus = false;
    this._softModifiers = 0;
    this._pendingRxAt = 0;
    this._pendingInputAt = 0;
    this._state = {
      selectionMode: false,
      cols: 0,
      rows: 0,
      viewportMode: "active",
      scrollTotal: 0,
      scrollOffset: 0,
      scrollLength: 0,
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
  get core() { return this._core; }
  get coreCount() { return this._cores.size; }
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
    Object.assign(snapshot, this._core?.state || {}, this._state);
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
      scrollbar: this._view.scrollbar,
      scrollbarThumb: this._view.scrollbarThumb,
      screen: this._view.screen,
      getWasm: () => this._wasm,
      getRenderer: () => this._renderer,
      getInputController: () => this._inputController,
      resizeTerminal: (layout) => this._resizeActiveCore(layout),
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
    this._renderer = await acquireRenderBackend(this,
      this._view.screen,
      initialPixelViewport,
      this.options.renderer,
      this.options.renderBackend,
      this.options.glyphCacheMaxBytes,
    );
    this._renderer.setPhysicalCellMetrics(
      initialLayout.cellWidth,
      initialLayout.cellHeight,
      initialLayout.fontSize,
      initialLayout.cols,
    );
    this._renderer.setGrainStrength(this.options.grainStrength);

    const core = new TerminalCore({
      wasmUrl: this.options.wasmUrl,
      wasmFontUrls: this.options.wasmFontUrls,
      renderer: this.options.renderer,
      font: this.options.font,
      theme: this.options.theme,
      clipboardWrite: this.options.clipboardWrite,
    });
    this._cores.add(core);
    this._registerTerminal(core, initialLayout);
    this._renderingCore = core;
    try {
      await core.open({ cols: initialLayout.cols, rows: initialLayout.rows, host: this });
      this._core = core;
      this._wasm = core.wasm;
      this._renderer.selectTerminal(core);
    } catch (error) {
      this._releaseTerminal(core);
      this._cores.delete(core);
      throw error;
    } finally {
      this._renderingCore = null;
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
      surface: this._view.surface,
      screen: this._view.screen,
      getWasm: () => this._wasm,
      getRenderer: () => this._renderer,
      getSelectionMode: () => this._selectionMode,
      enterSelectionMode: (clientX, clientY) => {
        if (!this.enterSelectionMode()) return false;
        const rect = this._view.surface.getBoundingClientRect();
        const x = Math.max(0, clientX - rect.left) * this._renderer.pixelScaleX;
        const y = Math.max(0, clientY - rect.top) * this._renderer.pixelScaleY;
        if (this._wasm.term_selection_word(x, y) === 1) this._scheduler.schedule(true);
        cancelAnimationFrame(this._selectionFallbackFrame);
        let attempts = 0;
        const selectFromMirror = () => {
          this._selectionFallbackFrame = null;
          if (!this._selectionMode || this._textView.hasSelection()) return;
          if (this._textView.selectWordAtPoint(clientX, clientY, { nearest: true })) return;
          attempts += 1;
          if (attempts < 4) this._selectionFallbackFrame = requestAnimationFrame(selectFromMirror);
        };
        this._selectionFallbackFrame = requestAnimationFrame(selectFromMirror);
        return true;
      },
      textView: this._textView,
      focusController: this._focusController,
      scheduleFrame: (immediate) => this._scheduler.schedule(immediate),
      scrollWheel: (event, context) => this._viewportController.scrollWheel(event, context),
      beginTouchScroll: (y) => this._viewportController.beginTouchScroll(y),
      updateTouchScroll: (y, context) => this._viewportController.updateTouchScroll(y, context),
      endTouchScroll: (y, context) => this._viewportController.endTouchScroll(y, context),
      cancelTouchScroll: () => this._viewportController.cancelTouchScroll(),
      cancelScrollGesture: () => this._viewportController.cancelScrollGesture(),
      onLink: (event) => this._linkEmitter.emit(event),
    });

    this._viewportController.resize(initialPixelViewport);
    this.setTheme(this.options.theme);
    await this.setFont(this.options.font);
    this._viewportController.start();
    this._installWindowListeners();
  }

  _registerTerminal(core, layout) {
    const visibleCells = layout.cols * layout.rows;
    if (!Number.isSafeInteger(visibleCells) || visibleCells <= 0 || visibleCells > TERMINAL_CELL_PROTOCOL_LIMIT) {
      throw new RangeError("terminal viewport cell count is invalid");
    }
    const plan = this._renderer.registerTerminal(core, visibleCells, layout.cols);
    this._ensureFrameCapacity(visibleCells);
    this._installGlyphPartitions();
    return plan;
  }

  _prepareTerminalFrame(core, visibleCells) {
    if (!Number.isSafeInteger(visibleCells) || visibleCells <= 0 || visibleCells > TERMINAL_CELL_PROTOCOL_LIMIT) {
      throw new RangeError("terminal viewport cell count is invalid");
    }
    this._renderer.resizeTerminalPartition(core, visibleCells);
    this._ensureFrameCapacity(visibleCells);
    this._installGlyphPartitions();
  }

  _ensureFrameCapacity(visibleCells) {
    if (!this._renderer.ensureFrameCapacity(visibleCells)) return false;
    for (const core of this._cores) {
      if (core.wasm) core.wasm.term_invalidate_frame_cache();
    }
    return true;
  }

  _installGlyphPartition(core) {
    if (!core.wasm) return 1;
    const partition = this._renderer?.glyphPartition(core);
    if (!partition) return 0;
    return core.wasm.term_set_glyph_partition(
      partition.baseSlot,
      partition.slotCapacity,
      this._renderer.atlasColumns,
      partition.generation,
    );
  }

  _installGlyphPartitions() {
    for (const core of this._cores) {
      if (this._installGlyphPartition(core) !== 1) {
        const error = new Error("terminal glyph partition installation failed");
        this._renderer.error = error.message;
        throw error;
      }
    }
    return 1;
  }

  _releaseTerminal(core) {
    if (this._renderer?.glyphPartition(core)) {
      this._renderer.releaseTerminal(core);
      this._installGlyphPartitions();
    }
  }

  _isCoreActive(core) {
    return core === this._core || core === this._renderingCore;
  }

  _resizeActiveCore(layout) {
    const core = this._renderingCore ?? this._core;
    if (core?.wasm) {
      const visibleCells = this.options.canonicalGeometry
        ? Math.max(layout.cols * layout.rows, core.cols * core.rows)
        : layout.cols * layout.rows;
      this._prepareTerminalFrame(core, visibleCells);
      const result = this.options.canonicalGeometry
        ? core.setRenderMetrics(layout)
        : core.resize(layout);
      if (result !== 1) {
        const error = "terminal core resize failed";
        this._renderer.error = error;
        throw new Error(error);
      }
    }
    return 1;
  }

  _gpuInit(core, cellPtr, cellLen, grainPtr, grainLen, grainSize, maxCells, maxStyles, styleSize, cellSize) {
    if (!this._cores.has(core)) return 0;
    try {
      const memory = core.wasm.memory.buffer;
      const cellSource = decoder.decode(new Uint8Array(memory, cellPtr, cellLen));
      const grain = new Int8Array(memory, grainPtr, grainLen);
      return this._renderer.initialize(cellSource, grain, grainSize, maxCells, maxStyles, styleSize, cellSize);
    } catch (error) {
      console.error(error);
      this._errorEmitter.emit(error);
      return 0;
    }
  }

  _gpuSubmit(core, submissionPtr) {
    if (!this._isCoreActive(core)) return 0;
    try {
      const memory = core.wasm.memory.buffer;
      const metadata = this._renderer.submitWasm(core, memory, submissionPtr);
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
      this._renderer.error = error.message;
      this._errorEmitter.emit(error);
      return 0;
    }
  }

  _coreTitleChanged(core, title) {
    if (core === this._core) this._titleEmitter.emit(title);
  }

  _coreBell(core) {
    if (core === this._core) this._bellEmitter.emit();
  }

  _coreNotification(core, notification) {
    if (core === this._core) this._notificationEmitter.emit(notification);
  }

  _coreRestored(core) {
    if (this._isCoreActive(core)) {
      this._viewportController.resize(this._viewportController.latestPixelViewport);
    }
  }

  _coreDisposed(core) {
    this._releaseTerminal(core);
    this._cores.delete(core);
    if (this._core === core) {
      this._viewportController?.cancelScrollGesture();
      this._core = null;
      this._wasm = null;
    }
    if (this._renderingCore === core) this._renderingCore = null;
  }

  _installWindowListeners() {
    this._windowListenerController?.abort();
    this._windowListenerController = new AbortController();
    const listen = (target, type, listener) => {
      target.addEventListener(type, listener, { signal: this._windowListenerController.signal });
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
    listen(this._coarsePointer, "change", () => {
      if (!this._coarsePointer.matches && this._selectionMode) {
        this.exitSelectionMode({ restoreFocus: false });
      }
      this._inputController.resetGeometry();
      if (this._inputController.isComposing) this._inputController.sync();
    });
  }

  _sampleMetric(name, value) {
    if (!Number.isFinite(value)) return;
    this._state[name] = this._state[name] == null ? value : this._state[name] * 0.8 + value * 0.2;
  }

  _renderFrame() {
    const core = this._core;
    if (!core) return;
    const startedAt = performance.now();
    core.wasm.term_frame();
    const elapsed = performance.now() - startedAt;
    if (Number.isFinite(elapsed)) {
      core._state.wasmFrameMs = core._state.wasmFrameMs == null
        ? elapsed
        : core._state.wasmFrameMs * 0.8 + elapsed * 0.2;
    }
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
    this._state.viewportMode = metadata.viewportMode;
    this._state.scrollTotal = metadata.scrollTotal;
    this._state.scrollOffset = metadata.scrollOffset;
    this._state.scrollLength = metadata.scrollLength;
    if (this._renderingCore) this._renderingCore.frameSubmitted();
    else this._core?.frameSubmitted();
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
    for (const core of this._cores) core.setTheme(theme);
    this._scheduler.schedule(true);
  }

  async setFont(fontOptions) {
    const previousFont = this.options.font;
    const font = normalizeFont({ ...this.options.font, ...(fontOptions || {}) });
    if (font.canvasOnly && this._activeTextRenderer !== "kb-canvas") {
      throw new Error("Canvas-only font requires the kb-canvas renderer");
    }
    if (!this._terminalElement) {
      this.options.font = font;
      return font;
    }
    const generation = ++this._fontChangeGeneration;
    this._pendingFont = font;
    this._applyCssFont(font);
    try {
      await Promise.all(loadTerminalFonts(font));
      await document.fonts.ready;
      if (generation !== this._fontChangeGeneration || !this._wasm) return;
      for (const core of this._cores) core.setFont(font);
      this._viewportController.remeasureCells();
      this._viewportController.resize(this._viewportController.latestPixelViewport);
      this._reloadRendererFont();
      this.options.font = font;
      if (generation === this._fontChangeGeneration) this._pendingFont = null;
      this._scheduler.schedule(true);
    } catch (error) {
      if (generation === this._fontChangeGeneration) {
        this._applyCssFont(previousFont);
        this.options.font = previousFont;
        for (const core of this._cores) core.setFont(previousFont);
        this._viewportController.remeasureCells();
        this._viewportController.resize(this._viewportController.latestPixelViewport);
        this._reloadRendererFont();
        this._pendingFont = null;
        this._scheduler.schedule(true);
        this._errorEmitter.emit(error);
      }
      throw error;
    }
  }

  setRenderer(rendererName) {
    const normalized = rendererName === "kb-canvas" ? "kb-canvas" : "kb-stb";
    if (normalized !== "kb-canvas" && (this._pendingFont ?? this.options.font).canvasOnly) {
      throw new Error("Canvas-only font requires the kb-canvas renderer");
    }
    if (!this._wasm || !this._renderer) {
      this.options.renderer = normalized;
      this._activeTextRenderer = normalized;
      return normalized;
    }
    this._renderer.setTextRenderer(normalized);
    this._installGlyphPartitions();
    for (const core of this._cores) core.setRenderer(normalized);
    this.options.renderer = normalized;
    this._activeTextRenderer = normalized;
    this._scheduler.schedule(true);
    return normalized;
  }

  async createCore(options = {}) {
    return createHostedCore(this, options);
  }

  attachCore(core) {
    return attachHostedCore(this, core);
  }

  restoreSnapshot(data, core = this._core) {
    return restoreHostedSnapshot(this, data, core);
  }

  setGrainStrength(value) {
    const strength = Number(value);
    if (!Number.isFinite(strength) || strength < 0 || strength > 32) {
      throw new TypeError("invalid grain strength");
    }
    this.options.grainStrength = strength;
    this._renderer?.setGrainStrength(strength);
  }

  setGlyphCacheMaxBytes(value) {
    const normalized = normalizeByteLimit(
      value,
      ABSOLUTE_GLYPH_CACHE_MAX_BYTES,
      "glyph cache byte limit",
    );
    if (!this._renderer) {
      this.options.glyphCacheMaxBytes = normalized;
      return normalized;
    }
    const oldBudget = this._renderer.glyphCacheMaxBytes;
    this._renderer.glyphCacheMaxBytes = normalized;
    try {
      const layout = this._viewportController.physicalLayout(this._viewportController.latestPixelViewport);
      this._renderer.reconfigureGlyphAtlas(
        {
          width: layout.cellWidth,
          height: layout.cellHeight,
          fontSize: layout.fontSize,
          columns: layout.cols,
        },
        this._activeTextRenderer,
        getComputedStyle(this._terminalElement).fontFamily,
      );
    } catch (error) {
      this._renderer.glyphCacheMaxBytes = oldBudget;
      throw error;
    }
    this._installGlyphPartitions();
    this.options.glyphCacheMaxBytes = normalized;
    return normalized;
  }

  _reloadRendererFont() {
    if (!this._renderer) return;
    this._renderer.reloadFont(getComputedStyle(this._terminalElement).fontFamily);
    this._installGlyphPartitions();
  }

  write(data) {
    if (!this._core) throw new Error("terminal is not open");
    if (!this._pendingRxAt) this._pendingRxAt = performance.now();
    this._core.write(data);
  }

  _input(text, paste) {
    const core = this._core;
    if (!core) throw new Error("terminal is not open");
    if (text) {
      this._viewportController.cancelMomentum();
      this.clearSelection();
    }
    core._input(text, paste);
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
    if (action !== 0 && !isModifierCode(code)) {
      this._viewportController.cancelMomentum();
      this.clearSelection();
    }
    const codepoint = key.codePointAt(0);
    const printable = codepoint !== undefined && key.length === (codepoint > 0xffff ? 2 : 1);
    const text = printable ? key : "";
    return this._core.sendEncodedKey(code, text, action, mods, consumed);
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
    return this._core?.getSelection() ?? null;
  }

  async copySelection() {
    const text = this.getSelection();
    if (text === null) return false;
    await navigator.clipboard.writeText(text);
    this.clearSelection();
    return true;
  }

  clearSelection() {
    const core = this._core;
    if (!core) return false;
    if (this._textView?.hasSelection()) {
      this._textView.clearBrowserSelection(true);
      return true;
    }
    const handled = core.clearSelection();
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
    cancelAnimationFrame(this._selectionFallbackFrame);
    this._selectionFallbackFrame = null;
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
    const core = this._core;
    if (!core) return false;
    if (this._selectionMode) this.exitSelectionMode({ flush: false, restoreFocus: false });
    this.clearPendingLatency();
    core.reset();
    this._viewportController.resize();
    return true;
  }

  clearPendingLatency() {
    this._pendingRxAt = 0;
    this._pendingInputAt = 0;
    this._core?.clearPendingLatency();
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
    this._windowListenerController?.abort();
    this._windowListenerController = null;
    cancelAnimationFrame(this._selectionFallbackFrame);
    this._selectionFallbackFrame = null;
    this._pointerController?.dispose();
    this._inputController?.dispose();
    this._viewportController?.dispose();
    this._scheduler?.dispose();
    this._textView?.setEnabled(false);
    const cores = [...this._cores];
    for (const core of cores) core.dispose();
    this._cores.clear();
    this._core = null;
    this._renderingCore = null;
    this._wasm = null;
    releaseRenderBackend(this, this._renderer);
    this._view?.dispose();
    this._renderer = null;
    this._view = null;
    this._opened = false;
  }
}

export { DEFAULT_FONT, DEFAULT_THEME };
