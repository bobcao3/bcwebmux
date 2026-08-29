// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

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

export class WebGlGlyphAtlas {
  constructor(gl, font, requiredSlots, maxSlots, format, cellWidth, cellHeight, fontSize) {
    this.gl = gl;
    this.maxSlots = maxSlots;
    this.format = format;
    this.maxDimension = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.tileWidth = Math.max(2, Math.round(cellWidth) * 2);
    this.tileHeight = Math.max(2, Math.round(cellHeight));
    this.columns = this._columns(this.tileWidth, this.tileHeight);
    this.rows = Math.max(1, Math.ceil(requiredSlots / this.columns));
    if (this.rows * this.columns < requiredSlots) throw new Error("glyph atlas capacity exceeded");
    this.fontFamily = font.fontFamily;
    this.fontSize = Math.max(1, Math.round(fontSize));
    this.baseline = this._baseline();
    this.runCanvas = createRasterCanvas();
    this.runContext = configureRasterContext(this.runCanvas);
    this.slotCanvas = createRasterCanvas();
    this.slotContext = configureRasterContext(this.slotCanvas);
    this.nextSlot = 0;
    this.texture = this._createTexture(this.columns * this.tileWidth, this.rows * this.tileHeight);
  }

  get capacity() {
    return this.columns * this.rows;
  }

  _baseline() {
    return Math.min(this.tileHeight - 1, Math.round((this.tileHeight - this.fontSize) * 0.5 + this.fontSize * 0.82));
  }

  _columns(tileWidth, tileHeight) {
    const maxColumns = Math.floor(this.maxDimension / tileWidth);
    const maxRows = Math.floor(this.maxDimension / tileHeight);
    const columns = Math.max(Math.min(256, maxColumns), Math.ceil(this.maxSlots / maxRows));
    if (maxColumns < 1 || maxRows < 1 || columns > maxColumns || this.maxSlots > columns * maxRows) {
      throw new Error("glyph atlas capacity exceeded");
    }
    return columns;
  }

