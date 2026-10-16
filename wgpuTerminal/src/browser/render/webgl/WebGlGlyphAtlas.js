// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { validateAtlasGeometry } from "../CanvasAlphaMask.js";
import { growGlyphAtlasRows } from "../GlyphAtlasLimits.js";
import { glyphAtlasSnapshotLayout } from "../GlyphAtlasSnapshot.js";

export class WebGlGlyphAtlas {
  constructor(gl, font, geometry, cellWidth, cellHeight, fontSize) {
    this.nextSlot = 0;
    this.gl = gl;
    this.maxDimension = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.maxArrayLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS);
    this.texture = null;
    this.colorTexture = null;
    this.colorMapTexture = null;
    this.colorSlots = new Map();
    this.freeColorSlots = [];
    this.nextColorSlot = 0;
    this.commitLayout(this.prepareLayout(geometry, cellWidth, cellHeight, fontSize, true));
  }

  _createTexture(width, height, layers, internalFormat = this.gl.R8) {
    const gl = this.gl;
    const previous = gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY);
    const texture = gl.createTexture();
    if (!texture) throw new Error("WebGL glyph atlas allocation failed");
    try {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, internalFormat, width, height, layers);
      if (gl.getError() !== gl.NO_ERROR) {
        throw new Error("WebGL glyph atlas allocation failed");
      }
      return texture;
    } catch (error) {
      gl.deleteTexture(texture);
      throw error;
    } finally {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, previous);
    }
  }

  prepareLayout(geometry, cellWidth, cellHeight, fontSize, reset) {
    validateAtlasGeometry(geometry);
    if (
      !Number.isInteger(cellWidth) ||
      !Number.isInteger(cellHeight) ||
      !Number.isInteger(fontSize) ||
      cellWidth <= 0 ||
      cellHeight <= 0 ||
      fontSize <= 0
    ) {
      throw new Error("invalid physical cell metrics");
    }
    const tileWidth = Math.max(1, Math.round(cellWidth));
    const tileHeight = Math.max(1, Math.round(cellHeight));
    const width = geometry.width;
    const rowsPerPage = geometry.rowsPerPage;
    let initialRows = geometry.initialRows;
    if (
      !Number.isSafeInteger(width) ||
      width < 1 ||
      geometry.columns !== Math.floor(width / tileWidth) ||
      !Number.isInteger(initialRows) ||
      initialRows < 1 ||
      initialRows > geometry.rows ||
      width > this.maxDimension ||
      !Number.isSafeInteger(rowsPerPage) ||
      rowsPerPage * tileHeight > this.maxDimension ||
      rowsPerPage < 1 ||
      !Number.isInteger(geometry.maxLayers) ||
      geometry.maxLayers < 1 ||
      geometry.maxLayers > this.maxArrayLayers ||
      geometry.rows > rowsPerPage * geometry.maxLayers ||
      (geometry.rows > rowsPerPage && geometry.rows % rowsPerPage !== 0)
    ) {
      throw new Error("glyph atlas capacity exceeded");
    }
    if (initialRows > rowsPerPage) initialRows = Math.ceil(initialRows / rowsPerPage) * rowsPerPage;
    const preserve =
      !reset &&
      this.texture &&
      geometry.columns === this.columns &&
      tileWidth === this.tileWidth &&
      tileHeight === this.tileHeight &&
      rowsPerPage === this.rowsPerPage &&
      this.rows <= geometry.rows &&
      this.colorRows <= geometry.rows;
    const candidate = {
      width,
      columns: geometry.columns,
      rows: preserve ? this.rows : initialRows,
      colorRows: preserve ? this.colorRows : initialRows,
      maxRows: geometry.rows,
      rowsPerPage,
      maxLayers: geometry.maxLayers,
      initialRows,
      logicalCapacity: geometry.textureSlots,
      tileWidth,
      tileHeight,
      fontSize,
      preserve,
    };
    if (preserve) return candidate;
    const gl = this.gl;
    const pageRows = Math.min(initialRows, rowsPerPage);
    const layers = Math.ceil(initialRows / rowsPerPage);
    try {
      candidate.texture = this._createTexture(width, pageRows * tileHeight, layers, gl.R8);
      candidate.colorTexture = this._createTexture(width, pageRows * tileHeight, layers, gl.RGBA8);
      candidate.colorMapTexture = this._createTexture(geometry.columns, pageRows, layers, gl.R32UI);
      return candidate;
    } catch (error) {
      gl.deleteTexture(candidate.texture ?? null);
      gl.deleteTexture(candidate.colorTexture ?? null);
      gl.deleteTexture(candidate.colorMapTexture ?? null);
      throw error;
    }
  }

  commitLayout(candidate) {
    const gl = this.gl;
    if (!candidate.preserve) {
      gl.deleteTexture(this.texture);
      gl.deleteTexture(this.colorTexture);
      gl.deleteTexture(this.colorMapTexture);
      this.nextSlot = 0;
      this.colorSlots.clear();
      this.freeColorSlots.length = 0;
      this.nextColorSlot = 0;
    }
    const { preserve, ...layout } = candidate;
    Object.assign(this, layout);
  }

  _copyTexture(source, target, width, height, layers) {
    const gl = this.gl;
    const previousFramebuffer = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    const previousTexture = gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY);
    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) throw new Error("WebGL glyph atlas copy allocation failed");
    try {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, target);
      for (let layer = 0; layer < layers; layer++) {
        gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, source, 0, layer);
        if (gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error("WebGL glyph atlas copy framebuffer incomplete");
        }
        gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, 0, 0, width, height);
        if (gl.getError() !== gl.NO_ERROR) throw new Error("WebGL glyph atlas copy failed");
      }
    } finally {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, previousTexture);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previousFramebuffer);
      gl.deleteFramebuffer(framebuffer);
    }
  }

  _ensureRows(requiredSlots, color = false) {
    const gl = this.gl;
    const oldRows = color ? this.colorRows : this.rows;
    const rows = growGlyphAtlasRows(
      oldRows,
      requiredSlots,
      this.columns,
      this.maxRows,
      this.rowsPerPage,
    );
    if (rows === oldRows) return;
    const pageRows = Math.min(rows, this.rowsPerPage);
    const layers = Math.ceil(rows / this.rowsPerPage);
    const oldPageRows = Math.min(oldRows, this.rowsPerPage);
    const oldLayers = Math.ceil(oldRows / this.rowsPerPage);
    let texture = null;
    let colorMapTexture = null;
    try {
      texture = this._createTexture(
        this.width,
        pageRows * this.tileHeight,
        layers,
        color ? gl.RGBA8 : gl.R8,
      );
      this._copyTexture(
        color ? this.colorTexture : this.texture,
        texture,
        this.width,
        oldPageRows * this.tileHeight,
        oldLayers,
      );
      if (!color) {
        colorMapTexture = this._createTexture(this.columns, pageRows, layers, gl.R32UI);
        this._copyTexture(
          this.colorMapTexture,
          colorMapTexture,
          this.columns,
          oldPageRows,
          oldLayers,
        );
      }
    } catch (error) {
      gl.deleteTexture(texture);
      gl.deleteTexture(colorMapTexture);
      throw error;
    }
    if (color) {
      gl.deleteTexture(this.colorTexture);
      this.colorTexture = texture;
      this.colorRows = rows;
    } else {
      gl.deleteTexture(this.texture);
      gl.deleteTexture(this.colorMapTexture);
      this.texture = texture;
      this.colorMapTexture = colorMapTexture;
      this.rows = rows;
    }
  }

  _validateUpload(firstSlot, slotCount) {
    if (
      !Number.isInteger(firstSlot) ||
      !Number.isInteger(slotCount) ||
      firstSlot < 0 ||
      slotCount < 1 ||
      firstSlot + slotCount > this.logicalCapacity
    ) {
      throw new Error("invalid glyph atlas bitmap upload");
    }
    if ((firstSlot % this.columns) + slotCount > this.columns) {
      throw new Error("glyph atlas bitmap upload crosses a row");
    }
  }

  _upload(texture, x, y, layer, width, height, format, type, source, rowLength = 0) {
    const gl = this.gl;
    const previousTexture = gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY);
    const alignment = gl.getParameter(gl.UNPACK_ALIGNMENT);
    const previousRowLength = gl.getParameter(gl.UNPACK_ROW_LENGTH);
    const unpackNames = [
      gl.UNPACK_IMAGE_HEIGHT,
      gl.UNPACK_SKIP_PIXELS,
      gl.UNPACK_SKIP_ROWS,
      gl.UNPACK_SKIP_IMAGES,
    ];
    const unpackValues = unpackNames.map((name) => gl.getParameter(name));
    try {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, type === gl.UNSIGNED_INT ? 4 : 1);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, rowLength);
      for (const name of unpackNames) gl.pixelStorei(name, 0);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, x, y, layer, width, height, 1, format, type, source);
      if (gl.getError() !== gl.NO_ERROR) throw new Error("WebGL glyph atlas upload failed");
    } finally {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, alignment);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, previousRowLength);
      unpackNames.forEach((name, index) => gl.pixelStorei(name, unpackValues[index]));
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, previousTexture);
    }
  }

  _releaseColorSlot(slot) {
    const colorSlot = this.colorSlots.get(slot);
    if (colorSlot === undefined) return;
    this.colorSlots.delete(slot);
    this.freeColorSlots.push(colorSlot);
  }

  _uploadColorMap(firstSlot, values) {
    this._upload(
      this.colorMapTexture,
      firstSlot % this.columns,
      Math.floor(firstSlot / this.columns) % this.rowsPerPage,
      Math.floor(firstSlot / this.columns / this.rowsPerPage),
      values.length,
      1,
      this.gl.RED_INTEGER,
      this.gl.UNSIGNED_INT,
      values,
    );
  }

  uploadBitmap(firstSlot, slotCount, pixels, pixelOffset, bytesPerRow) {
    const gl = this.gl;
    this._validateUpload(firstSlot, slotCount);
    const width = slotCount * this.tileWidth;
    const length = bytesPerRow * this.tileHeight;
    if (
      !Number.isInteger(bytesPerRow) ||
      bytesPerRow < width ||
      !Number.isInteger(pixelOffset) ||
      pixelOffset < 0 ||
      pixelOffset + length > pixels.length
    ) {
      throw new Error("invalid glyph bitmap stride or source");
    }
    const source = pixels.subarray(pixelOffset, pixelOffset + length);
    this._ensureRows(firstSlot + slotCount);
    this._upload(
      this.texture,
      (firstSlot % this.columns) * this.tileWidth,
      (Math.floor(firstSlot / this.columns) % this.rowsPerPage) * this.tileHeight,
      Math.floor(firstSlot / this.columns / this.rowsPerPage),
      width,
      this.tileHeight,
      gl.RED,
      gl.UNSIGNED_BYTE,
      source,
      bytesPerRow,
    );
    for (let slot = firstSlot; slot < firstSlot + slotCount; slot++) this._releaseColorSlot(slot);
    this._uploadColorMap(firstSlot, new Uint32Array(slotCount));
    this.nextSlot = Math.max(this.nextSlot, firstSlot + slotCount);
  }

  uploadColorBitmap(firstSlot, slotCount, pixels, pixelOffset, bytesPerRow) {
    const gl = this.gl;
    this._validateUpload(firstSlot, slotCount);
    if (bytesPerRow !== slotCount * this.tileWidth * 4) {
      throw new Error("invalid color bitmap stride");
    }
    const length = bytesPerRow * this.tileHeight;
    if (!Number.isInteger(pixelOffset) || pixelOffset < 0 || pixelOffset + length > pixels.length) {
      throw new Error("invalid color bitmap source");
    }
    this._ensureRows(firstSlot + slotCount);
    const mappings = new Uint32Array(slotCount);
    for (let slot = firstSlot; slot < firstSlot + slotCount; slot++) this._releaseColorSlot(slot);
    this._uploadColorMap(firstSlot, mappings);
    const tileBytesPerRow = this.tileWidth * 4;
    const tilePixels = new Uint8Array(tileBytesPerRow * this.tileHeight);
    for (let index = 0; index < slotCount; index++) {
      let hasColor = false;
      for (let y = 0; y < this.tileHeight; y++) {
        const offset = pixelOffset + y * bytesPerRow + index * tileBytesPerRow;
        const row = pixels.subarray(offset, offset + tileBytesPerRow);
        tilePixels.set(row, y * tileBytesPerRow);
        for (let alpha = 3; alpha < row.length; alpha += 4) {
          if (row[alpha] !== 0) hasColor = true;
        }
      }
      const slot = firstSlot + index;
      if (!hasColor) continue;
      const colorSlot = this.freeColorSlots.at(-1) ?? this.nextColorSlot;
      this._ensureRows(colorSlot + 1, true);
      if (this.freeColorSlots.length) this.freeColorSlots.pop();
      else this.nextColorSlot++;
      this.colorSlots.set(slot, colorSlot);
      this._upload(
        this.colorTexture,
        (colorSlot % this.columns) * this.tileWidth,
        (Math.floor(colorSlot / this.columns) % this.rowsPerPage) * this.tileHeight,
        Math.floor(colorSlot / this.columns / this.rowsPerPage),
        this.tileWidth,
        this.tileHeight,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        tilePixels,
      );
      mappings[index] = colorSlot + 1;
    }
    this._uploadColorMap(firstSlot, mappings);
    this.nextSlot = Math.max(this.nextSlot, firstSlot + slotCount);
  }

  get capacity() {
    return this.columns * this.rows;
  }

  readPixels() {
    return this._readPixels(false);
  }

  readColorPixels() {
    return this._readPixels(true);
  }

  _readPixels(color) {
    const gl = this.gl;
    const texture = color ? this.colorTexture : this.texture;
    if (!texture || gl.isContextLost()) {
      throw new Error(
        color ? "Glyph color texture is unavailable" : "Glyph texture is unavailable",
      );
    }
    const virtualRows = color ? this.colorRows : this.rows;
    const layout = glyphAtlasSnapshotLayout(this, color);
    const { width, height } = layout;
    const previousFramebuffer = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    const packNames = [
      gl.PACK_ALIGNMENT,
      gl.PACK_ROW_LENGTH,
      gl.PACK_SKIP_PIXELS,
      gl.PACK_SKIP_ROWS,
    ];
    const packValues = packNames.map((name) => gl.getParameter(name));
    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) throw new Error("Glyph texture readback allocation failed");
    try {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
      gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
      for (let index = 1; index < packNames.length; index++) gl.pixelStorei(packNames[index], 0);
      const data = new Uint8Array(width * height * (color ? 4 : 1));
      const pageHeight = Math.min(virtualRows, this.rowsPerPage) * this.tileHeight;
      const layers = Math.ceil(virtualRows / this.rowsPerPage);
      const rgbaPage = new Uint8Array(width * pageHeight * 4);
      for (let layer = 0; layer < layers; layer++) {
        gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, texture, 0, layer);
        if (gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error("Glyph texture readback framebuffer incomplete");
        }
        // RGBA/UNSIGNED_BYTE reads are portable for normalized attachments, including R8.
        gl.readPixels(0, 0, width, pageHeight, gl.RGBA, gl.UNSIGNED_BYTE, rgbaPage);
        if (gl.getError() !== gl.NO_ERROR) {
          throw new Error("Glyph texture readback failed");
        }
        if (color) {
          data.set(rgbaPage, layer * rgbaPage.length);
        } else {
          const offset = layer * width * pageHeight;
          // Atlas uploads use row zero as the top.
          for (let index = 0; index < width * pageHeight; index++) {
            data[offset + index] = rgbaPage[index * 4];
          }
        }
      }
      return { ...layout, data };
    } finally {
      packNames.forEach((name, index) => gl.pixelStorei(name, packValues[index]));
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previousFramebuffer);
      gl.deleteFramebuffer(framebuffer);
    }
  }

  dispose() {
    this.gl.deleteTexture(this.texture);
    this.texture = null;
    this.gl.deleteTexture(this.colorTexture);
    this.colorTexture = null;
    this.gl.deleteTexture(this.colorMapTexture);
    this.colorMapTexture = null;
    this.colorSlots.clear();
    this.freeColorSlots.length = 0;
    this.nextColorSlot = 0;
  }
}
