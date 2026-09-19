// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { validateCanvasPath } from "../../FramePacket.js";
import { MAX_RUN_PIXELS, PATH_COMMAND_SIZE, PATH_OP } from "./FrameSchema.js";

export function extractCanvasAlpha(context, x, y, width, height, storage) {
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount <= 0 || pixelCount > MAX_RUN_PIXELS) {
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
  context.fillStyle = "white";
  return context;
}

export function validateAtlasGeometry(geometry) {
  if (!geometry || !Number.isInteger(geometry.columns) || !Number.isInteger(geometry.rows) ||
      geometry.columns <= 0 || geometry.rows <= 0) {
    throw new Error("invalid glyph atlas geometry");
  }
}

export class CanvasGlyphRasterizer {
  constructor() {
    this.runCanvas = createRasterCanvas();
    this.runContext = configureRasterContext(this.runCanvas);
    this.canvasMask = new Uint8Array(0);
    this.uploadMask = new Uint8Array(0);
  }

  rasterize(firstSlot, slotCount, spanCells, commands, offset, count, atlas, upload) {
    validateAtlasGeometry(atlas);
    if (!Number.isInteger(atlas.tileWidth) || !Number.isInteger(atlas.tileHeight) ||
        atlas.tileWidth <= 0 || atlas.tileHeight <= 0) {
      throw new Error("invalid glyph atlas tile dimensions");
    }
    if (!Number.isInteger(firstSlot) || !Number.isInteger(slotCount) ||
        !Number.isInteger(spanCells) || firstSlot < 0 ||
        slotCount < 1 || slotCount > 16 || spanCells !== slotCount ||
        firstSlot + slotCount > atlas.columns * atlas.rows) {
      throw new Error("invalid glyph atlas run");
    }
    const runWidth = spanCells * atlas.tileWidth;
    const runHeight = atlas.tileHeight;
    if (runWidth * runHeight > MAX_RUN_PIXELS) {
      throw new Error("glyph raster run is too large");
    }
    validateCanvasPath(commands, offset, count);
    if (this.runCanvas.width !== runWidth || this.runCanvas.height !== runHeight) {
      this.runCanvas.width = runWidth;
      this.runCanvas.height = runHeight;
      this.runContext = configureRasterContext(this.runCanvas);
    }
    this.runContext.clearRect(0, 0, runWidth, runHeight);
    this.runContext.beginPath();
    for (let index = 0; index < count; index += 1) {
      const command = (offset + index) * PATH_COMMAND_SIZE;
      const f = n => commands.getFloat32(command + n * 4, true);
      switch (commands.getUint32(command, true)) {
        case PATH_OP.move:
          this.runContext.moveTo(f(1), f(2));
          break;
        case PATH_OP.line:
          this.runContext.lineTo(f(1), f(2));
          break;
        case PATH_OP.quadratic:
          this.runContext.quadraticCurveTo(
            f(3), f(4), f(1), f(2),
          );
          break;
        case PATH_OP.cubic:
          this.runContext.bezierCurveTo(
            f(3), f(4), f(5), f(6), f(1), f(2),
          );
          break;
        case PATH_OP.close:
          this.runContext.closePath();
          break;
      }
    }
    this.runContext.fill("nonzero");
    const mask = extractCanvasAlpha(
      this.runContext, 0, 0, runWidth, runHeight, this.canvasMask,
    );
    this.canvasMask = mask.storage;
    for (let tileOffset = 0; tileOffset < slotCount;) {
      const rowOffset = (firstSlot + tileOffset) % atlas.columns;
      const chunkSlots = Math.min(slotCount - tileOffset, atlas.columns - rowOffset);
      const chunkWidth = chunkSlots * atlas.tileWidth;
      const chunkPixels = chunkWidth * runHeight;
      if (this.uploadMask.byteLength < chunkPixels) this.uploadMask = new Uint8Array(chunkPixels);
      const packedPixels = this.uploadMask.subarray(0, chunkPixels);
      for (let y = 0; y < runHeight; y += 1) {
        packedPixels.set(
          mask.pixels.subarray(y * runWidth + tileOffset * atlas.tileWidth,
            y * runWidth + tileOffset * atlas.tileWidth + chunkWidth),
          y * chunkWidth,
        );
      }
      upload(firstSlot + tileOffset, chunkSlots, packedPixels, 0, chunkWidth);
      tileOffset += chunkSlots;
    }
  }
}
