// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { decodeCanvasText } from "../../FramePacket.js";
import { CanvasFontSizing } from "./CanvasFontSizing.js";
import { MAX_RUN_PIXELS } from "./FrameSchema.js";

export const COLOR_CHROMA_THRESHOLD = 12;

export function isChromaticPixel(r, g, b, a) {
  if (a <= 8) return false;
  const maxChannel = Math.max(r, g, b);
  const minChannel = Math.min(r, g, b);
  return maxChannel - minChannel > COLOR_CHROMA_THRESHOLD;
}

export function splitCanvasLayers(imageData, width, height, maskStorage, overlayStorage) {
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount <= 0 || pixelCount > MAX_RUN_PIXELS) {
    throw new RangeError("invalid Canvas glyph mask dimensions");
  }
  const rgba = imageData?.data ?? imageData;
  if (!rgba || rgba.byteLength !== pixelCount * 4) throw new Error("invalid Canvas glyph raster");
  const maskTarget =
    maskStorage?.byteLength >= pixelCount ? maskStorage : new Uint8Array(pixelCount);
  const overlayTarget =
    overlayStorage?.byteLength >= pixelCount * 4 ? overlayStorage : new Uint8Array(pixelCount * 4);
  let hasColor = false;
  for (let index = 0; index < pixelCount; index += 1) {
    const r = rgba[index * 4];
    const g = rgba[index * 4 + 1];
    const b = rgba[index * 4 + 2];
    const a = rgba[index * 4 + 3];
    maskTarget[index] = a;
    if (isChromaticPixel(r, g, b, a)) {
      overlayTarget[index * 4] = r;
      overlayTarget[index * 4 + 1] = g;
      overlayTarget[index * 4 + 2] = b;
      overlayTarget[index * 4 + 3] = a;
      hasColor = true;
    } else {
      overlayTarget[index * 4] = 0;
      overlayTarget[index * 4 + 1] = 0;
      overlayTarget[index * 4 + 2] = 0;
      overlayTarget[index * 4 + 3] = 0;
    }
  }
  return {
    maskStorage: maskTarget,
    mask: maskTarget.subarray(0, pixelCount),
    overlayStorage: overlayTarget,
    overlay: overlayTarget.subarray(0, pixelCount * 4),
    hasColor,
  };
}

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
  if (
    !geometry ||
    !Number.isInteger(geometry.columns) ||
    !Number.isInteger(geometry.rows) ||
    geometry.columns <= 0 ||
    geometry.rows <= 0
  ) {
    throw new Error("invalid glyph atlas geometry");
  }
}

export class CanvasGlyphRasterizer {
  constructor() {
    this.runCanvas = createRasterCanvas();
    this.runContext = configureRasterContext(this.runCanvas);
    this.canvasMask = new Uint8Array(0);
    this.uploadMask = new Uint8Array(0);
    this.canvasOverlay = new Uint8Array(0);
    this.uploadOverlay = new Uint8Array(0);
    this.fontSizing = new CanvasFontSizing();
  }

