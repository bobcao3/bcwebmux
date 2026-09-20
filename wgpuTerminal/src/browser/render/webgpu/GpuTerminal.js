// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import {
  initialize as initializeResources,
  ensureFrameCapacity as ensureFrameCapacityResources,
  rebuildCellBundle as rebuildCellBundleResources,
  setGrainStrength as setGrainStrengthResources,
  resize as resizeResources,
  readPixels as readPixelsResources,
  dispose as disposeResources,
} from "./GpuTerminalResources.js";
import { GlyphAtlas } from "./GlyphAtlas.js";
import {
  reconfigureGlyphAtlas as reconfigureGlyphAtlasGlyphAtlas,
  setTextRenderer as setTextRendererGlyphAtlas,
} from "../GlyphAtlasRuntime.js";


import { generateGrain, GRAIN_SIZE } from "../Grain.js";
import { CELL_SIZE, STYLE_SIZE } from "../FrameSchema.js";

const UNIFORM_BUFFER_SIZE = 68;

// JS drives WebGPU, but WASM owns the data-driven frame/cell/bitmap buffers shared across this boundary. CSS/DPR is converted once to integer raw-pixel font/cell metrics, which are then the single source of truth for both WASM rasterization and GPU uniforms.
export class GpuTerminal {
  static async create(canvas, pixelViewport, textRenderer, glyphCacheMaxBytes, powerPreference, isCurrent = () => true) {
    if (!navigator.gpu) throw new Error("WebGPU is unavailable; use an HTTPS or loopback origin with WebGPU support");
    const adapter = powerPreference === undefined
      ? await navigator.gpu.requestAdapter()
      : await navigator.gpu.requestAdapter({ powerPreference });
    if (!isCurrent()) throw new Error("render backend acquisition cancelled");
    if (!adapter) throw new Error("WebGPU adapter unavailable");
    const shaderF16 = adapter.features.has("shader-f16");
    const device = await adapter.requestDevice({
      requiredFeatures: shaderF16 ? ["shader-f16"] : [],
    });
    if (!isCurrent()) {
      device.destroy();
      throw new Error("render backend acquisition cancelled");
    }
    let terminal = null;
    try {
      terminal = new GpuTerminal(canvas, device, adapter, textRenderer, shaderF16, glyphCacheMaxBytes);
      terminal.resize(pixelViewport.width, pixelViewport.height);
      return terminal;
    } catch (error) {
      if (terminal) terminal.dispose();
      else device.destroy();
      throw error;
    }
  }

  constructor(canvas, device, adapter, textRenderer, shaderF16, glyphCacheMaxBytes) {
    this.canvas = canvas;
    this.device = device;
    this.glyphAtlasMaxDimension = device.limits.maxTextureDimension2D;
    this.textRenderer = textRenderer;
    this.shaderF16 = shaderF16;
    this.glyphCacheMaxBytes = glyphCacheMaxBytes;
    this.adapterInfo = {
      vendor: adapter.info?.vendor || "",
      architecture: adapter.info?.architecture || "",
      device: adapter.info?.device || "",
      description: adapter.info?.description || "",
    };
    this.adapterFallback = Boolean(adapter.isFallbackAdapter);
    this.context = canvas.getContext("webgpu");
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.maxCells = 0;
    this.cellSize = 0;
    this.uniformData = new ArrayBuffer(UNIFORM_BUFFER_SIZE);
    this.uniformU32 = new Uint32Array(this.uniformData);
    this.uniformF32 = new Float32Array(this.uniformData);
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
    this.maxStyles = 0;
    this.styleSize = 0;
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
    this.frameUploadBuffer = null;
    this.frameUploadCapacity = 0;
    this.frameUploadData = new ArrayBuffer(0);
    this.frameUploadBytes = new Uint8Array(this.frameUploadData);
    this.indirectDirty = true;
    this.fontReloads = 0;
    this.coreSwitches = 0;
    this.frames = 0;
    this.frameMs = null;
    this.gpuFrameMs = null;
    this.presentationOpportunityMs = null;
    this.disposed = false;
    this.queueProbePending = false;
    this.lastQueueProbeAt = -Infinity;
    this.bundleExecutions = 0;
    this.rasterPasses = 0;
    this.drawnCellCount = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.indirectData = new Uint32Array([6, 0, 0, 0]);
    this.error = null;
    this.initialized = false;
    this.device.lost.then(info => {
      if (!this.disposed) { this.error = `WebGPU device lost: ${info.message}`; this.onDeviceLost?.(this.error); }
    });
    this.onUncapturedError = event => {
      if (!this.disposed && this.error === null) { this.error = event.error.message; this.onFailure?.(this.error); }
    };
    this.device.addEventListener("uncapturederror", this.onUncapturedError);
  }

