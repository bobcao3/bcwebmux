// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const UNIFORM_BUFFER_SIZE = 72;
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

function validateRange(memoryLength, ptr, length, label) {
  if (!Number.isSafeInteger(ptr) || !Number.isSafeInteger(length) || ptr < 0 || length < 0 ||
      ptr > memoryLength || length > memoryLength - ptr) {
    throw new Error(`invalid submission ${label} range`);
  }
}

function validateRecords(memoryLength, ptr, count, size, label) {
  if (!Number.isSafeInteger(count) || count < 0 || count > Math.floor(Number.MAX_SAFE_INTEGER / size)) {
    throw new Error(`invalid submission ${label} count`);
  }
  validateRange(memoryLength, ptr, count * size, label);
}

function createRasterCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  return canvas;
}

class GlyphAtlas {
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
    // Half-pixel em adjustment accounts for Canvas2D's pixel-edge convention versus stb.
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
    if (typeof fontFamily !== "string" || fontFamily.trim() === "") {
      throw new Error("invalid glyph font family");
    }
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

  initialize(cellSource, grain, grainSize, maxCellsValue, maxGlyphsValue, maxStylesValue, styleSize, atlasSlots, cellSize) {
    if (this.initialized) return 1;
    if (!(grain instanceof Int8Array) || grainSize !== 64 || grain.length !== grainSize * grainSize) {
      throw new Error("invalid grain texture");
    }
    if (maxCellsValue <= 0 || maxGlyphsValue <= 0 || maxStylesValue <= 0 ||
        styleSize !== 12 || atlasSlots <= 0 || atlasSlots > maxGlyphsValue || cellSize !== 8) {
      throw new Error("invalid GPU initialization constants");
    }
    this.maxCells = maxCellsValue;
    this.maxGlyphs = maxGlyphsValue;
    this.maxStyles = maxStylesValue;
    this.styleSize = styleSize;
    this.atlasRequiredSlots = atlasSlots;
    this.cellSize = cellSize;
    const device = this.device;
    this.context.configure({
      device,
      format: this.format,
      alphaMode: "opaque",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
    });
    const font = getComputedStyle(this.canvas.parentElement);
    this.atlas = new GlyphAtlas(
      device,
      font,
      atlasSlots,
      this.maxGlyphs,
      this.textRenderer === "kb-canvas" ? "rgba8unorm" : "r8unorm",
      this.physicalCellWidth,
      this.physicalCellHeight,
      this.physicalFontSize,
    );
    this.uniformBuffer = device.createBuffer({ size: UNIFORM_BUFFER_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.cellBuffer = device.createBuffer({ size: maxCellsValue * cellSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.styleBuffer = device.createBuffer({ size: maxStylesValue * styleSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.selectionBuffer = device.createBuffer({ size: maxCellsValue * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.drawIndirectBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
    this.grainTexture = device.createTexture({
      size: [grainSize, grainSize],
      format: "r8snorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this.grainTexture },
      grain,
      { offset: 0, bytesPerRow: grainSize, rowsPerImage: grainSize },
      [grainSize, grainSize, 1],
    );
    const shaderMarker = "alias Lowp = f32;";
    if (!cellSource.includes(shaderMarker)) throw new Error("invalid cell shader source");
    const selectedCellSource = this.shaderF16
      ? cellSource.replace(shaderMarker, "enable f16;\nalias Lowp = f16;")
      : cellSource;
    const cellModule = device.createShaderModule({ code: selectedCellSource });
    this.cellPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: cellModule, entryPoint: "vertex" },
      fragment: { module: cellModule, entryPoint: "fragment", targets: [{ format: this.format }] },
      primitive: { topology: "triangle-list" },
    });
    this.rebuildCellBundle();
    this.initialized = true;
    return 1;
  }

  rebuildCellBundle() {
    this.cellBindGroup = this.device.createBindGroup({
      layout: this.cellPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.cellBuffer } },
        { binding: 2, resource: { buffer: this.styleBuffer } },
        { binding: 3, resource: { buffer: this.selectionBuffer } },
        { binding: 4, resource: this.atlas.texture.createView() },
        { binding: 5, resource: this.grainTexture.createView() },
      ],
    });
    const encoder = this.device.createRenderBundleEncoder({ colorFormats: [this.format] });
    encoder.setPipeline(this.cellPipeline);
    encoder.setBindGroup(0, this.cellBindGroup);
    encoder.drawIndirect(this.drawIndirectBuffer, 0);
    this.cellBundle = encoder.finish();
  }

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

  setPhysicalCellMetrics(width, height, fontSize) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isInteger(fontSize) ||
        width <= 0 || height <= 0 || fontSize <= 0) {
      throw new Error("invalid physical cell metrics");
    }
    this.physicalCellWidth = width;
    this.physicalCellHeight = height;
    this.physicalFontSize = fontSize;
    if (this.initialized && this.atlas.setPhysicalMetrics(width, height, fontSize)) this.rebuildCellBundle();
  }

  setGrainStrength(value) {
    const strength = Number(value);
    if (!Number.isFinite(strength) || strength < 0 || strength > 32) {
      throw new Error("invalid grain strength");
    }
    if (strength === this.grainStrength) return;
    this.grainStrength = strength;
    if (this.initialized && this.rows) this.draw();
  }

  resize(widthValue, heightValue) {
    const width = Math.round(Number(widthValue));
    const height = Math.round(Number(heightValue));
    const maxDimension = this.device.limits.maxTextureDimension2D;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 ||
        width > maxDimension || height > maxDimension) {
      throw new Error("invalid GPU viewport dimensions");
    }
    this.viewportWidth = width;
    this.viewportHeight = height;
    this.pixelScaleX = width / Math.max(1, this.canvas.clientWidth);
    this.pixelScaleY = height / Math.max(1, this.canvas.clientHeight);
    if (this.canvas.width === width && this.canvas.height === height && this.offscreen) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.offscreen?.destroy();
    this.offscreen = this.device.createTexture({
      size: [width, height],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.offscreenView = this.offscreen.createView();
    if (this.rows) this.draw();
  }

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

  reloadFont(fontFamily) {
    if (!this.initialized) throw new Error("GPU terminal is not initialized");
    this.atlas.reloadFont(fontFamily);
    this.rebuildCellBundle();
    this.fontReloads += 1;
  }

  setTextRenderer(textRenderer) {
    if (textRenderer !== "kb-stb" && textRenderer !== "kb-canvas") {
      throw new Error("invalid text renderer");
    }
    this.textRenderer = textRenderer;
    if (this.initialized && this.atlas.setFormat(textRenderer === "kb-canvas" ? "rgba8unorm" : "r8unorm")) {
      this.rebuildCellBundle();
    }
  }

  get atlasColumns() {
    if (!this.initialized) throw new Error("GPU terminal is not initialized");
    return this.atlas.columns;
  }

  submitWasm(memory, submissionPtr) {
    if (!this.initialized) throw new Error("GPU terminal is not initialized");
    if (!(memory instanceof ArrayBuffer)) throw new Error("invalid renderer memory");
    validateRange(memory.byteLength, submissionPtr, 112, "header");
    const submission = new DataView(memory, submissionPtr, 112);
    if (submission.getUint32(0, true) !== 0x5355424d || submission.getUint32(4, true) !== 2 || submission.getUint32(8, true) !== 112 || submission.getUint32(12, true) !== 0) {
      throw new Error("invalid renderer submission");
    }
    const framePtr = submission.getUint32(16, true);
    const frameLen = submission.getUint32(20, true);
    const cellsPtr = submission.getUint32(24, true);
    const cellsCount = submission.getUint32(28, true);
    const dirtyRangesPtr = submission.getUint32(32, true);
    const dirtyRangesCount = submission.getUint32(36, true);
    const stylesPtr = submission.getUint32(40, true);
    const stylesFirst = submission.getUint32(44, true);
    const stylesCount = submission.getUint32(48, true);
    const selectionsPtr = submission.getUint32(52, true);
    const selectionsCount = submission.getUint32(56, true);
    const bitmapUploadsPtr = submission.getUint32(60, true);
    const bitmapUploadsCount = submission.getUint32(64, true);
    const bitmapUploadPixelsPtr = submission.getUint32(68, true);
    const bitmapUploadPixelsLen = submission.getUint32(72, true);
    const canvasRequestsPtr = submission.getUint32(76, true);
    const canvasRequestsCount = submission.getUint32(80, true);
    const canvasTextPtr = submission.getUint32(84, true);
    const canvasTextLen = submission.getUint32(88, true);
    const textRowsPtr = submission.getUint32(92, true);
    const textCellsPtr = submission.getUint32(96, true);
    const textBytesPtr = submission.getUint32(100, true);
    const textBytesLen = submission.getUint32(104, true);
    const textChanged = submission.getUint32(108, true);
    if (frameLen !== 64) throw new Error("invalid renderer frame length");
    validateRange(memory.byteLength, framePtr, frameLen, "frame");
    const frame = new DataView(memory, framePtr, frameLen);
    validateRange(memory.byteLength, cellsPtr, cellsCount * this.cellSize, "cells");
    validateRecords(memory.byteLength, dirtyRangesPtr, dirtyRangesCount, 8, "dirty");
    const dirtyRangesView = new DataView(memory, dirtyRangesPtr, dirtyRangesCount * 8);
    validateRecords(memory.byteLength, stylesPtr + stylesFirst * 12, stylesCount, 12, "styles");
    validateRecords(memory.byteLength, selectionsPtr, selectionsCount, 4, "selections");
    validateRecords(memory.byteLength, bitmapUploadsPtr, bitmapUploadsCount, 16, "bitmap upload");
    const bitmapUploads = new DataView(memory, bitmapUploadsPtr, bitmapUploadsCount * 16);
    validateRecords(memory.byteLength, canvasRequestsPtr, canvasRequestsCount, 24, "Canvas");
    const canvases = new DataView(memory, canvasRequestsPtr, canvasRequestsCount * 24);
    validateRange(memory.byteLength, bitmapUploadPixelsPtr, bitmapUploadPixelsLen, "bitmap upload pixels");
    const bitmapUploadPixels = new Uint8Array(memory, bitmapUploadPixelsPtr, bitmapUploadPixelsLen);
    validateRange(memory.byteLength, canvasTextPtr, canvasTextLen, "Canvas text");
    validateRange(memory.byteLength, textBytesPtr, textBytesLen, "text bytes");
    if (frame.getUint32(0, true) !== 0x46574342 || frame.getUint32(4, true) !== 2) {
      throw new Error("invalid renderer frame");
    }
    const cols = frame.getUint32(8, true);
    const rows = frame.getUint32(12, true);
    const frameCells = frame.getUint32(16, true);
    if (cellsCount !== frameCells || frameCells !== cols * rows || frameCells > this.maxCells) {
      throw new Error(`terminal grid exceeds ${this.maxCells} GPU cells`);
    }
    if (selectionsCount !== rows) throw new Error("invalid renderer selections");
    if (stylesFirst + stylesCount > this.maxStyles) throw new Error("invalid renderer styles");
    for (let index = 0; index < dirtyRangesCount; index += 1) {
      const firstRow = dirtyRangesView.getUint32(index * 8, true);
      const rowCount = dirtyRangesView.getUint32(index * 8 + 4, true);
      if (rowCount === 0 || firstRow >= rows || rowCount > rows - firstRow) {
        throw new Error("invalid renderer dirty range");
      }
    }
    if (textChanged) {
      validateRecords(memory.byteLength, textRowsPtr, rows, 32, "text rows");
      validateRecords(memory.byteLength, textCellsPtr, cellsCount, 4, "text cells");
    }
    const atlasSlots = frame.getUint32(60, true);
    if (atlasSlots > this.maxGlyphs) throw new Error(`terminal glyph atlas exceeds ${this.maxGlyphs} glyphs`);
    for (let index = 0; index < bitmapUploadsCount; index += 1) {
      const base = index * 16;
      const firstSlot = bitmapUploads.getUint32(base, true);
      const slotCount = bitmapUploads.getUint32(base + 4, true);
      const pixelOffset = bitmapUploads.getUint32(base + 8, true);
      const bytesPerRow = bitmapUploads.getUint32(base + 12, true);
      const width = slotCount * this.atlas.tileWidth;
      const byteLength = bytesPerRow * this.atlas.tileHeight;
      if (this.atlas.format !== "r8unorm" || slotCount === 0 || firstSlot >= atlasSlots ||
          slotCount > atlasSlots - firstSlot || slotCount > this.atlas.columns - (firstSlot % this.atlas.columns) ||
          bytesPerRow !== width ||
          pixelOffset > bitmapUploadPixelsLen || byteLength > bitmapUploadPixelsLen - pixelOffset) {
        throw new Error("invalid renderer bitmap upload");
      }
    }
    for (let index = 0; index < canvasRequestsCount; index += 1) {
      const base = index * 24;
      const slot = canvases.getUint32(base, true);
      const slotCount = canvases.getUint32(base + 4, true);
      const spanCells = canvases.getUint32(base + 8, true);
      const offset = canvases.getUint32(base + 12, true);
      const length = canvases.getUint32(base + 16, true);
      if (slot >= atlasSlots || slotCount === 0 || slotCount > atlasSlots - slot ||
          spanCells === 0 || offset > canvasTextLen || length > canvasTextLen - offset) {
        throw new Error("invalid renderer Canvas request");
      }
    }
    const cacheData = frame.getUint32(20, true);
    this.cols = cols;
    this.rows = rows;
    this.cacheHits = cacheData >>> 16;
    this.cacheMisses = cacheData & 0xffff;
    this.background = frame.getUint32(24, true);
    this.foreground = frame.getUint32(28, true);
    this.cursorX = frame.getUint32(32, true);
    this.cursorY = frame.getUint32(36, true);
    this.cursorFlags = frame.getUint32(40, true);
    this.cursorStyle = frame.getUint32(44, true);
    const scrollTotal = frame.getUint32(48, true);
    const scrollOffset = frame.getUint32(52, true);
    const scrollLength = frame.getUint32(56, true);
    const atlasGrew = this.atlas.ensureCapacity(atlasSlots);
    if (atlasGrew) this.rebuildCellBundle();
    if (atlasGrew && (bitmapUploadsCount > 0 || canvasRequestsCount > 0)) this.flushAtlasGrowthCopies();
    for (let index = 0; index < bitmapUploadsCount; index += 1) {
      const base = index * 16;
      const firstSlot = bitmapUploads.getUint32(base, true);
      const slotCount = bitmapUploads.getUint32(base + 4, true);
      const pixelOffset = bitmapUploads.getUint32(base + 8, true);
      const bytesPerRow = bitmapUploads.getUint32(base + 12, true);
      this.device.queue.writeTexture(
        {
          texture: this.atlas.texture,
          origin: [
            (firstSlot % this.atlas.columns) * this.atlas.tileWidth,
            Math.floor(firstSlot / this.atlas.columns) * this.atlas.tileHeight,
            0,
          ],
        },
        bitmapUploadPixels,
        { offset: pixelOffset, bytesPerRow, rowsPerImage: this.atlas.tileHeight },
        [slotCount * this.atlas.tileWidth, this.atlas.tileHeight, 1],
      );
      this.atlas.nextSlot = Math.max(this.atlas.nextSlot, firstSlot + slotCount);
    }
    for (let index = 0; index < canvasRequestsCount; index += 1) {
      const base = index * 24;
      const slot = canvases.getUint32(base, true);
      const slotCount = canvases.getUint32(base + 4, true);
      const spanCells = canvases.getUint32(base + 8, true);
      const offset = canvases.getUint32(base + 12, true);
      const length = canvases.getUint32(base + 16, true);
      const flags = canvases.getUint32(base + 20, true);
      let text;
      try {
        text = strictDecoder.decode(new Uint8Array(memory, canvasTextPtr + offset, length));
      } catch {
        throw new Error("invalid renderer Canvas UTF-8");
      }
      this.atlas.setCanvasRun(slot, slotCount, spanCells, text, flags);
    }
    this.atlasRequiredSlots = atlasSlots;
    if (frameCells !== this.drawnCellCount) {
      this.drawnCellCount = frameCells;
      this.indirectData[1] = frameCells;
      this.indirectDirty = true;
    }
    this.submissionMetadata.cols = cols;
    this.submissionMetadata.rows = rows;
    this.submissionMetadata.scrollTotal = scrollTotal;
    this.submissionMetadata.scrollOffset = scrollOffset;
    this.submissionMetadata.scrollLength = scrollLength;
    this.submissionMetadata.textRowsPtr = textRowsPtr;
    this.submissionMetadata.textCellsPtr = textCellsPtr;
    this.submissionMetadata.textBytesPtr = textBytesPtr;
    this.submissionMetadata.textBytesLen = textBytesLen;
    this.submissionMetadata.textChanged = textChanged !== 0;
    this.submissionMemory = memory;
    this.submissionCellsPtr = cellsPtr;
    this.submissionDirtyRangesPtr = dirtyRangesPtr;
    this.submissionDirtyRangesCount = dirtyRangesCount;
    this.submissionStylesPtr = stylesPtr;
    this.submissionStylesFirst = stylesFirst;
    this.submissionStylesCount = stylesCount;
    this.submissionSelectionsPtr = selectionsPtr;
    this.submissionCanvasRequestsPtr = canvasRequestsPtr;
    this.submissionCanvasRequestsCount = canvasRequestsCount;
    this.draw(true);
    this.updateBlinkTimer();
    return this.submissionMetadata;
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

  async readPixels() {
    await this.device.queue.onSubmittedWorkDone();
    const width = this.canvas.width;
    const height = this.canvas.height;
    const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
    const buffer = this.device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const encoder = this.device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: this.offscreen },
      { buffer, bytesPerRow, rowsPerImage: height },
      [width, height, 1],
    );
    this.device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const source = new Uint8Array(buffer.getMappedRange());
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      data.set(source.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
    }
    buffer.unmap();
    buffer.destroy();
    return { width, height, format: this.format, data };
  }

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

  get stats() {
    return {
      backend: "webgpu",
      textRenderer: this.textRenderer,
      shaderF16: this.shaderF16,
      fontFamily: this.atlas.fontFamily,
      fontReloads: this.fontReloads,
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
