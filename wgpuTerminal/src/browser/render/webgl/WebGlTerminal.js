// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { generateGrain, GRAIN_SIZE } from "../Grain.js";
import { CELL_SIZE, STYLE_SIZE } from "../FrameSchema.js";


import {
  initializeWebGl,
  resizeWebGl,
  ensureFrameCapacityWebGl,
  readWebGlPixels,
  disposeWebGl,
} from "./WebGlTerminalResources.js";
import {
  reconfigureGlyphAtlas,
  setTextRenderer,
} from "../GlyphAtlasRuntime.js";
import { WebGlGlyphAtlas } from "./WebGlGlyphAtlas.js";

function uploadIntegerRecords(gl, texture, textureWidth, first, count, components, format, source) {
  if (count === 0) return;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  let record = first;
  let consumed = 0;
  let remaining = count;
  while (remaining > 0) {
    const x = record % textureWidth;
    const y = Math.floor(record / textureWidth);
    const length = Math.min(remaining, textureWidth - x);
    const values = source.subarray(consumed * components, (consumed + length) * components);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, length, 1, format, gl.UNSIGNED_INT, values);
    record += length;
    consumed += length;
    remaining -= length;
  }
}

export class WebGlTerminal {
  static async create(canvas, pixelViewport, textRenderer, glyphCacheMaxBytes) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      desynchronized: true,
      failIfMajorPerformanceCaveat: true,
      powerPreference: "high-performance",
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      stencil: false,
    });
    if (!gl) throw new Error("WebGL2 context unavailable");
    let terminal = null;
    try {
      terminal = new WebGlTerminal(canvas, gl, textRenderer, glyphCacheMaxBytes);
      terminal.resize(pixelViewport.width, pixelViewport.height);
      return terminal;
    } catch (error) {
      if (terminal) terminal.dispose();
      else gl.getExtension("WEBGL_lose_context")?.loseContext();
      throw error;
    }
  }

  constructor(canvas, gl, textRenderer, glyphCacheMaxBytes) {
    this.canvas = canvas;
    this.gl = gl;
    this.glyphAtlasMaxDimension = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.textRenderer = textRenderer;
    this.glyphCacheMaxBytes = glyphCacheMaxBytes;
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    this.adapterInfo = {
      vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      architecture: "",
      device: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      description: gl.getParameter(gl.VERSION),
    };
    this.adapterFallback = /swiftshader|llvmpipe|software/i.test(Object.values(this.adapterInfo).join(" "));
    this.maxCells = 0;
    this.maxStyles = 0;
    this.styleSize = 0;
    this.cellSize = 0;
    this.cols = 0;
    this.rows = 0;
    this.viewportWidth = 0;
    this.viewportHeight = 0;
    this.pixelScaleX = 1;
    this.pixelScaleY = 1;
    this.physicalCellWidth = 1;
    this.physicalCellHeight = 1;
    this.physicalFontSize = 1;
    this.grainStrength = 4;
    this.glyphPartitions = null;
    this.glyphSlotsUsed = 0;
    this.activeTerminal = null;
    this.atlas = null;
    this.background = 0x111111;
    this.foreground = 0xeeeeee;
    this.cursorX = 0xffff;
    this.cursorY = 0xffff;
    this.cursorFlags = 0;
    this.cursorStyle = 1;
    this.fontReloads = 0;
    this.coreSwitches = 0;
    this.frames = 0;
    this.frameMs = null;
    this.presentationOpportunityMs = null;
    this.drawCalls = 0;
    this.rasterPasses = 0;
    this.drawnCellCount = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.error = null;
    this.initialized = false;
    this.blinkTimer = 0;
    this.submissionMetadata = {
      cols: 0,
      rows: 0,
      scrollTotal: 0,
      scrollOffset: 0,
      scrollLength: 0,
      viewportMode: "active",

    };
    this.contextLostListener = event => {
      event.preventDefault();
      this.error = "WebGL context lost; reload required";
    };
    this.contextRestoredListener = () => {
      this.error = "WebGL context restored; reload required";
    };
    canvas.addEventListener("webglcontextlost", this.contextLostListener);
    canvas.addEventListener("webglcontextrestored", this.contextRestoredListener);
  }

  initialize(maxCells) {
    return initializeWebGl(this, generateGrain(), GRAIN_SIZE,
      maxCells, Math.min(65536, maxCells + 1), STYLE_SIZE, CELL_SIZE);
  }





  reconfigureGlyphAtlas(metrics, textRenderer, fontFamily, activeVisibleSlots) {
    return reconfigureGlyphAtlas(this, metrics, textRenderer, fontFamily, activeVisibleSlots);
  }

  createGlyphAtlas(geometry, metrics) {
    const parent = this.canvas.parentElement;
    const { width, height, fontSize } = metrics;
    return new WebGlGlyphAtlas(this.gl, getComputedStyle(parent), geometry, width, height, fontSize);
  }

  setPhysicalCellMetrics(width, height, fontSize, columns, activeVisibleSlots) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isInteger(fontSize) ||
        !Number.isInteger(columns) || width <= 0 || height <= 0 || fontSize <= 0 || columns <= 0) {
      throw new Error("invalid physical cell metrics");
    }
    if (width === this.physicalCellWidth && height === this.physicalCellHeight &&
        fontSize === this.physicalFontSize) return null;
    return reconfigureGlyphAtlas(
      this,
      { width, height, fontSize, columns },
      this.textRenderer,
      undefined,
      activeVisibleSlots,
    );
  }

  setGrainStrength(value) {
    const strength = Number(value);
    if (!Number.isFinite(strength) || strength < 0 || strength > 32) throw new Error("invalid grain strength");
    if (strength === this.grainStrength) return;
    this.grainStrength = strength;
    if (this.initialized && this.rows) this.presenter?.present();
  }

  resize(width, height) {
    return resizeWebGl(this, width, height);
  }

  ensureFrameCapacity(cellCapacity) {
    return ensureFrameCapacityWebGl(this, cellCapacity);
  }

  reloadFont(fontFamily) {
    if (!this.initialized) throw new Error("GPU terminal is not initialized");
    const plan = reconfigureGlyphAtlas(
      this,
      {
        width: this.physicalCellWidth,
        height: this.physicalCellHeight,
        fontSize: this.physicalFontSize,
        columns: this.glyphPartitions.preferredColumns,
      },
      this.textRenderer,
      fontFamily,
    );
    this.fontReloads += 1;
    return plan;
  }


  setTextRenderer(textRenderer) {
    return setTextRenderer(this, textRenderer);
  }

  get atlasColumns() {
    if (!this.initialized) throw new Error("GPU terminal is not initialized");
    return this.atlas.columns;
  }

  uploadBitmap(...args) { this.atlas.uploadBitmap(...args); }

  uploadStyles(first, styles) {
    uploadIntegerRecords(this.gl, this.styleTexture, this.styleTextureWidth,
      first, styles.length / 3, 3, this.gl.RGB_INTEGER, styles);
  }

  uploadCells(firstRow, rowCount, cells, selections) {
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.cellBuffer);
    this.gl.bufferSubData(this.gl.ARRAY_BUFFER, firstRow * this.cols * this.cellSize, cells);
    uploadIntegerRecords(this.gl, this.selectionTexture, this.selectionTextureWidth,
      firstRow, rowCount, 1, this.gl.RED_INTEGER, selections);
  }

  uploadCanvasRun(...args) { this.atlas.setCanvasRun(...args); }

  presentCurrentState() {
    const gl = this.gl;
    if (!this.initialized || !this.rows || this.error || gl.isContextLost()) return;
    const startedAt = performance.now();
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vertexArray);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.uniform1ui(this.uniforms.cols, this.cols);
    gl.uniform1ui(this.uniforms.cell_width, this.physicalCellWidth);
    gl.uniform1ui(this.uniforms.cell_height, this.physicalCellHeight);
    gl.uniform1ui(this.uniforms.viewport_width, this.canvas.width);
    gl.uniform1ui(this.uniforms.viewport_height, this.canvas.height);
    gl.uniform1ui(this.uniforms.default_fg, this.foreground);
    gl.uniform1ui(this.uniforms.cursor_x, this.cursorX);
    gl.uniform1ui(this.uniforms.cursor_y, this.cursorY);
    gl.uniform1ui(this.uniforms.cursor_flags, this.cursorFlags);
    gl.uniform1ui(this.uniforms.cursor_style, this.cursorStyle);
    gl.uniform1ui(this.uniforms.atlas_cols, this.atlas.columns);
    gl.uniform1f(this.uniforms.grain_strength, this.grainStrength);
    gl.uniform1ui(this.uniforms.tile_width, this.atlas.tileWidth);
    gl.uniform1ui(this.uniforms.tile_height, this.atlas.tileHeight);
    gl.uniform1ui(this.uniforms.blink_on, Math.floor(performance.now() / 500) % 2 === 0 ? 1 : 0);
    gl.uniform1ui(this.uniforms.style_texture_width, this.styleTextureWidth);
    gl.uniform1ui(this.uniforms.selection_texture_width, this.selectionTextureWidth);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlas.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.styleTexture);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.selectionTexture);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.grainTexture);
    gl.clearColor(
      (this.background >> 16 & 255) / 255,
      (this.background >> 8 & 255) / 255,
      (this.background & 255) / 255,
      1,
    );
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.drawnCellCount);
    gl.flush();
    const submittedAt = performance.now();
    const elapsed = submittedAt - startedAt;
    this.frameMs = this.frameMs === null ? elapsed : this.frameMs * 0.8 + elapsed * 0.2;
    requestAnimationFrame(() => {
      const opportunity = performance.now() - submittedAt;
      this.presentationOpportunityMs = this.presentationOpportunityMs === null
        ? opportunity
        : this.presentationOpportunityMs * 0.8 + opportunity * 0.2;
    });
    this.frames += 1;
    this.drawCalls += 1;
    this.rasterPasses += 1;
  }

  readPixels() {
    return readWebGlPixels(this);
  }

  updateBlinkTimer() {
    const animated = (this.cursorFlags & 6) !== 0;
    if (!animated && this.blinkTimer) {
      clearTimeout(this.blinkTimer);
      this.blinkTimer = 0;
    } else if (animated && !this.blinkTimer) {
      this.blinkTimer = setTimeout(() => {
        this.blinkTimer = 0;
        this.presenter?.present();
        this.updateBlinkTimer();
      }, 500);
    }
  }

  dispose() {
    return disposeWebGl(this);
  }

  get stats() {
    return {
      backend: "webgl2",
      textRenderer: this.textRenderer,
      shaderF16: false,
      fontFamily: this.atlas.fontFamily,
      fontReloads: this.fontReloads,
      coreSwitches: this.coreSwitches,
      gpuFrames: this.frames,
      frameMs: this.frameMs,
      queueDrainMs: null,
      gpuFrameMs: null,
      presentationOpportunityMs: this.presentationOpportunityMs,
      bundleExecutions: 0,
      drawCalls: this.drawCalls,
      rasterPasses: this.rasterPasses,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      glyphSlotsUsed: this.glyphSlotsUsed,
      grainStrength: this.grainStrength,
      atlasCapacity: this.atlas.capacity,
      atlasRequiredSlots: this.glyphPartitions?.reservedSlots ?? 0,
      viewportWidth: this.viewportWidth,
      viewportHeight: this.viewportHeight,
      physicalCellWidth: this.physicalCellWidth,
      physicalCellHeight: this.physicalCellHeight,
      physicalFontSize: this.physicalFontSize,
      pixelScaleX: this.pixelScaleX,
      pixelScaleY: this.pixelScaleY,
      gpuAdapter: this.adapterInfo,
      gpuFallbackAdapter: this.adapterFallback,
      gpuError: this.error,
    };
  }
}
