// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { RowAdjustment } from "./RowAdjustment.js";
import { SemanticScrollbar } from "./SemanticScrollbar.js";
import { ScrollGestureController } from "./ScrollGestureController.js";

function devicePixelRatio() {
  const ratio = window.devicePixelRatio;
  if (!Number.isFinite(ratio) || ratio <= 0) {
    throw new Error("invalid device pixel ratio");
  }
  return ratio;
}

export class ViewportController {
  constructor(options) {
    this.terminalElement = options.terminalElement;
    this.viewport = options.viewport;
    this.screen = options.screen;
    this.isReady = options.isReady;
    this.scrollBottom = options.scrollBottom;
    this.scrollRow = options.scrollRow;
    this.scrollDelta = options.scrollDelta;
    this.inputRows = options.inputRows;
    this.getInputController = options.getInputController;
    this.resizeTerminal = options.resizeTerminal;
    this.onResize = options.onResize || (() => {});
    this.onBeforeResize = options.onBeforeResize || (() => {});
    this.scheduleFrame = options.scheduleFrame;
    this.started = false;
    this.resizeScheduled = false;
    this.adjustment = new RowAdjustment();
    this.scrollGesture = new ScrollGestureController({
      getCellHeight: () => this.cssCellMetrics.height,
      getPageSize: () => this.adjustment.pageSize,
      onRows: (rows, context) => this._dispatchInputRows(rows, context),
      shouldStopMomentum: (rows, route) =>
        route === 1 &&
        ((rows < 0 && this.adjustment.mode === "top") ||
          (rows > 0 && this.adjustment.mode === "active")),
    });
    this.semanticScrollbar = new SemanticScrollbar({
      element: options.scrollbar,
      thumb: options.scrollbarThumb,
      onRow: (row) => this.scrollToRow(row),
      onDelta: (rows) => this.scrollRows(rows),
      onWheel: (event) => this.scrollWheel(event),
      onInteraction: () => this.cancelMomentum(),
    });

    this.measuredMetrics = this.measureCells();
    this.cssCellMetrics = { ...this.measuredMetrics };
    this.latestPixelViewport = this.nativePixelViewport();
  }

  measureCells() {
    const probe = document.createElement("span");
    probe.textContent = "MMMMMMMMMM";
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font:inherit";
    this.viewport.append(probe);
    const rect = probe.getBoundingClientRect();
    probe.remove();
    return {
      width: Math.max(1, rect.width / 10),
      height: Math.max(1, rect.height),
    };
  }

  remeasureCells() {
    Object.assign(this.measuredMetrics, this.measureCells());
  }

  nativePixelViewport(entry) {
    const box = entry?.devicePixelContentBoxSize;
    const size = Array.isArray(box) ? box[0] : box;
    if (size) {
      return {
        width: Math.max(1, Math.round(size.inlineSize)),
        height: Math.max(1, Math.round(size.blockSize)),
      };
    }
    const rect = this.screen.getBoundingClientRect();
    const scale = devicePixelRatio();
    return {
      width: Math.max(1, Math.round(rect.width * scale)),
      height: Math.max(1, Math.round(rect.height * scale)),
    };
  }

  physicalLayout(pixelViewport = this.latestPixelViewport) {
    const scaleX = pixelViewport.width / Math.max(1, this.screen.clientWidth);
    const scaleY = pixelViewport.height / Math.max(1, this.screen.clientHeight);
    const rasterScale = devicePixelRatio();
    const cellWidth = Math.max(1, Math.min(pixelViewport.width, Math.round(this.measuredMetrics.width * rasterScale)));
    const cellHeight = Math.max(1, Math.min(pixelViewport.height, Math.round(this.measuredMetrics.height * rasterScale)));
    const fontSize = Math.max(1, Math.round(parseFloat(getComputedStyle(this.terminalElement).fontSize) * rasterScale));
    const cols = Math.max(1, Math.floor(pixelViewport.width / cellWidth));
    const rows = Math.max(1, Math.floor(pixelViewport.height / cellHeight));
    if (cols * cellWidth > pixelViewport.width || rows * cellHeight > pixelViewport.height) {
      throw new Error("physical layout exceeds viewport");
    }
    return { cols, rows, cellWidth, cellHeight, fontSize, scaleX, scaleY };
  }

  get dimensions() {
    const { cols, rows } = this.physicalLayout(this.latestPixelViewport ?? this.nativePixelViewport());
    return { cols, rows };
  }

