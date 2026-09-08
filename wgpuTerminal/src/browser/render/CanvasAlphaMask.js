// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

export function extractCanvasAlpha(context, x, y, width, height, storage) {
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount <= 0) {
    throw new RangeError("invalid Canvas glyph mask dimensions");
  }
  const target = storage?.byteLength >= pixelCount ? storage : new Uint8Array(pixelCount);
  const rgba = context.getImageData(x, y, width, height).data;
  if (rgba.byteLength !== pixelCount * 4) throw new Error("invalid Canvas glyph raster");
  for (let index = 0; index < pixelCount; index += 1) target[index] = rgba[index * 4 + 3];
  return { storage: target, pixels: target.subarray(0, pixelCount) };
}

function createRasterCanvas(width = 1, height = 1) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function configureRasterContext(canvas) {
  const context = canvas.getContext("2d", { alpha: true, willReadFrequently: true });
  if (!context) throw new Error("Canvas glyph rasterizer unavailable");
  context.textBaseline = "alphabetic";
  context.fillStyle = "white";
  context.textRendering = "geometricPrecision";
  return context;
}

export function validateAtlasGeometry(geometry) {
  if (!geometry || !Number.isInteger(geometry.columns) || !Number.isInteger(geometry.rows) ||
      geometry.columns <= 0 || geometry.rows <= 0) {
    throw new Error("invalid glyph atlas geometry");
  }
}

export class CanvasGlyphRasterizer {
  constructor(font) {
    this.fontFamily = font.fontFamily;
    this.runCanvas = createRasterCanvas();
    this.runContext = configureRasterContext(this.runCanvas);
    this.canvasMask = new Uint8Array(0);
    this.nextSlot = 0;
  }

  get capacity() {
    return this.columns * this.rows;
  }

  get baseline() {
    return Math.min(this.tileHeight - 1, Math.round((this.tileHeight - this.fontSize) * 0.5 + this.fontSize * 0.82));
  }

  setCanvasRun(firstSlot, slotCount, spanCells, text, flags) {
    if (!Number.isInteger(firstSlot) || !Number.isInteger(slotCount) || !Number.isInteger(spanCells) ||
        firstSlot < 0 || slotCount <= 0 || spanCells <= 0 ||
        slotCount !== spanCells || firstSlot + slotCount > this.capacity) {
      throw new Error("invalid glyph atlas run");
    }
    const runWidth = spanCells * this.tileWidth;
    if (this.runCanvas.width < runWidth || this.runCanvas.height < this.tileHeight) {
      this.runCanvas.width = Math.max(this.runCanvas.width, runWidth);
      this.runCanvas.height = Math.max(this.runCanvas.height, this.tileHeight);
      this.runContext = configureRasterContext(this.runCanvas);
    }
    const weight = (flags & 1) !== 0 ? "700" : "400";
    const italic = (flags & 2) !== 0 ? "italic" : "normal";
    this.runContext.clearRect(0, 0, runWidth, this.tileHeight);
    this.runContext.font = `${italic} ${weight} ${Math.max(1, this.fontSize - 0.5)}px ${this.fontFamily}`;
    this.runContext.fillText(text, 0, this.baseline);
    for (let index = 0; index < slotCount; index += 1) {
      const mask = extractCanvasAlpha(
        this.runContext,
        index * this.tileWidth,
        0,
        this.tileWidth,
        this.tileHeight,
        this.canvasMask,
      );
      this.canvasMask = mask.storage;
      this._uploadMask(firstSlot + index, mask.pixels);
    }
    this.nextSlot = Math.max(this.nextSlot, firstSlot + slotCount);
    return firstSlot + slotCount;
  }

}