  async initialize(maxCells) {
    if (this.disposed) throw new Error("WebGPU renderer disposed during initialization");
    if (this.initialized) {
      this.ensureFrameCapacity(maxCells);
      return 1;
    }
    const response = await fetch(new URL("./shaders/cell.wgsl", import.meta.url));
    if (this.disposed) throw new Error("WebGPU renderer disposed during initialization");
    if (!response.ok) throw new Error(`cell shader load failed: ${response.status}`);
    const cellSource = await response.text();
    if (this.disposed) throw new Error("WebGPU renderer disposed during initialization");
    return initializeResources(this, cellSource, generateGrain(), GRAIN_SIZE,
      maxCells, Math.min(65536, maxCells + 1), STYLE_SIZE, CELL_SIZE);
  }

  createGlyphAtlas(geometry, metrics) {
    return new GlyphAtlas(
      this.device,
      getComputedStyle(this.canvas.parentElement),
      geometry,
      metrics.width,
      metrics.height,
      metrics.fontSize,
    );
  }

  glyphAtlasChanged() {
    if (!this.initialized) return;
    try {
      this.rebuildCellBundle();
    } catch (error) {
      this.error = error.message;
        this.onFailure?.(this.error);
      throw error;
    }
  }


  ensureFrameCapacity(cellCapacity) { return ensureFrameCapacityResources(this, cellCapacity); }




  reconfigureGlyphAtlas(metrics, textRenderer, fontFamily, activeVisibleSlots) { return reconfigureGlyphAtlasGlyphAtlas(this, metrics, textRenderer, fontFamily, activeVisibleSlots); }

  rebuildCellBundle() { return rebuildCellBundleResources(this); }