  get cellMetrics() {
    return this.cssCellMetrics;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.resizeObserver = new ResizeObserver((entries) => {
      this.latestPixelViewport = this.nativePixelViewport(entries[0]);
      this._scheduleResize();
    });
    try {
      this.resizeObserver.observe(this.screen, { box: "device-pixel-content-box" });
    } catch {
      this.resizeObserver.observe(this.screen);
    }
  }

  resize(pixelViewport = this.nativePixelViewport()) {
    if (!this.isReady()) return null;
    this.cancelScrollGesture();
    this.onBeforeResize();
    this.latestPixelViewport = pixelViewport;
    const layout = this.physicalLayout(pixelViewport);
    this.cssCellMetrics.width = layout.cellWidth / layout.scaleX;
    this.cssCellMetrics.height = layout.cellHeight / layout.scaleY;
    this._applyCssCellMetrics();
    this.semanticScrollbar.render(this.adjustment);
    if (!this.resizeTerminal(layout, pixelViewport)) {
      throw new Error("terminal resize failed");
    }
    this.onResize({ cols: layout.cols, rows: layout.rows });
    this.scheduleFrame();
    return layout;
  }

  _applyCssCellMetrics() {
    this.terminalElement.style.setProperty("--cell-width", `${this.cssCellMetrics.width}px`);
    this.terminalElement.style.setProperty("--cell-height", `${this.cssCellMetrics.height}px`);
    this.viewport.style.setProperty("--cell-width", `${this.cssCellMetrics.width}px`);
    this.viewport.style.setProperty("--cell-height", `${this.cssCellMetrics.height}px`);
  }

  submitFrameMetadata(metadata) {
    this.adjustment.applyFrame(metadata);
    this.scrollGesture.viewportChanged(this.adjustment.mode);
    this.semanticScrollbar.render(this.adjustment);
    this.getInputController()?.sync();
    return metadata;
  }

  scrollToRow(row) {
    this.cancelMomentum();
    if (!Number.isFinite(row) || this.adjustment.maximum === 0) return false;
    const target = Math.max(0, Math.min(this.adjustment.maximum, Math.round(row)));
    const result = target === this.adjustment.maximum
      ? this.scrollBottom()
      : this.scrollRow(target);
    if (!result) return false;
    this.semanticScrollbar.reveal();
    this.scheduleFrame(true);
    return true;
  }

  scrollRows(rows) {
    this.cancelMomentum();
    if (!Number.isFinite(rows) || this.adjustment.maximum === 0) return false;
    const delta = Math.max(-0x80000000, Math.min(0x7fffffff, Math.trunc(rows)));
    if (delta === 0) return false;
    if (!this.scrollDelta(delta)) return false;
    this.semanticScrollbar.reveal();
    this.scheduleFrame(true);
    return true;
  }

  _dispatchInputRows(rows, context) {
    if (!Number.isFinite(rows) || rows === 0) return 0;
    const delta = Math.max(-0x80000000, Math.min(0x7fffffff, Math.trunc(rows)));
    if (delta === 0) return 0;
    const routeName = this.inputRows(delta, context);
    const route = { viewport: 1, mouse: 2, keys: 3 }[routeName] ?? 0;
    if (route < 1 || route > 3) return 0;
    if (route === 1) this.semanticScrollbar.reveal();
    this.scheduleFrame(true);
    return route;
  }

  scrollWheel(event, context) {
    return this.scrollGesture.wheel(event, context);
  }

  beginTouchScroll(y) {
    this.scrollGesture.beginTouch(y);
  }

  updateTouchScroll(y, context) {
    return this.scrollGesture.moveTouch(y, context);
  }

  endTouchScroll(y, context) {
    return this.scrollGesture.endTouch(y, context);
  }

  cancelTouchScroll() {
    this.scrollGesture.cancelTouch();
  }

  cancelMomentum() {
    this.scrollGesture.cancelMomentum();
  }

  cancelScrollGesture() {
    this.scrollGesture.cancel();
  }

  _scheduleResize() {
    if (this.resizeScheduled) return;
    this.resizeScheduled = true;
    requestAnimationFrame(() => {
      this.resizeScheduled = false;
      if (!this.started || !this.latestPixelViewport) return;
      this.resize(this.latestPixelViewport);
    });
  }

  dispose() {
    this.started = false;
    this.resizeScheduled = false;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.scrollGesture.dispose();
    this.semanticScrollbar.dispose();
  }
}