  rasterize(
    firstSlot,
    slotCount,
    spanCells,
    bytes,
    offset,
    count,
    style,
    atlas,
    font,
    upload,
    uploadColor,
  ) {
    validateAtlasGeometry(atlas);
    if (
      !Number.isInteger(atlas.tileWidth) ||
      !Number.isInteger(atlas.tileHeight) ||
      atlas.tileWidth <= 0 ||
      atlas.tileHeight <= 0
    ) {
      throw new Error("invalid glyph atlas tile dimensions");
    }
    if (
      !Number.isInteger(firstSlot) ||
      !Number.isInteger(slotCount) ||
      !Number.isInteger(spanCells) ||
      firstSlot < 0 ||
      slotCount < 1 ||
      slotCount > 16 ||
      spanCells !== slotCount ||
      firstSlot + slotCount > (atlas.logicalCapacity ?? atlas.columns * atlas.rows)
    ) {
      throw new Error("invalid glyph atlas run");
    }
    const runWidth = spanCells * atlas.tileWidth;
    const runHeight = atlas.tileHeight;
    if (runWidth * runHeight > MAX_RUN_PIXELS) {
      throw new Error("glyph raster run is too large");
    }
    const text = decodeCanvasText(bytes, offset, count);
    if (
      !Number.isInteger(style) ||
      style < 0 ||
      style > 3 ||
      !Number.isInteger(atlas.fontSize) ||
      atlas.fontSize <= 0
    ) {
      throw new Error("invalid Canvas font configuration");
    }
    if (this.runCanvas.width !== runWidth || this.runCanvas.height !== runHeight) {
      this.runCanvas.width = runWidth;
      this.runCanvas.height = runHeight;
      this.runContext = configureRasterContext(this.runCanvas);
    }
    this.runContext.clearRect(0, 0, runWidth, runHeight);
    const context = this.runContext;
    const sizing = this.fontSizing.resolve(
      context,
      font,
      style,
      atlas.fontSize,
      atlas.tileWidth,
      text,
    );
    const cssFont = sizing.css;
    context.font = cssFont;
    context.textAlign = "left";
    context.textBaseline = "alphabetic";
    context.direction = "ltr";
    context.fontKerning = font.ligatures ? "normal" : "none";
    context.textRendering = font.ligatures ? "optimizeLegibility" : "optimizeSpeed";
    const metricReference = sizing.cjk ? "水" : "Mg";
    if (
      this.metricFont !== cssFont ||
      this.metricHeight !== runHeight ||
      this.metricReference !== metricReference
    ) {
      const metrics = context.measureText(metricReference);
      const ascent = metrics.fontBoundingBoxAscent ?? atlas.fontSize * 0.8;
      const descent = metrics.fontBoundingBoxDescent ?? atlas.fontSize * 0.2;
      this.baseline = Math.round((runHeight - ascent - descent) / 2 + ascent);
      this.metricFont = cssFont;
      this.metricHeight = runHeight;
      this.metricReference = metricReference;
    }
    if (sizing.cjk) {
      const advance = context.measureText(text).width;
      context.fillText(text, (runWidth - advance) / 2, this.baseline);
    } else context.fillText(text, 0, this.baseline, runWidth);
    const imageData = this.runContext.getImageData(0, 0, runWidth, runHeight);
    const layers = splitCanvasLayers(
      imageData,
      runWidth,
      runHeight,
      this.canvasMask,
      this.canvasOverlay,
    );
    this.canvasMask = layers.maskStorage;
    this.canvasOverlay = layers.overlayStorage;
    const mask = { storage: layers.maskStorage, pixels: layers.mask };
    const overlay = layers.overlay;
    for (let tileOffset = 0; tileOffset < slotCount;) {
      const rowOffset = (firstSlot + tileOffset) % atlas.columns;
      const chunkSlots = Math.min(slotCount - tileOffset, atlas.columns - rowOffset);
      const chunkWidth = chunkSlots * atlas.tileWidth;
      const chunkPixels = chunkWidth * runHeight;
      if (this.uploadMask.byteLength < chunkPixels) this.uploadMask = new Uint8Array(chunkPixels);
      const packedPixels = this.uploadMask.subarray(0, chunkPixels);
      for (let y = 0; y < runHeight; y += 1) {
        packedPixels.set(
          mask.pixels.subarray(
            y * runWidth + tileOffset * atlas.tileWidth,
            y * runWidth + tileOffset * atlas.tileWidth + chunkWidth,
          ),
          y * chunkWidth,
        );
      }
      upload(firstSlot + tileOffset, chunkSlots, packedPixels, 0, chunkWidth);
      if (layers.hasColor && typeof uploadColor === "function") {
        const chunkOverlayPixels = chunkWidth * runHeight * 4;
        if (this.uploadOverlay.byteLength < chunkOverlayPixels) {
          this.uploadOverlay = new Uint8Array(chunkOverlayPixels);
        }
        const packedOverlay = this.uploadOverlay.subarray(0, chunkOverlayPixels);
        const rowStride = runWidth * 4;
        const rowChunk = chunkWidth * 4;
        for (let y = 0; y < runHeight; y += 1) {
          packedOverlay.set(
            overlay.subarray(
              y * rowStride + tileOffset * atlas.tileWidth * 4,
              y * rowStride + tileOffset * atlas.tileWidth * 4 + rowChunk,
            ),
            y * rowChunk,
          );
        }
        uploadColor(firstSlot + tileOffset, chunkSlots, packedOverlay, 0, chunkWidth * 4);
      }
      tileOffset += chunkSlots;
    }
  }
}