  _createTexture(width, height) {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error("WebGL glyph atlas allocation failed");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const internalFormat = this.format === "rgba8unorm" ? gl.RGBA8 : gl.R8;
    gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, width, height);
    return texture;
  }

  setFormat(format) {
    if (format !== "r8unorm" && format !== "rgba8unorm") throw new Error("invalid glyph atlas format");
    if (format === this.format) return false;
    const gl = this.gl;
    gl.deleteTexture(this.texture);
    this.format = format;
    this.nextSlot = 0;
    this.texture = this._createTexture(this.columns * this.tileWidth, this.rows * this.tileHeight);
    return true;
  }

  ensureCapacity(requiredSlots) {
    if (requiredSlots <= this.capacity) return false;
    const maxRows = Math.floor(this.maxDimension / this.tileHeight);
    const rows = Math.ceil(Math.max(requiredSlots, Math.ceil(this.capacity * 1.5)) / this.columns);
    if (rows > maxRows || requiredSlots > this.maxSlots) throw new Error("glyph atlas capacity exceeded");
    const gl = this.gl;
    const oldTexture = this.texture;
    const oldWidth = this.columns * this.tileWidth;
    const oldHeight = this.rows * this.tileHeight;
    this.rows = Math.max(1, rows);
    this.texture = this._createTexture(oldWidth, this.rows * this.tileHeight);
    if (this.nextSlot > 0) {
      const framebuffer = gl.createFramebuffer();
      if (!framebuffer) throw new Error("WebGL glyph atlas copy allocation failed");
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, oldTexture, 0);
      if (gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.deleteFramebuffer(framebuffer);
        throw new Error("WebGL glyph atlas copy framebuffer incomplete");
      }
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, oldWidth, oldHeight);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.deleteFramebuffer(framebuffer);
    }
    gl.deleteTexture(oldTexture);
    return true;
  }

  uploadBitmap(firstSlot, slotCount, pixels, pixelOffset, bytesPerRow) {
    const gl = this.gl;
    const width = slotCount * this.tileWidth;
    const length = bytesPerRow * this.tileHeight;
    const source = pixels.subarray(pixelOffset, pixelOffset + length);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      (firstSlot % this.columns) * this.tileWidth,
      Math.floor(firstSlot / this.columns) * this.tileHeight,
      width,
      this.tileHeight,
      gl.RED,
      gl.UNSIGNED_BYTE,
      source,
    );
    this.nextSlot = Math.max(this.nextSlot, firstSlot + slotCount);
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
    if (this.runCanvas.width !== runWidth || this.runCanvas.height !== this.tileHeight) {
      this.runCanvas.width = runWidth;
      this.runCanvas.height = this.tileHeight;
      this.runContext = configureRasterContext(this.runCanvas);
    }
    const weight = (flags & 1) !== 0 ? "700" : "400";
    const italic = (flags & 2) !== 0 ? "italic" : "normal";
    this.runContext.clearRect(0, 0, runWidth, this.tileHeight);
    this.runContext.font = `${italic} ${weight} ${Math.max(1, this.fontSize - 0.5)}px ${this.fontFamily}`;
    this.runContext.fillText(text, 0, this.baseline);
    if (slotCount === 1) {
      this._uploadCanvas(firstSlot, this.runCanvas);
    } else {
      if (this.slotCanvas.width !== cellWidth || this.slotCanvas.height !== this.tileHeight) {
        this.slotCanvas.width = cellWidth;
        this.slotCanvas.height = this.tileHeight;
        this.slotContext = configureRasterContext(this.slotCanvas);
      }
      for (let index = 0; index < slotCount; index += 1) {
        this.slotContext.clearRect(0, 0, cellWidth, this.tileHeight);
        this.slotContext.drawImage(
          this.runCanvas,
          index * cellWidth,
          0,
          cellWidth,
          this.tileHeight,
          0,
          0,
          cellWidth,
          this.tileHeight,
        );
        this._uploadCanvas(firstSlot + index, this.slotCanvas);
      }
    }
    this.nextSlot = Math.max(this.nextSlot, firstSlot + slotCount);
    return firstSlot + slotCount;
  }

  _uploadCanvas(slot, canvas) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      (slot % this.columns) * this.tileWidth,
      Math.floor(slot / this.columns) * this.tileHeight,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      canvas,
    );
  }

  reloadFont(fontFamily) {
    if (typeof fontFamily !== "string" || fontFamily.trim() === "") throw new Error("invalid glyph font family");
    this.fontFamily = fontFamily;
    this.nextSlot = 0;
  }

  setPhysicalMetrics(cellWidth, cellHeight, fontSize) {
    if (!Number.isInteger(cellWidth) || !Number.isInteger(cellHeight) || !Number.isInteger(fontSize) ||
        cellWidth <= 0 || cellHeight <= 0 || fontSize <= 0) {
      throw new Error("invalid physical cell metrics");
    }
    const tileWidth = cellWidth * 2;
    const tileHeight = cellHeight;
    if (tileWidth === this.tileWidth && tileHeight === this.tileHeight && fontSize === this.fontSize) return false;
    const columns = this._columns(tileWidth, tileHeight);
    const gl = this.gl;
    gl.deleteTexture(this.texture);
    this.tileWidth = tileWidth;
    this.tileHeight = tileHeight;
    this.columns = columns;
    this.fontSize = fontSize;
    this.baseline = this._baseline();
    this.rows = Math.max(1, Math.ceil(Math.min(256, this.maxSlots) / this.columns));
    this.texture = this._createTexture(this.columns * this.tileWidth, this.rows * this.tileHeight);
    this.nextSlot = 0;
    return true;
  }

  dispose() {
    this.gl.deleteTexture(this.texture);
    this.texture = null;
  }
}
