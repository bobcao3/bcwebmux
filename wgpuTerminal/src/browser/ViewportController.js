// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

export class ViewportController {
  constructor(options) {
    this.terminalElement = options.terminalElement;
    this.viewport = options.viewport;
    this.scroll = options.scroll;
    this.spacer = options.spacer;
    this.screen = options.screen;
    this.getWasm = options.getWasm;
    this.getRenderer = options.getRenderer;
    this.getInputController = options.getInputController;
    this.onResize = options.onResize || (() => {});
    this.onBeforeResize = options.onBeforeResize || (() => {});
    this.scheduleFrame = options.scheduleFrame;
    this.suppressScroll = false;
    this.latestScrollTotal = 0;
    this.latestScrollLength = 0;
    this.resizePending = false;
    this.started = false;
    this._onScroll = this._handleScroll.bind(this);

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
    const scale = window.devicePixelRatio || 1;
    return {
      width: Math.max(1, Math.round(rect.width * scale)),
      height: Math.max(1, Math.round(rect.height * scale)),
    };
  }

  physicalLayout(pixelViewport = this.latestPixelViewport) {
    const scaleX = pixelViewport.width / Math.max(1, this.screen.clientWidth);
    const scaleY = pixelViewport.height / Math.max(1, this.screen.clientHeight);
    const cellWidth = Math.max(1, Math.min(pixelViewport.width, Math.round(this.measuredMetrics.width * scaleX)));
    const cellHeight = Math.max(1, Math.min(pixelViewport.height, Math.round(this.measuredMetrics.height * scaleY)));
    const fontSize = Math.max(1, Math.round(parseFloat(getComputedStyle(this.terminalElement).fontSize) * scaleY));
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
    this.scroll.addEventListener("scroll", this._onScroll, { passive: true });
    this.resizeObserver = new ResizeObserver((entries) => {
      this.latestPixelViewport = this.nativePixelViewport(entries[0]);
      if (this.resizePending) return;
      this.resizePending = true;
      requestAnimationFrame(() => {
        this.resizePending = false;
        if (this.started) this.resize(this.latestPixelViewport);
      });
    });
    try {
      this.resizeObserver.observe(this.screen, { box: "device-pixel-content-box" });
    } catch {
      this.resizeObserver.observe(this.screen);
    }
  }

  resize(pixelViewport = this.nativePixelViewport()) {
    const renderer = this.getRenderer();
    const wasm = this.getWasm();
    if (!renderer || !wasm) return null;
    this.onBeforeResize();
    this.latestPixelViewport = pixelViewport;
    const layout = this.physicalLayout(pixelViewport);
    this.cssCellMetrics.width = layout.cellWidth / layout.scaleX;
    this.cssCellMetrics.height = layout.cellHeight / layout.scaleY;
    renderer.setPhysicalCellMetrics(layout.cellWidth, layout.cellHeight, layout.fontSize);
    renderer.resize(pixelViewport.width, pixelViewport.height);
    this.terminalElement.style.setProperty("--cell-width", `${this.cssCellMetrics.width}px`);
    this.terminalElement.style.setProperty("--cell-height", `${this.cssCellMetrics.height}px`);
    const result = wasm.term_resize(
      layout.cols,
      layout.rows,
      layout.cellWidth,
      layout.cellHeight,
      layout.cellWidth,
      layout.cellHeight,
      layout.fontSize,
      renderer.atlasColumns,
    );
    if (result !== 1) throw new Error("terminal resize failed");
    this.onResize({ cols: layout.cols, rows: layout.rows });
    this.scheduleFrame();
    return layout;
  }

  submitFrameMetadata(metadata) {
    this.latestScrollTotal = metadata.scrollTotal;
    this.latestScrollLength = metadata.scrollLength;
    this.spacer.style.height = `${Math.max(metadata.scrollTotal, metadata.scrollLength) * this.cssCellMetrics.height}px`;
    const logicalBottom = Math.max(0, metadata.scrollTotal - metadata.scrollLength);
    const targetScroll = metadata.scrollOffset >= logicalBottom
      ? Math.max(0, this.scroll.scrollHeight - this.scroll.clientHeight)
      : metadata.scrollOffset * this.cssCellMetrics.height;
    if (Math.abs(this.scroll.scrollTop - targetScroll) > 0.5) {
      this.suppressScroll = true;
      this.scroll.scrollTop = targetScroll;
      queueMicrotask(() => {
        this.suppressScroll = false;
      });
    }
    this.getInputController()?.sync();
    return metadata;
  }

  _handleScroll() {
    if (this.suppressScroll) return;
    const wasm = this.getWasm();
    if (!wasm) return;
    const atBottom = this.scroll.scrollTop + this.scroll.clientHeight >= this.scroll.scrollHeight - 1;
    const row = atBottom
      ? Math.max(0, this.latestScrollTotal - this.latestScrollLength)
      : Math.max(0, Math.round(this.scroll.scrollTop / this.cssCellMetrics.height));
    if (wasm.term_scroll_row(row) === 1) this.scheduleFrame(true);
  }

  dispose() {
    this.started = false;
    this.resizeObserver?.disconnect();
    this.scroll.removeEventListener("scroll", this._onScroll, { passive: true });
  }
}
