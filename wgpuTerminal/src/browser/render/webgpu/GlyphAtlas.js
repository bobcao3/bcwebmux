// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { validateAtlasGeometry } from "../CanvasAlphaMask.js";
import { growGlyphAtlasRows } from "../GlyphAtlasLimits.js";
import { glyphAtlasSnapshotLayout } from "../GlyphAtlasSnapshot.js";

function allocatedRows(rows, rowsPerPage) {
  return rows <= rowsPerPage ? rows : Math.ceil(rows / rowsPerPage) * rowsPerPage;
}

export class GlyphAtlas {
  constructor(device, font, geometry, cellWidth, cellHeight, fontSize) {
    this.nextSlot = 0;
    this.device = device;
    this.textureVersion = 0;
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
    const rowsPerPage =
      geometry.rowsPerPage ?? Math.floor(this.device.limits.maxTextureDimension2D / tileHeight);
    if (
      !Number.isSafeInteger(rowsPerPage) ||
      rowsPerPage <= 0 ||
      rowsPerPage * tileHeight > this.device.limits.maxTextureDimension2D
    ) {
      throw new Error("invalid glyph atlas page height");
    }
    const preserve =
      !reset &&
      geometry.columns === this.columns &&
      geometry.width === this.width &&
      rowsPerPage === this.rowsPerPage &&
      tileWidth === this.tileWidth &&
      tileHeight === this.tileHeight;
    const candidate = {
      columns: geometry.columns,
      width: geometry.width,
      maxRows: geometry.rows,
      rowsPerPage,
      logicalCapacity: geometry.textureSlots,
      rows: preserve ? this.rows : allocatedRows(geometry.initialRows, rowsPerPage),
      colorRows: preserve ? this.colorRows : allocatedRows(geometry.initialRows, rowsPerPage),
      tileWidth,
      tileHeight,
      fontSize: roundedFontSize,
      preserve,
    };
    if (preserve) return candidate;
    try {
      candidate.texture = this.createTexture(
        "r8unorm",
        geometry.width,
        candidate.rows,
        rowsPerPage,
        tileHeight,
      );
      candidate.colorTexture = this.createTexture(
        "rgba8unorm",
        geometry.width,
        candidate.colorRows,
        rowsPerPage,
        tileHeight,
      );
      candidate.colorMapTexture = this.createTexture(
        "r32uint",
        geometry.columns,
        candidate.rows,
        rowsPerPage,
      );
      return candidate;
    } catch (error) {
      candidate.texture?.destroy();
      candidate.colorTexture?.destroy();
      candidate.colorMapTexture?.destroy();
      throw error;
    }
  }

  commitLayout(candidate) {
    if (!candidate.preserve) {
      this.texture?.destroy();
      this.colorTexture?.destroy();
      this.colorMapTexture?.destroy();
      this.nextSlot = 0;
      this.colorSlots = new Map();
      this.freeColorSlots = [];
      this.nextColorSlot = 0;
      this.textureVersion += 1;
    }
    const { preserve, ...layout } = candidate;
    Object.assign(this, layout);
  }

