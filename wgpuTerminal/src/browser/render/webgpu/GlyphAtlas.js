// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { extractCanvasAlpha } from "../CanvasAlphaMask.js";

function createRasterCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  return canvas;
}

export class GlyphAtlas {
  constructor(device, font, geometry, cellWidth, cellHeight, fontSize) {
    this.device = device;
    this.fontFamily = font.fontFamily;
    this.runCanvas = createRasterCanvas();
    this.runContext = this.runCanvas.getContext("2d", { alpha: true, willReadFrequently: true });
    this.runContext.textBaseline = "alphabetic";
    this.runContext.fillStyle = "white";
    this.runContext.textRendering = "geometricPrecision";
    this.nextSlot = 0;
    this.canvasMask = new Uint8Array(0);
    this.pendingTextureCopies = [];
    const candidate = this.prepareLayout(geometry, cellWidth, cellHeight, fontSize, true);
    this.commitLayout(candidate);
  }

  get capacity() {
    return this.columns * this.rows;
  }

  prepareLayout(geometry, cellWidth, cellHeight, fontSize, reset) {
    if (!geometry || !Number.isInteger(geometry.columns) || !Number.isInteger(geometry.rows) ||
        geometry.columns <= 0 || geometry.rows <= 0) {
      throw new Error("invalid glyph atlas geometry");
    }
    if (!Number.isFinite(cellWidth) || !Number.isFinite(cellHeight) || !Number.isFinite(fontSize) ||
        cellWidth <= 0 || cellHeight <= 0 || fontSize <= 0) {
      throw new Error("invalid physical cell metrics");
    }
    const tileWidth = Math.round(cellWidth);
    const tileHeight = Math.round(cellHeight);
    const roundedFontSize = Math.max(1, Math.round(fontSize));
    if (tileWidth <= 0 || tileHeight <= 0) throw new Error("invalid physical cell metrics");
    const texture = this.device.createTexture({
      size: [geometry.columns * tileWidth, geometry.rows * tileHeight],
      format: "r8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
    return {
      columns: geometry.columns,
      rows: geometry.rows,
      tileWidth,
      tileHeight,
      fontSize: roundedFontSize,
      baseline: Math.min(tileHeight - 1, Math.round((tileHeight - roundedFontSize) * 0.5 + roundedFontSize * 0.82)),
      texture,
      preserve: !reset && geometry.columns === this.columns && tileWidth === this.tileWidth &&
        tileHeight === this.tileHeight,
    };
  }

  commitLayout(candidate) {
    if (this.pendingTextureCopies.length !== 0) throw new Error("glyph atlas texture copies pending");
    const oldTexture = this.texture;
    const oldRows = this.rows;
    const oldColumns = this.columns;
    const oldTileWidth = this.tileWidth;
    const oldTileHeight = this.tileHeight;
    const preservingGrowth = candidate.preserve && candidate.rows > oldRows && this.nextSlot > 0 && oldTexture;
    this.columns = candidate.columns;
    this.rows = candidate.rows;
    this.tileWidth = candidate.tileWidth;
    this.tileHeight = candidate.tileHeight;
    this.fontSize = candidate.fontSize;
    this.baseline = candidate.baseline;
    this.texture = candidate.texture;
    if (preservingGrowth) {
      this.pendingTextureCopies.push({
        source: oldTexture,
        destination: this.texture,
        width: oldColumns * oldTileWidth,
        height: oldRows * oldTileHeight,
      });
    } else {
      oldTexture?.destroy();
      if (!candidate.preserve) this.nextSlot = 0;
    }
  }

  setCanvasRun(firstSlot, slotCount, spanCells, text, flags) {
    if (!Number.isInteger(firstSlot) || !Number.isInteger(slotCount) || !Number.isInteger(spanCells) ||
        firstSlot < 0 || slotCount <= 0 || spanCells <= 0 ||
        slotCount !== spanCells || firstSlot + slotCount > this.capacity) {
      throw new Error("invalid glyph atlas run");
    }
    const runWidth = spanCells * this.tileWidth;
    if (runWidth > this.runCanvas.width || this.tileHeight > this.runCanvas.height) {
      this.runCanvas.width = Math.max(this.runCanvas.width, runWidth);
      this.runCanvas.height = Math.max(this.runCanvas.height, this.tileHeight);
      this.runContext = this.runCanvas.getContext("2d", { alpha: true, willReadFrequently: true });
      this.runContext.textBaseline = "alphabetic";
      this.runContext.fillStyle = "white";
      this.runContext.textRendering = "geometricPrecision";
    }
    this.runContext.textBaseline = "alphabetic";
    this.runContext.fillStyle = "white";
    this.runContext.clearRect(0, 0, runWidth, this.tileHeight);
    const weight = (flags & 1) !== 0 ? "700" : "400";
    const italic = (flags & 2) !== 0 ? "italic" : "normal";
    this.runContext.font = `${italic} ${weight} ${Math.max(1, this.fontSize - 0.5)}px ${this.fontFamily}`;
    this.runContext.fillText(text, 0, this.baseline);
    for (let index = 0; index < slotCount; index += 1) {
      const slot = firstSlot + index;
      const mask = extractCanvasAlpha(
        this.runContext,
        index * this.tileWidth,
        0,
        this.tileWidth,
        this.tileHeight,
        this.canvasMask,
      );
      this.canvasMask = mask.storage;
      this.device.queue.writeTexture(
        {
          texture: this.texture,
          origin: [(slot % this.columns) * this.tileWidth, Math.floor(slot / this.columns) * this.tileHeight, 0],
        },
        mask.pixels,
        { bytesPerRow: this.tileWidth, rowsPerImage: this.tileHeight },
        [this.tileWidth, this.tileHeight, 1],
      );
    }
    this.nextSlot = Math.max(this.nextSlot, firstSlot + slotCount);
    return firstSlot + slotCount;
  }

  takePendingTextureCopies() {
    const copies = this.pendingTextureCopies;
    this.pendingTextureCopies = [];
    return copies;
  }

  dispose() {
    for (const copy of this.pendingTextureCopies) copy.source.destroy();
    this.pendingTextureCopies = [];
    this.texture?.destroy();
    this.texture = null;
  }
}
