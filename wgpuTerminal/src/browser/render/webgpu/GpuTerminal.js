// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import {
  initialize as initializeResources,
  rebuildCellBundle as rebuildCellBundleResources,
  setPhysicalCellMetrics as setPhysicalCellMetricsResources,
  setGrainStrength as setGrainStrengthResources,
  resize as resizeResources,
  reloadFont as reloadFontResources,
  resetForCore as resetForCoreResources,
  setTextRenderer as setTextRendererResources,
  readPixels as readPixelsResources,
  dispose as disposeResources,
} from "./GpuTerminalResources.js";
import {
  parseRendererSubmission,
  decodeCanvasRequestText,
  applyRendererSubmission,
} from "../RendererSubmission.js";

const UNIFORM_BUFFER_SIZE = 72;

// JS drives WebGPU, but WASM owns the data-driven frame/cell/bitmap buffers shared across this boundary. CSS/DPR is converted once to integer raw-pixel font/cell metrics, which are then the single source of truth for both WASM rasterization and GPU uniforms.
export class GpuTerminal {
  static async create(canvas, pixelViewport, textRenderer) {
    if (!navigator.gpu) throw new Error("WebGPU is unavailable; use an HTTPS or loopback origin with WebGPU support");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("WebGPU adapter unavailable");
    const shaderF16 = adapter.features.has("shader-f16");
    const device = await adapter.requestDevice({
      requiredFeatures: shaderF16 ? ["shader-f16"] : [],
    });
    const terminal = new GpuTerminal(canvas, device, adapter, textRenderer, shaderF16);
    terminal.resize(pixelViewport.width, pixelViewport.height);
    return terminal;
  }

  constructor(canvas, device, adapter, textRenderer, shaderF16) {
    this.canvas = canvas;
    this.device = device;
    this.textRenderer = textRenderer;
    this.shaderF16 = shaderF16;
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
    this.maxGlyphs = 0;
    this.maxStyles = 0;
    this.styleSize = 0;
    this.atlasRequiredSlots = 0;
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
    this.blinkTimer = 0;
    this.submissionMetadata = {
      cols: 0,
      rows: 0,
      scrollTotal: 0,
      scrollOffset: 0,
      scrollLength: 0,
      viewportMode: "active",
      textRowsPtr: 0,
      textCellsPtr: 0,
      textBytesPtr: 0,
      textBytesLen: 0,
      textChanged: false,
    };
    this.submissionMemory = null;
    this.submissionCellsPtr = 0;
    this.submissionDirtyRangesPtr = 0;
    this.submissionDirtyRangesCount = 0;
    this.submissionStylesPtr = 0;
    this.submissionStylesFirst = 0;
    this.submissionStylesCount = 0;
    this.submissionSelectionsPtr = 0;
    this.submissionCanvasRequestsPtr = 0;
    this.submissionCanvasRequestsCount = 0;
    this.device.lost.then(info => { this.error = `WebGPU device lost: ${info.message}`; });
    this.device.addEventListener("uncapturederror", event => { if (this.error === null) this.error = event.error.message; });
  }

  initialize(cellSource, grain, grainSize, maxCellsValue, maxGlyphsValue, maxStylesValue, styleSize, atlasSlots, cellSize) { return initializeResources(this, cellSource, grain, grainSize, maxCellsValue, maxGlyphsValue, maxStylesValue, styleSize, atlasSlots, cellSize); }

  rebuildCellBundle() { return rebuildCellBundleResources(this); }

