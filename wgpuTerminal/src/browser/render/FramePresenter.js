// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { CanvasGlyphRasterizer } from "./CanvasAlphaMask.js";
import { FRAME_SIZE, SUBMISSION_SIZE, CANVAS_REQUEST_SIZE } from "./FrameSchema.js";
import * as atlasRuntime from "./GlyphAtlasRuntime.js";

export class FramePresenter {
  constructor(host, backend) {
    this.host = host;
    this.backend = backend;
    backend.presenter = this;
    this.valid = false;
    this.core = null;
    this.revision = null;
    this.submissionMetadata = {};
  }

  invalidate(recover = true) {
    const wasValid = this.valid || this.revision !== null;
    this.valid = false;
    this.revision = null;
    if (wasValid && this.core?.ready) this.core.invalidateFrame();
    if (recover && !this.host._recovering && !this.host._renderer?.error) this.host._scheduler?.recover();
  }

  registerTerminal(...args) { return this.changeAtlas("registerTerminal", args); }
  resizeTerminalPartition(...args) { return this.changeAtlas("resizeTerminalPartition", args); }
  releaseTerminal(...args) { return this.changeAtlas("releaseTerminal", args); }
  glyphPartition(core) { return atlasRuntime.glyphPartition(this.backend, core); }
  changeAtlas(method, args) {
    const plan = atlasRuntime[method](this.backend, ...args);
    if (plan?.invalidated?.has(this.core) || plan?.textureReset || plan?.textureChanged ||
        (method === "releaseTerminal" && args[0] === this.core)) this.invalidate();
    return plan;
  }
  selectTerminal(core) {
    this.invalidate();
    this.submissionMetadata = {};
    this.core = core;
    atlasRuntime.selectTerminal(this.backend, core);
    core.invalidateFrame();
  }

  upload(packet) {
    const b = this.backend;
    for (const key of ["glyphSlotsUsed", "cols", "rows", "cacheHits", "cacheMisses", "background", "foreground",
      "cursorX", "cursorY", "cursorFlags", "cursorStyle"]) b[key] = packet[key];
    for (const key of ["cols", "rows", "viewportMode", "scrollTotal", "scrollOffset", "scrollLength"]) {
      this.submissionMetadata[key] = packet[key];
    }
    for (let i = 0; i < packet.bitmapUploadsCount; i++) {
      const v = packet.bitmapUploads, o = i * 16;
      b.uploadBitmap(v.getUint32(o, true), v.getUint32(o + 4, true), packet.bitmapUploadPixels,
        v.getUint32(o + 8, true), v.getUint32(o + 12, true));
    }
    for (let i = 0; i < packet.canvasRequestsCount; i++) {
      const v = packet.canvasRequests, o = i * CANVAS_REQUEST_SIZE;
      this.canvasRasterizer ??= new CanvasGlyphRasterizer();
      this.canvasRasterizer.rasterize(v.getUint32(o, true), v.getUint32(o + 4, true), v.getUint32(o + 8, true),
        packet.canvasText, v.getUint32(o + 12, true), v.getUint32(o + 16, true),
        v.getUint32(o + 20, true), b.atlas, b.activeTerminal.options.font,
        (...args) => b.uploadBitmap(...args));
    }
    b.uploadStyles(packet.stylesFirst, packet.styles, packet.styleBytes);
    for (let i = 0; i < packet.dirtyRangesCount; i++) {
      const first = packet.dirtyRanges.getUint32(i * 8, true);
      const count = packet.dirtyRanges.getUint32(i * 8 + 4, true);
      const start = first * packet.cols * b.cellSize;
      b.uploadCells(first, count, packet.cells.subarray(start, start + count * packet.cols * b.cellSize),
        packet.selections.subarray(first, first + count));
    }
    b.drawnCellCount = packet.frameCells;
    if (b.indirectData) {
      b.indirectData[1] = packet.frameCells;
      b.indirectDirty = true;
    }
  }

  consumeFrame(core) {
    const b = this.backend;
    let revision;
    let full = false;
    try {
      if (!b.initialized || b.activeTerminal !== core) throw new Error("invalid renderer terminal");
      const result = core.consumeFrame(packet => {
        full = packet.fullFrame;
        if ((!this.valid || this.core !== core || b.error) && !full) throw new Error("renderer requires a full replacement frame");
        this.valid = false;
        this.upload(packet);
        this.host._textView?.update(packet);
        revision = packet.revision;
      }, {
        cellSize: b.cellSize, styleSize: b.styleSize, frameSize: FRAME_SIZE, packetSize: SUBMISSION_SIZE,
        maxCells: b.maxCells, maxStyles: b.maxStyles, partition: this.glyphPartition(core),
        atlas: { columns: b.atlas.columns, tileWidth: b.atlas.tileWidth, tileHeight: b.atlas.tileHeight },
      });
      if (result === 1) {
        this.core = core;
        this.revision = revision;
        this.valid = true;
        if (full) b.error = null;
        this.host._submitFrameMetadata(this.submissionMetadata);
        this.host._viewportController?.submitFrameMetadata(this.submissionMetadata);

      } else if (revision !== undefined) {
        this.invalidate();
      }
      return result;
    } catch (error) {
      this.invalidate(false);
      b.error = error.message;
      this.host._errorEmitter?.emit(error);
      throw error;
    }
  }

  requestPresentation() { this.host._scheduler?.requestPresentation(); }

  nextAnimationDeadline(now) {
    return this.valid && !this.backend.error && (this.backend.cursorFlags & 6) !== 0
      ? (Math.floor(now / 500) + 1) * 500 : null;
  }

  present(now = performance.now()) {
    if (!this.valid || this.backend.error || this.backend.activeTerminal !== this.core) return false;
    this.backend.presentCurrentState(Math.floor(now / 500) % 2 === 0);
    return true;
  }
}
