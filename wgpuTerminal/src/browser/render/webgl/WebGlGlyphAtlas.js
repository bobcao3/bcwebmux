// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { validateAtlasGeometry } from "../CanvasAlphaMask.js";
import { glyphAtlasSnapshotLayout } from "../GlyphAtlasSnapshot.js";

export class WebGlGlyphAtlas {
  constructor(gl, font, geometry, cellWidth, cellHeight, fontSize) {
    this.nextSlot = 0;
    this.gl = gl;
    this.maxDimension = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.texture = null;
    this.commitLayout(this.prepareLayout(geometry, cellWidth, cellHeight, fontSize, true));
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
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, width, height);
    return texture;
  }

  prepareLayout(geometry, cellWidth, cellHeight, fontSize, reset) {
    validateAtlasGeometry(geometry);
    if (!Number.isInteger(cellWidth) || !Number.isInteger(cellHeight) || !Number.isInteger(fontSize) ||
        cellWidth <= 0 || cellHeight <= 0 || fontSize <= 0) {
      throw new Error("invalid physical cell metrics");
    }
    const tileWidth = Math.max(1, Math.round(cellWidth));
    const tileHeight = Math.max(1, Math.round(cellHeight));
    const width = geometry.columns * tileWidth;
    const height = geometry.rows * tileHeight;
    if (width > this.maxDimension || height > this.maxDimension) {
      throw new Error("glyph atlas capacity exceeded");
    }
    const texture = this._createTexture(width, height);
    if (this.gl.getError() !== this.gl.NO_ERROR) {
      this.gl.deleteTexture(texture);
      throw new Error("WebGL glyph atlas allocation failed");
    }
    const preserve = !reset && this.texture &&
      geometry.columns === this.columns &&
      tileWidth === this.tileWidth &&
      tileHeight === this.tileHeight;
    return {
      columns: geometry.columns,
      rows: geometry.rows,
      tileWidth,
      tileHeight,
      fontSize,
      texture,
      preserve,
    };
  }

  commitLayout(candidate) {
    const gl = this.gl;
    const oldTexture = this.texture;
    if (candidate.preserve && oldTexture && candidate.rows >= this.rows && this.nextSlot > 0) {
      const framebuffer = gl.createFramebuffer();
      if (!framebuffer) {
        gl.deleteTexture(candidate.texture);
        throw new Error("WebGL glyph atlas copy allocation failed");
      }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, oldTexture, 0);
      if (gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.deleteFramebuffer(framebuffer);
        gl.deleteTexture(candidate.texture);
        throw new Error("WebGL glyph atlas copy framebuffer incomplete");
      }
      gl.bindTexture(gl.TEXTURE_2D, candidate.texture);
      gl.copyTexSubImage2D(
        gl.TEXTURE_2D, 0, 0, 0, 0, 0,
        this.columns * this.tileWidth,
        this.rows * this.tileHeight,
      );
      if (gl.getError() !== gl.NO_ERROR) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.deleteFramebuffer(framebuffer);
        gl.deleteTexture(candidate.texture);
        throw new Error("WebGL glyph atlas copy failed");
      }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.deleteFramebuffer(framebuffer);
    }
    this.columns = candidate.columns;
    this.rows = candidate.rows;
    this.tileWidth = candidate.tileWidth;
    this.tileHeight = candidate.tileHeight;
    this.fontSize = candidate.fontSize;
    this.texture = candidate.texture;
    if (oldTexture) gl.deleteTexture(oldTexture);
    if (!candidate.preserve) this.nextSlot = 0;
  }

  uploadBitmap(firstSlot, slotCount, pixels, pixelOffset, bytesPerRow) {
    const gl = this.gl;
    if (firstSlot % this.columns + slotCount > this.columns) {
      throw new Error("glyph atlas bitmap upload crosses a row");
    }
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

  get capacity() {
    return this.columns * this.rows;
  }

  readPixels() {
    const gl = this.gl;
    if (!this.texture || gl.isContextLost()) throw new Error("Glyph texture is unavailable");
    const layout = glyphAtlasSnapshotLayout(this);
    const { width, height } = layout;
    const previous = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) throw new Error("Glyph texture readback allocation failed");
    try {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
      if (gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error("Glyph texture readback framebuffer incomplete");
      }
      // RGBA/UNSIGNED_BYTE is portable for normalized attachments, including R8.
      const rgba = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      if (gl.getError() !== gl.NO_ERROR) throw new Error("Glyph texture readback failed");
      const data = new Uint8Array(width * height);
      // Atlas uploads use row zero as the top, unlike the terminal framebuffer.
      for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4];
      return { ...layout, data };
    } finally {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previous);
      gl.deleteFramebuffer(framebuffer);
    }
  }

  dispose() {
    this.gl.deleteTexture(this.texture);
    this.texture = null;
  }
}