  ensureFrameUploadCapacity(size) {
    if (size <= this.frameUploadCapacity) return;
    this.frameUploadBuffer?.destroy();
    const capacity = Math.ceil(Math.max(256, this.frameUploadCapacity * 2, size) / 256) * 256;
    this.frameUploadBuffer = this.device.createBuffer({
      size: capacity,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.frameUploadCapacity = capacity;
    this.frameUploadData = new ArrayBuffer(capacity);
    this.frameUploadBytes = new Uint8Array(this.frameUploadData);
  }

  setPhysicalCellMetrics(width, height, fontSize) { return setPhysicalCellMetricsResources(this, width, height, fontSize); }

  setGrainStrength(value) { return setGrainStrengthResources(this, value); }

  resize(widthValue, heightValue) { return resizeResources(this, widthValue, heightValue); }

  flushAtlasGrowthCopies() {
    const copies = this.atlas.takePendingTextureCopies();
    if (copies.length === 0) return;
    const encoder = this.device.createCommandEncoder();
    for (const copy of copies) {
      encoder.copyTextureToTexture(
        { texture: copy.source },
        { texture: copy.destination },
        [copy.width, copy.height, 1],
      );
    }
    this.device.queue.submit([encoder.finish()]);
    for (const copy of copies) copy.source.destroy();
  }

  reloadFont(fontFamily) { return reloadFontResources(this, fontFamily); }

  resetForCore(fontFamily) { return resetForCoreResources(this, fontFamily); }

  setTextRenderer(textRenderer) { return setTextRendererResources(this, textRenderer); }

  get atlasColumns() {
    if (!this.initialized) throw new Error("GPU terminal is not initialized");
    return this.atlas.columns;
  }

  submitWasm(memory, submissionPtr) {
    const parsed = parseRendererSubmission(this, memory, submissionPtr);
    const metadata = applyRendererSubmission(this, parsed);
    const atlasGrew = this.atlas.ensureCapacity(parsed.atlasSlots);
    if (atlasGrew) this.rebuildCellBundle();
    if (atlasGrew && (parsed.bitmapUploadsCount > 0 || parsed.canvasRequestsCount > 0)) this.flushAtlasGrowthCopies();
    for (let index = 0; index < parsed.bitmapUploadsCount; index += 1) {
      const offset = index * 16;
      const firstSlot = parsed.bitmapUploads.getUint32(offset, true);
      const slotCount = parsed.bitmapUploads.getUint32(offset + 4, true);
      const pixelOffset = parsed.bitmapUploads.getUint32(offset + 8, true);
      const bytesPerRow = parsed.bitmapUploads.getUint32(offset + 12, true);
      this.device.queue.writeTexture(
        {
          texture: this.atlas.texture,
          origin: [
            (firstSlot % this.atlas.columns) * this.atlas.tileWidth,
            Math.floor(firstSlot / this.atlas.columns) * this.atlas.tileHeight,
            0,
          ],
        },
        parsed.bitmapUploadPixels,
        { offset: pixelOffset, bytesPerRow, rowsPerImage: this.atlas.tileHeight },
        [slotCount * this.atlas.tileWidth, this.atlas.tileHeight, 1],
      );
      this.atlas.nextSlot = Math.max(this.atlas.nextSlot, firstSlot + slotCount);
    }
    for (let index = 0; index < parsed.canvasRequestsCount; index += 1) {
      const offset = index * 24;
      const slot = parsed.canvasRequests.getUint32(offset, true);
      const slotCount = parsed.canvasRequests.getUint32(offset + 4, true);
      const spanCells = parsed.canvasRequests.getUint32(offset + 8, true);
      const flags = parsed.canvasRequests.getUint32(offset + 20, true);
      this.atlas.setCanvasRun(
        slot,
        slotCount,
        spanCells,
        decodeCanvasRequestText(parsed, index),
        flags,
      );
    }
    this.atlasRequiredSlots = parsed.atlasSlots;
    if (parsed.frameCells !== this.drawnCellCount) {
      this.drawnCellCount = parsed.frameCells;
      this.indirectData[1] = parsed.frameCells;
      this.indirectDirty = true;
    }
    this.draw(true);
    this.updateBlinkTimer();
    return metadata;
  }

  draw(hasSubmission = false) {
    if (!this.offscreen || !this.rows || this.error) return;
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
    this.uniformU32[16] = Math.floor(performance.now() / 500) % 2 === 0 ? 1 : 0;
    this.uniformU32[17] = this.atlas.format === "rgba8unorm" ? 1 : 0;
    const indirectOffset = this.indirectDirty ? UNIFORM_BUFFER_SIZE : null;
    let stagingSize = UNIFORM_BUFFER_SIZE;
    if (indirectOffset !== null) stagingSize += 16;
    let dirtyRangesView = null;
    let styleStagingOffset = 0;
    let rangesStagingOffset = 0;
    if (hasSubmission) {
      dirtyRangesView = new DataView(this.submissionMemory, this.submissionDirtyRangesPtr, this.submissionDirtyRangesCount * 8);
      styleStagingOffset = Math.ceil(stagingSize / 4) * 4;
      stagingSize = styleStagingOffset + this.submissionStylesCount * this.styleSize;
      rangesStagingOffset = stagingSize;
      for (let index = 0; index < this.submissionDirtyRangesCount; index += 1) {
        const firstRow = dirtyRangesView.getUint32(index * 8, true);
        const rowCount = dirtyRangesView.getUint32(index * 8 + 4, true);
        const cellLength = rowCount * this.cols * this.cellSize;
        const selectionLength = rowCount * 4;
        rangesStagingOffset = Math.ceil(rangesStagingOffset / 4) * 4 + cellLength;
        rangesStagingOffset = Math.ceil(rangesStagingOffset / 4) * 4 + selectionLength;
        void firstRow;
      }
      stagingSize = rangesStagingOffset;
    }
    this.ensureFrameUploadCapacity(stagingSize);
    const staging = this.frameUploadBytes;
    staging.set(new Uint8Array(this.uniformData), 0);
    if (indirectOffset !== null) staging.set(new Uint8Array(this.indirectData.buffer), indirectOffset);
    if (hasSubmission) {
      if (this.submissionStylesCount > 0) {
        const length = this.submissionStylesCount * this.styleSize;
        const offset = this.submissionStylesFirst * this.styleSize;
        staging.set(new Uint8Array(this.submissionMemory, this.submissionStylesPtr + offset, length), styleStagingOffset);
      }
      let rangeStagingOffset = rangesStagingOffset;
      for (let index = this.submissionDirtyRangesCount - 1; index >= 0; index -= 1) {
        const firstRow = dirtyRangesView.getUint32(index * 8, true);
        const rowCount = dirtyRangesView.getUint32(index * 8 + 4, true);
        const cellOffset = firstRow * this.cols * this.cellSize;
        const cellLength = rowCount * this.cols * this.cellSize;
        const selectionOffset = firstRow * 4;
        const selectionLength = rowCount * 4;
        rangeStagingOffset -= selectionLength;
        staging.set(new Uint8Array(this.submissionMemory, this.submissionSelectionsPtr + selectionOffset, selectionLength), rangeStagingOffset);
        rangeStagingOffset -= cellLength;
        staging.set(new Uint8Array(this.submissionMemory, this.submissionCellsPtr + cellOffset, cellLength), rangeStagingOffset);
      }
    }
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
    if (hasSubmission) {
      if (this.submissionStylesCount > 0) {
        const length = this.submissionStylesCount * this.styleSize;
        encoder.copyBufferToBuffer(
          this.frameUploadBuffer,
          styleStagingOffset,
          this.styleBuffer,
          this.submissionStylesFirst * this.styleSize,
          length,
        );
      }
      let rangeStagingOffset = rangesStagingOffset;
      for (let index = this.submissionDirtyRangesCount - 1; index >= 0; index -= 1) {
        const firstRow = dirtyRangesView.getUint32(index * 8, true);
        const rowCount = dirtyRangesView.getUint32(index * 8 + 4, true);
        const cellOffset = firstRow * this.cols * this.cellSize;
        const cellLength = rowCount * this.cols * this.cellSize;
        const selectionOffset = firstRow * 4;
        const selectionLength = rowCount * 4;
        rangeStagingOffset -= selectionLength;
        encoder.copyBufferToBuffer(this.frameUploadBuffer, rangeStagingOffset, this.selectionBuffer, selectionOffset, selectionLength);
        rangeStagingOffset -= cellLength;
        encoder.copyBufferToBuffer(this.frameUploadBuffer, rangeStagingOffset, this.cellBuffer, cellOffset, cellLength);
      }
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
    requestAnimationFrame(() => {
      const presentationOpportunityMs = performance.now() - submittedAt;
      this.presentationOpportunityMs = this.presentationOpportunityMs === null
        ? presentationOpportunityMs
        : this.presentationOpportunityMs * 0.8 + presentationOpportunityMs * 0.2;
    });
    const now = performance.now();
    if (!this.queueProbePending && now - this.lastQueueProbeAt >= 1000) {
      this.queueProbePending = true;
      this.lastQueueProbeAt = now;
      queue.onSubmittedWorkDone().then(() => {
        this.queueProbePending = false;
        const queueDrainMs = performance.now() - now;
        this.gpuFrameMs = this.gpuFrameMs === null ? queueDrainMs : this.gpuFrameMs * 0.8 + queueDrainMs * 0.2;
      }).catch(error => {
        this.queueProbePending = false;
        this.error = error.message;
      });
    }
    this.frames += 1;
    this.bundleExecutions += 1;
    this.rasterPasses += 1;
  }

  async readPixels() { return readPixelsResources(this); }

  updateBlinkTimer() {
    const animated = (this.cursorFlags & 6) !== 0;
    if (!animated && this.blinkTimer) {
      clearTimeout(this.blinkTimer);
      this.blinkTimer = 0;
      return;
    }
    if (animated && !this.blinkTimer) {
      this.blinkTimer = setTimeout(() => {
        this.blinkTimer = 0;
        this.draw();
        this.updateBlinkTimer();
      }, 500);
    }
  }

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
      atlasGlyphs: this.atlas.nextSlot,
      atlasFormat: this.atlas.format,
      grainStrength: this.grainStrength,
      atlasCapacity: this.atlas.capacity,
      atlasRequiredSlots: this.atlasRequiredSlots,
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
