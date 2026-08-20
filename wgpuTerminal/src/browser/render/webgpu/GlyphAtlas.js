// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

function createRasterCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  return canvas;
}

export class GlyphAtlas {
  constructor(device, font, requiredSlots, maxSlots, format, cellWidth, cellHeight, fontSize) {
    this.device = device;
    this.font = font;
    this.maxSlots = maxSlots;
    this.format = format;
    if (format !== "r8unorm" && format !== "rgba8unorm") throw new Error("invalid glyph atlas format");
    this.tileWidth = Math.max(2, Math.round(cellWidth) * 2);
    this.tileHeight = Math.max(2, Math.round(cellHeight));
    const maxDimension = device.limits.maxTextureDimension2D;
    const maxColumns = Math.floor(maxDimension / this.tileWidth);
    const maxRows = Math.floor(maxDimension / this.tileHeight);
    this.columns = Math.max(Math.min(256, maxColumns), Math.ceil(maxSlots / maxRows));
    if (maxColumns < 1 || maxRows < 1 || this.columns > maxColumns || maxSlots > this.columns * maxRows) {
      throw new Error("glyph atlas capacity exceeded");
    }
    this.fontFamily = font.fontFamily;
    this.fontSize = Math.max(1, Math.round(fontSize));
    this.baseline = Math.min(this.tileHeight - 1, Math.round((this.tileHeight - this.fontSize) * 0.5 + this.fontSize * 0.82));
    this.runCanvas = createRasterCanvas();
    this.runContext = this.runCanvas.getContext("2d", { alpha: true, willReadFrequently: true });
    this.runContext.textBaseline = "alphabetic";
    this.runContext.fillStyle = "white";
    this.runContext.textRendering = "geometricPrecision";
    this.nextSlot = 0;
    this.pendingTextureCopies = [];
    this.rows = Math.max(1, Math.ceil(requiredSlots / this.columns));
    this.texture = this.device.createTexture({
      size: [this.columns * this.tileWidth, this.rows * this.tileHeight],
      format: this.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    if (this.rows * this.columns < requiredSlots) throw new Error("glyph atlas capacity exceeded");
  }

  get capacity() {
    return this.columns * this.rows;
  }

  setFormat(format) {
    if (format !== "r8unorm" && format !== "rgba8unorm") throw new Error("invalid glyph atlas format");
    if (format === this.format) return false;
    for (const copy of this.pendingTextureCopies) copy.source.destroy();
    this.pendingTextureCopies = [];
    this.texture.destroy();
    this.format = format;
    this.nextSlot = 0;
    this.texture = this.device.createTexture({
      size: [this.columns * this.tileWidth, this.rows * this.tileHeight],
      format: this.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    return true;
  }

  ensureCapacity(requiredSlots) {
    if (requiredSlots <= this.capacity) return false;
    const maxRows = Math.floor(this.device.limits.maxTextureDimension2D / this.tileHeight);
    const rows = Math.ceil(Math.max(requiredSlots, Math.ceil(this.capacity * 1.5)) / this.columns);
    if (rows > maxRows || requiredSlots > this.maxSlots) throw new Error("glyph atlas capacity exceeded");
    const oldTexture = this.texture;
    const oldWidth = this.columns * this.tileWidth;
    const oldHeight = this.rows * this.tileHeight;
    this.rows = Math.max(1, rows);
    this.texture = this.device.createTexture({
      size: [oldWidth, this.rows * this.tileHeight],
      format: this.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    if (this.nextSlot > 0) {
      this.pendingTextureCopies.push({
        source: oldTexture,
        destination: this.texture,
        width: oldWidth,
        height: oldHeight,
      });
    } else {
      oldTexture?.destroy();
    }
    return true;
  }

  setCanvasRun(firstSlot, slotCount, spanCells, text, flags) {
    if (this.format !== "rgba8unorm") throw new Error("canvas glyph runs require rgba8unorm atlas format");
    if (!Number.isInteger(firstSlot) || !Number.isInteger(slotCount) || !Number.isInteger(spanCells) ||
        firstSlot < 0 || slotCount <= 0 || spanCells <= 0 ||
        (slotCount !== 1 && slotCount !== spanCells) || firstSlot + slotCount > this.capacity) {
      throw new Error("invalid glyph atlas run");
    }
    if (slotCount === 1 && spanCells > 2) throw new Error("invalid glyph atlas run");
    const cellWidth = this.tileWidth / 2;
    const runWidth = spanCells * cellWidth;
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
      const width = slotCount === 1 ? spanCells * cellWidth : cellWidth;
      this.device.queue.copyExternalImageToTexture(
        { source: this.runCanvas, origin: [index * cellWidth, 0] },
        {
          texture: this.texture,
          origin: [(slot % this.columns) * this.tileWidth, Math.floor(slot / this.columns) * this.tileHeight, 0],
          premultipliedAlpha: false,
        },
        [width, this.tileHeight, 1],
      );
    }
    this.nextSlot = Math.max(this.nextSlot, firstSlot + slotCount);
    return firstSlot + slotCount;
  }

  reloadFont(fontFamily) {
    if (typeof fontFamily !== "string" || fontFamily.trim() === "") throw new Error("invalid glyph font family");
    this.fontFamily = fontFamily;
    this.nextSlot = 0;
    this.runCanvas = new OffscreenCanvas(1, 1);
    this.runContext = this.runCanvas.getContext("2d", { alpha: true, willReadFrequently: true });
    this.runContext.textBaseline = "alphabetic";
    this.runContext.fillStyle = "white";
    this.runContext.textRendering = "geometricPrecision";
  }

  setPhysicalMetrics(cellWidth, cellHeight, fontSize) {
    if (!Number.isInteger(cellWidth) || !Number.isInteger(cellHeight) || !Number.isInteger(fontSize) ||
        cellWidth <= 0 || cellHeight <= 0 || fontSize <= 0) {
      throw new Error("invalid physical cell metrics");
    }
    const maxDimension = this.device.limits.maxTextureDimension2D;
    const tileWidth = cellWidth * 2;
    const tileHeight = cellHeight;
    if (tileWidth === this.tileWidth && tileHeight === this.tileHeight && fontSize === this.fontSize) return false;
    const maxColumns = Math.floor(maxDimension / tileWidth);
    const maxRows = Math.floor(maxDimension / tileHeight);
    const columns = Math.max(Math.min(256, maxColumns), Math.ceil(this.maxSlots / maxRows));
    if (maxColumns < 1 || maxRows < 1 || columns > maxColumns || this.maxSlots > columns * maxRows) {
      throw new Error("glyph atlas capacity exceeded");
    }
    const oldTexture = this.texture;
    for (const copy of this.pendingTextureCopies) copy.source.destroy();
    this.pendingTextureCopies = [];
    this.tileWidth = tileWidth;
    this.tileHeight = tileHeight;
    this.columns = columns;
    this.fontSize = fontSize;
    this.baseline = Math.min(this.tileHeight - 1, Math.round((this.tileHeight - this.fontSize) * 0.5 + this.fontSize * 0.82));
    this.rows = Math.max(1, Math.ceil(Math.min(256, this.maxSlots) / this.columns));
    this.texture = this.device.createTexture({
      size: [this.columns * this.tileWidth, this.rows * this.tileHeight],
      format: this.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.runCanvas = new OffscreenCanvas(1, 1);
    this.runContext = this.runCanvas.getContext("2d", { alpha: true, willReadFrequently: true });
    this.runContext.textBaseline = "alphabetic";
    this.runContext.fillStyle = "white";
    this.runContext.textRendering = "geometricPrecision";
    this.nextSlot = 0;
    oldTexture?.destroy();
    return true;
  }

  takePendingTextureCopies() {
    const copies = this.pendingTextureCopies;
    this.pendingTextureCopies = [];
    return copies;
  }
}