  createTexture(format, width, rows, rowsPerPage, tileHeight = 1) {
    const layers = Math.ceil(rows / rowsPerPage);
    if (layers > this.device.limits.maxTextureArrayLayers) {
      throw new RangeError("glyph atlas exceeds GPU array layer limit");
    }
    return this.device.createTexture({
      size: [width, Math.min(rows, rowsPerPage) * tileHeight, layers],
      format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
  }

  copyPages(encoder, source, destination, rows, width, tileHeight = 1) {
    const pageHeight = Math.min(rows, this.rowsPerPage) * tileHeight;
    for (let layer = 0; layer < Math.ceil(rows / this.rowsPerPage); layer++) {
      encoder.copyTextureToTexture(
        { texture: source, origin: [0, 0, layer] },
        { texture: destination, origin: [0, 0, layer] },
        [width, pageHeight, 1],
      );
    }
  }

  growCoverage(requiredSlots) {
    if (requiredSlots <= this.capacity) return;
    const rows = allocatedRows(
      growGlyphAtlasRows(this.rows, requiredSlots, this.columns, this.maxRows, this.rowsPerPage),
      this.rowsPerPage,
    );
    let texture;
    let colorMapTexture;
    try {
      texture = this.createTexture("r8unorm", this.width, rows, this.rowsPerPage, this.tileHeight);
      colorMapTexture = this.createTexture("r32uint", this.columns, rows, this.rowsPerPage);
      const encoder = this.device.createCommandEncoder();
      this.copyPages(encoder, this.texture, texture, this.rows, this.width, this.tileHeight);
      this.copyPages(encoder, this.colorMapTexture, colorMapTexture, this.rows, this.columns);
      this.device.queue.submit([encoder.finish()]);
    } catch (error) {
      texture?.destroy();
      colorMapTexture?.destroy();
      throw error;
    }
    this.texture.destroy();
    this.colorMapTexture.destroy();
    this.texture = texture;
    this.colorMapTexture = colorMapTexture;
    this.rows = rows;
    this.textureVersion += 1;
  }

  growColor(requiredSlots) {
    if (requiredSlots <= this.columns * this.colorRows) return;
    const rows = allocatedRows(
      growGlyphAtlasRows(
        this.colorRows,
        requiredSlots,
        this.columns,
        this.maxRows,
        this.rowsPerPage,
      ),
      this.rowsPerPage,
    );
    const texture = this.createTexture(
      "rgba8unorm",
      this.width,
      rows,
      this.rowsPerPage,
      this.tileHeight,
    );
    try {
      const encoder = this.device.createCommandEncoder();
      this.copyPages(
        encoder,
        this.colorTexture,
        texture,
        this.colorRows,
        this.width,
        this.tileHeight,
      );
      this.device.queue.submit([encoder.finish()]);
    } catch (error) {
      texture.destroy();
      throw error;
    }
    this.colorTexture.destroy();
    this.colorTexture = texture;
    this.colorRows = rows;
    this.textureVersion += 1;
  }

  validateUpload(firstSlot, slotCount, pixels, pixelOffset, bytesPerRow, channels) {
    if (
      !Number.isSafeInteger(firstSlot) ||
      firstSlot < 0 ||
      !Number.isSafeInteger(slotCount) ||
      slotCount <= 0 ||
      firstSlot + slotCount > this.logicalCapacity ||
      !Number.isSafeInteger(pixelOffset) ||
      pixelOffset < 0 ||
      !Number.isSafeInteger(bytesPerRow) ||
      bytesPerRow < slotCount * this.tileWidth * channels ||
      pixelOffset + (this.tileHeight - 1) * bytesPerRow + slotCount * this.tileWidth * channels >
        pixels.byteLength
    )
      throw new Error("invalid glyph bitmap upload");
  }

  releaseColor(slot) {
    const colorSlot = this.colorSlots.get(slot);
    if (colorSlot === undefined) return;
    this.colorSlots.delete(slot);
    this.freeColorSlots.push(colorSlot);
  }

  writeColorMappings(firstSlot, slotCount) {
    for (let offset = 0; offset < slotCount;) {
      const slot = firstSlot + offset;
      const count = Math.min(slotCount - offset, this.columns - (slot % this.columns));
      const values = new Uint32Array(count);
      for (let i = 0; i < count; i++) {
        const colorSlot = this.colorSlots.get(slot + i);
        values[i] = colorSlot === undefined ? 0 : colorSlot + 1;
      }
      this.device.queue.writeTexture(
        {
          texture: this.colorMapTexture,
          origin: [
            slot % this.columns,
            Math.floor(slot / this.columns) % this.rowsPerPage,
            Math.floor(slot / (this.columns * this.rowsPerPage)),
          ],
        },
        values,
        { bytesPerRow: count * 4 },
        [count, 1, 1],
      );
      offset += count;
    }
  }

  uploadBitmap(firstSlot, slotCount, pixels, pixelOffset, bytesPerRow) {
    this.validateUpload(firstSlot, slotCount, pixels, pixelOffset, bytesPerRow, 1);
    this.growCoverage(firstSlot + slotCount);
    for (let offset = 0; offset < slotCount;) {
      const slot = firstSlot + offset;
      const count = Math.min(slotCount - offset, this.columns - (slot % this.columns));
      this.device.queue.writeTexture(
        {
          texture: this.texture,
          origin: [
            (slot % this.columns) * this.tileWidth,
            (Math.floor(slot / this.columns) % this.rowsPerPage) * this.tileHeight,
            Math.floor(slot / (this.columns * this.rowsPerPage)),
          ],
        },
        pixels,
        { offset: pixelOffset + offset * this.tileWidth, bytesPerRow },
        [count * this.tileWidth, this.tileHeight, 1],
      );
      offset += count;
    }
    for (let i = 0; i < slotCount; i++) this.releaseColor(firstSlot + i);
    this.writeColorMappings(firstSlot, slotCount);
    this.nextSlot = Math.max(this.nextSlot, firstSlot + slotCount);
  }

  uploadColorBitmap(firstSlot, slotCount, pixels, pixelOffset, bytesPerRow) {
    this.validateUpload(firstSlot, slotCount, pixels, pixelOffset, bytesPerRow, 4);
    const bytes = ArrayBuffer.isView(pixels)
      ? new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength)
      : new Uint8Array(pixels);
    const colored = new Uint8Array(slotCount);
    let newColors = 0;
    let releasedColors = 0;
    for (let i = 0; i < slotCount; i++) {
      for (let y = 0; y < this.tileHeight && !colored[i]; y++) {
        const start = pixelOffset + y * bytesPerRow + i * this.tileWidth * 4;
        for (let x = 0; x < this.tileWidth; x++) {
          if (bytes[start + x * 4 + 3] !== 0) {
            colored[i] = 1;
            break;
          }
        }
      }
      const exists = this.colorSlots.has(firstSlot + i);
      if (colored[i] && !exists) newColors += 1;
      if (!colored[i] && exists) releasedColors += 1;
    }
    this.growCoverage(firstSlot + slotCount);
    this.growColor(
      this.nextColorSlot + Math.max(0, newColors - this.freeColorSlots.length - releasedColors),
    );
    for (let i = 0; i < slotCount; i++) {
      if (!colored[i]) this.releaseColor(firstSlot + i);
    }
    for (let i = 0; i < slotCount; i++) {
      if (!colored[i]) continue;
      const slot = firstSlot + i;
      let colorSlot = this.colorSlots.get(slot);
      if (colorSlot === undefined) {
        colorSlot = this.freeColorSlots.length ? this.freeColorSlots.pop() : this.nextColorSlot++;
        this.colorSlots.set(slot, colorSlot);
      }
      this.device.queue.writeTexture(
        {
          texture: this.colorTexture,
          origin: [
            (colorSlot % this.columns) * this.tileWidth,
            (Math.floor(colorSlot / this.columns) % this.rowsPerPage) * this.tileHeight,
            Math.floor(colorSlot / (this.columns * this.rowsPerPage)),
          ],
        },
        pixels,
        { offset: pixelOffset + i * this.tileWidth * 4, bytesPerRow },
        [this.tileWidth, this.tileHeight, 1],
      );
    }
    this.writeColorMappings(firstSlot, slotCount);
    this.nextSlot = Math.max(this.nextSlot, firstSlot + slotCount);
  }

  async readPixels() {
    if (!this.texture) throw new Error("Glyph texture is not ready; retry after rendering");
    const layout = glyphAtlasSnapshotLayout(this);
    const { width, height } = layout;
    const bytesPerRow = Math.ceil(width / 256) * 256;
    const buffer = this.device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    try {
      const encoder = this.device.createCommandEncoder();
      const pageHeight = Math.min(this.rows, this.rowsPerPage) * this.tileHeight;
      for (let layer = 0; layer < Math.ceil(this.rows / this.rowsPerPage); layer++) {
        encoder.copyTextureToBuffer(
          { texture: this.texture, origin: [0, 0, layer] },
          { buffer, offset: layer * pageHeight * bytesPerRow, bytesPerRow },
          [width, pageHeight, 1],
        );
      }
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
  async readColorPixels() {
    if (!this.colorTexture) throw new Error("Glyph texture is not ready; retry after rendering");
    const layout = glyphAtlasSnapshotLayout(this, true);
    const { width, height } = layout;
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const buffer = this.device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    try {
      const encoder = this.device.createCommandEncoder();
      const pageHeight = Math.min(this.colorRows, this.rowsPerPage) * this.tileHeight;
      for (let layer = 0; layer < Math.ceil(this.colorRows / this.rowsPerPage); layer++) {
        encoder.copyTextureToBuffer(
          { texture: this.colorTexture, origin: [0, 0, layer] },
          { buffer, offset: layer * pageHeight * bytesPerRow, bytesPerRow },
          [width, pageHeight, 1],
        );
      }
      this.device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const source = new Uint8Array(buffer.getMappedRange());
      const data = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++)
        data.set(source.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
      buffer.unmap();
      return { ...layout, format: "rgba8unorm", data };
    } finally {
      buffer.destroy();
    }
  }

  dispose() {
    this.texture?.destroy();
    this.texture = null;
    this.colorTexture?.destroy();
    this.colorTexture = null;
    this.colorMapTexture?.destroy();
    this.colorMapTexture = null;
    this.colorSlots.clear();
    this.freeColorSlots = [];
    this.nextColorSlot = 0;
  }
}