  ensureFrameUploadCapacity(size) {
    if (size <= this.frameUploadCapacity) return;
    const capacity = Math.ceil(Math.max(256, this.frameUploadCapacity * 2, size) / 256) * 256;
    const replacementBuffer = this.device.createBuffer({
      size: capacity,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    let replacementData;
    let replacementBytes;
    try {
      replacementData = new ArrayBuffer(capacity);
      replacementBytes = new Uint8Array(replacementData);
    } catch (error) {
      replacementBuffer.destroy();
      throw error;
    }
    this.frameUploadBuffer?.destroy();
    this.frameUploadBuffer = replacementBuffer;
    this.frameUploadCapacity = capacity;
    this.frameUploadData = replacementData;
    this.frameUploadBytes = replacementBytes;
  }

  setPhysicalCellMetrics(width, height, fontSize, columns, activeVisibleSlots) {
    if (![width, height, fontSize, columns].every(value => Number.isInteger(value) && value > 0)) {
      throw new Error("physical cell metrics and columns must be positive integers");
    }
    if (
      this.physicalCellWidth === width
      && this.physicalCellHeight === height
      && this.physicalFontSize === fontSize
    ) return null;
    return reconfigureGlyphAtlasGlyphAtlas(
      this,
      { width, height, fontSize, columns },
      this.textRenderer,
      this.atlas?.fontFamily,
      activeVisibleSlots,
    );
  }

  setGrainStrength(value) { return setGrainStrengthResources(this, value); }

  resize(widthValue, heightValue) { return resizeResources(this, widthValue, heightValue); }

  flushAtlasGrowthCopies() {
    const copies = this.atlas.takePendingTextureCopies();
    if (copies.length === 0) return;
    try {
      const encoder = this.device.createCommandEncoder();
      for (const copy of copies) {
        encoder.copyTextureToTexture(
          { texture: copy.source },
          { texture: copy.destination },
          [copy.width, copy.height, 1],
        );
      }
      this.device.queue.submit([encoder.finish()]);
    } catch (error) {
      this.atlas.pendingTextureCopies.unshift(...copies);
      throw error;
    }
    for (const copy of copies) copy.source.destroy();
  }

  reloadFont(fontFamily) {
    if (!this.initialized) throw new Error("GPU terminal is not initialized");
    const preferredColumns = this.glyphPartitions.preferredColumns;
    const plan = this.reconfigureGlyphAtlas(
      {
        width: this.physicalCellWidth,
        height: this.physicalCellHeight,
        fontSize: this.physicalFontSize,
        columns: preferredColumns,
      },
      this.textRenderer,
      fontFamily,
    );
    this.fontReloads += 1;
    return plan;
  }


  setTextRenderer(textRenderer) { return setTextRendererGlyphAtlas(this, textRenderer); }

  get atlasColumns() {
    if (!this.initialized) throw new Error("GPU terminal is not initialized");
    return this.atlas.columns;
  }

  uploadBitmap(firstSlot, slotCount, pixels, pixelOffset, bytesPerRow) {
    this.flushAtlasGrowthCopies();
    this.device.queue.writeTexture({ texture: this.atlas.texture, origin: [
      (firstSlot % this.atlas.columns) * this.atlas.tileWidth,
      Math.floor(firstSlot / this.atlas.columns) * this.atlas.tileHeight, 0,
    ] }, pixels, { offset: pixelOffset, bytesPerRow, rowsPerImage: this.atlas.tileHeight },
    [slotCount * this.atlas.tileWidth, this.atlas.tileHeight, 1]);
    this.atlas.nextSlot = Math.max(this.atlas.nextSlot, firstSlot + slotCount);
  }

  uploadStyles(first, styles, bytes) {
    if (bytes.byteLength) this.device.queue.writeBuffer(this.styleBuffer, first * this.styleSize, bytes);
  }

  uploadCells(firstRow, rowCount, cells, selections) {
    this.device.queue.writeBuffer(this.cellBuffer, firstRow * this.cols * this.cellSize, cells);
    this.device.queue.writeBuffer(this.selectionBuffer, firstRow * 4, selections);
  }


  presentCurrentState(blinkOn = true) {
    if (this.disposed || !this.offscreen || !this.rows || this.error) return;
    const drawStartedAt = performance.now();
    this.uniformU32[0] = this.cols;
    this.uniformU32[1] = this.rows;
    this.uniformU32[2] = this.physicalCellWidth;
    this.uniformU32[3] = this.physicalCellHeight;
    this.uniformU32[4] = this.canvas.width;
    this.uniformU32[5] = this.canvas.height;
    this.uniformU32[6] = this.background;
    this.uniformU32[7] = this.foreground;
    this.uniformU32[8] = this.cursorX;
    this.uniformU32[9] = this.cursorY;
    this.uniformU32[10] = this.cursorFlags;
    this.uniformU32[11] = this.cursorStyle;
    this.uniformU32[12] = this.atlas.columns;
    this.uniformF32[13] = this.grainStrength;
    this.uniformU32[14] = this.atlas.tileWidth;
    this.uniformU32[15] = this.atlas.tileHeight;
    this.uniformU32[16] = blinkOn ? 1 : 0;
    const indirectOffset = this.indirectDirty ? UNIFORM_BUFFER_SIZE : null;
    let stagingSize = UNIFORM_BUFFER_SIZE;
    if (indirectOffset !== null) stagingSize += 16;
    this.ensureFrameUploadCapacity(stagingSize);
    const staging = this.frameUploadBytes;
    staging.set(new Uint8Array(this.uniformData), 0);
    if (indirectOffset !== null) staging.set(new Uint8Array(this.indirectData.buffer), indirectOffset);
    const queue = this.device.queue;
    queue.writeBuffer(this.frameUploadBuffer, 0, this.frameUploadData, 0, stagingSize);
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.frameUploadBuffer, 0, this.uniformBuffer, 0, UNIFORM_BUFFER_SIZE);
    if (indirectOffset !== null) {
      encoder.copyBufferToBuffer(this.frameUploadBuffer, indirectOffset, this.drawIndirectBuffer, 0, 16);
      this.indirectDirty = false;
    }
    const textureCopies = this.atlas.takePendingTextureCopies();
    for (const copy of textureCopies) {
      encoder.copyTextureToTexture(
        { texture: copy.source },
        { texture: copy.destination },
        [copy.width, copy.height, 1],
      );
    }
    const r = (this.background >> 16 & 255) / 255;
    const g = (this.background >> 8 & 255) / 255;
    const b = (this.background & 255) / 255;
    const offscreen = encoder.beginRenderPass({
      colorAttachments: [{ view: this.offscreenView, clearValue: { r, g, b, a: 1 }, loadOp: "clear", storeOp: "store" }],
    });
    offscreen.executeBundles([this.cellBundle]);
    offscreen.end();
    encoder.copyTextureToTexture(
      { texture: this.offscreen },
      { texture: this.context.getCurrentTexture() },
      [this.canvas.width, this.canvas.height],
    );
    queue.submit([encoder.finish()]);
    for (const copy of textureCopies) copy.source.destroy();
    const submittedAt = performance.now();
    const frameMs = submittedAt - drawStartedAt;
    this.frameMs = this.frameMs === null ? frameMs : this.frameMs * 0.8 + frameMs * 0.2;
    const now = performance.now();
    if (!this.queueProbePending && now - this.lastQueueProbeAt >= 1000) {
      this.queueProbePending = true;
      this.lastQueueProbeAt = now;
      queue.onSubmittedWorkDone().then(() => {
        if (this.disposed) return;
        this.queueProbePending = false;
        const queueDrainMs = performance.now() - now;
        this.gpuFrameMs = this.gpuFrameMs === null ? queueDrainMs : this.gpuFrameMs * 0.8 + queueDrainMs * 0.2;
      }).catch(error => {
        if (this.disposed) return;
        this.queueProbePending = false;
        this.error = error.message;
        this.onFailure?.(this.error);
      });
    }
    this.frames += 1;
    this.bundleExecutions += 1;
    this.rasterPasses += 1;
  }

  readGlyphAtlas() { return this.atlas.readPixels(); }

  async readPixels() { return readPixelsResources(this); }


  dispose() { return disposeResources(this); }

  get stats() {
    return {
      backend: "webgpu",
      textRenderer: this.textRenderer,
      shaderF16: this.shaderF16,
      fontFamily: this.atlas.fontFamily,
      fontReloads: this.fontReloads,
      coreSwitches: this.coreSwitches,
      gpuFrames: this.frames,
      frameMs: this.frameMs,
      queueDrainMs: this.gpuFrameMs,
      gpuFrameMs: this.gpuFrameMs,
      presentationOpportunityMs: this.presentationOpportunityMs,
      bundleExecutions: this.bundleExecutions,
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
