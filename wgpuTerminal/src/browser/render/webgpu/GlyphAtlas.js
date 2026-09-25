// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { validateAtlasGeometry } from "../CanvasAlphaMask.js";
import { glyphAtlasSnapshotLayout } from "../GlyphAtlasSnapshot.js";

export class GlyphAtlas {
  constructor(device, font, geometry, cellWidth, cellHeight, fontSize) {
    this.nextSlot = 0;
    this.device = device;
    this.pendingTextureCopies = [];
    const candidate = this.prepareLayout(geometry, cellWidth, cellHeight, fontSize, true);
    this.commitLayout(candidate);
  }

  get capacity() {
    return this.columns * this.rows;
  }

  prepareLayout(geometry, cellWidth, cellHeight, fontSize, reset) {
    validateAtlasGeometry(geometry);
    if (
      !Number.isFinite(cellWidth) ||
      !Number.isFinite(cellHeight) ||
      !Number.isFinite(fontSize) ||
      cellWidth <= 0 ||
      cellHeight <= 0 ||
      fontSize <= 0
    ) {
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
      texture,
      preserve:
        !reset &&
        geometry.columns === this.columns &&
        tileWidth === this.tileWidth &&
        tileHeight === this.tileHeight,
    };
  }

  commitLayout(candidate) {
    if (this.pendingTextureCopies.length !== 0)
      throw new Error("glyph atlas texture copies pending");
    const oldTexture = this.texture;
    const oldRows = this.rows;
    const oldColumns = this.columns;
    const oldTileWidth = this.tileWidth;
    const oldTileHeight = this.tileHeight;
    const preservingGrowth =
      candidate.preserve && candidate.rows > oldRows && this.nextSlot > 0 && oldTexture;
    this.columns = candidate.columns;
    this.rows = candidate.rows;
    this.tileWidth = candidate.tileWidth;
    this.tileHeight = candidate.tileHeight;
    this.fontSize = candidate.fontSize;
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

  takePendingTextureCopies() {
    const copies = this.pendingTextureCopies;
    this.pendingTextureCopies = [];
    return copies;
  }

  async readPixels() {
    if (!this.texture || this.pendingTextureCopies.length)
      throw new Error("Glyph texture is not ready; retry after rendering");
    const layout = glyphAtlasSnapshotLayout(this);
    const { width, height } = layout;
    const bytesPerRow = Math.ceil(width / 256) * 256;
    const buffer = this.device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    try {
      const encoder = this.device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture: this.texture },
        { buffer, bytesPerRow, rowsPerImage: height },
        [width, height, 1],
      );
      this.device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const source = new Uint8Array(buffer.getMappedRange());
      const data = new Uint8Array(width * height);
      for (let y = 0; y < height; y++)
        data.set(source.subarray(y * bytesPerRow, y * bytesPerRow + width), y * width);
      buffer.unmap();
      return { ...layout, data };
    } finally {
      buffer.destroy();
    }
  }

  dispose() {
    for (const copy of this.pendingTextureCopies) copy.source.destroy();
    this.pendingTextureCopies = [];
    this.texture?.destroy();
    this.texture = null;
  }
}
