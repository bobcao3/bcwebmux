// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

class GlyphAtlas {
  constructor(device, font, requiredSlots, cellWidth, cellHeight, fontSize) {
    this.device = device;
    this.font = font;
    this.tileWidth = Math.max(2, Math.round(cellWidth) * 2);
    this.tileHeight = Math.max(2, Math.round(cellHeight));
    this.columns = Math.max(1, Math.floor(device.limits.maxTextureDimension2D / this.tileWidth));
    this.fontFamily = font.fontFamily;
    this.fontSize = Math.max(1, Math.round(fontSize));
    this.baseline = Math.min(this.tileHeight - 1, Math.round((this.tileHeight - this.fontSize) * 0.5 + this.fontSize * 0.82));
    this.nextSlot = 0;
    this.dirtyStart = null;
    this.staging = new Uint8Array(0);
    this.rows = 0;
    this.glyphs = new Map();
    this.ensureCapacity(requiredSlots);
  }

  get capacity() {
    return this.columns * this.rows;
  }

  ensureCapacity(requiredSlots) {
    if (requiredSlots <= this.capacity) return false;
    const maxRows = Math.floor(this.device.limits.maxTextureDimension2D / this.tileHeight);
    const rows = Math.ceil(Math.max(requiredSlots, Math.ceil(this.capacity * 1.5)) / this.columns);
    if (rows > maxRows) throw new Error("glyph atlas capacity exceeded");
    const oldTexture = this.texture;
    const oldCanvas = this.canvas;
    this.rows = Math.max(1, rows);
    this.canvas = new OffscreenCanvas(this.columns * this.tileWidth, this.rows * this.tileHeight);
    this.context = this.canvas.getContext("2d", { alpha: true, willReadFrequently: true });
    if (oldCanvas) this.context.drawImage(oldCanvas, 0, 0);
    this.context.textBaseline = "alphabetic";
    this.context.fillStyle = "white";
    this.texture = this.device.createTexture({
      size: [this.canvas.width, this.canvas.height],
      format: "r8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    if (this.nextSlot > 0) this.dirtyStart = 0;
    oldTexture?.destroy();
    return true;
  }

  set(slot, text, flags) {
    if (slot >= this.capacity) throw new Error("glyph atlas slot out of range");
    this.nextSlot = Math.max(this.nextSlot, slot + 1);
    this.glyphs.set(slot, { text, flags });
    this.rasterize(slot, text, flags);
    this.dirtyStart = this.dirtyStart === null ? slot : Math.min(this.dirtyStart, slot);
    return slot + 1;
  }

  setBitmap(slot, pixels, width, height, stride) {
    if (slot >= this.capacity) throw new Error("glyph atlas slot out of range");
    if (!Number.isInteger(width) || !Number.isInteger(height) ||
        width <= 0 || height <= 0 || width > this.tileWidth || height > this.tileHeight ||
        !Number.isInteger(stride) || stride < width) {
      throw new Error("invalid glyph bitmap dimensions");
    }
    this.nextSlot = Math.max(this.nextSlot, slot + 1);
    this.glyphs.delete(slot);
    const x = (slot % this.columns) * this.tileWidth;
    const y = Math.floor(slot / this.columns) * this.tileHeight;
    this.context.clearRect(x, y, this.tileWidth, this.tileHeight);
    const image = new ImageData(this.tileWidth, this.tileHeight);
    for (let i = 0; i < image.data.length; i += 4) {
      image.data[i] = 255;
      image.data[i + 1] = 255;
      image.data[i + 2] = 255;
    }
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        image.data[(row * this.tileWidth + column) * 4 + 3] = pixels[row * stride + column];
      }
    }
    this.context.putImageData(image, x, y);
    this.dirtyStart = this.dirtyStart === null ? slot : Math.min(this.dirtyStart, slot);
    return slot + 1;
  }

  rasterize(slot, text, flags) {
    const x = (slot % this.columns) * this.tileWidth;
    const y = Math.floor(slot / this.columns) * this.tileHeight;
    this.context.save();
    this.context.beginPath();
    this.context.rect(x, y, this.tileWidth, this.tileHeight);
    this.context.clip();
    this.context.clearRect(x, y, this.tileWidth, this.tileHeight);
    const weight = (flags & 1) !== 0 ? "700" : "400";
    const italic = (flags & 2) !== 0 ? "italic" : "normal";
    this.context.font = `${italic} ${weight} ${this.fontSize}px ${this.fontFamily}`;
    this.context.fillText(text, x, y + this.baseline);
    this.context.restore();
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
    const columns = Math.max(1, Math.floor(maxDimension / tileWidth));
    const rows = Math.max(1, Math.ceil(Math.max(this.nextSlot, this.capacity) / columns));
    if (tileWidth > maxDimension || tileHeight > maxDimension ||
        rows > Math.floor(maxDimension / tileHeight)) {
      throw new Error("glyph atlas capacity exceeded");
    }
    const oldTexture = this.texture;
    this.tileWidth = tileWidth;
    this.tileHeight = tileHeight;
    this.columns = columns;
    this.fontSize = fontSize;
    this.baseline = Math.min(this.tileHeight - 1, Math.round((this.tileHeight - this.fontSize) * 0.5 + this.fontSize * 0.82));
    this.rows = rows;
    this.canvas = new OffscreenCanvas(this.columns * this.tileWidth, this.rows * this.tileHeight);
    this.context = this.canvas.getContext("2d", { alpha: true, willReadFrequently: true });
    this.context.textBaseline = "alphabetic";
    this.context.fillStyle = "white";
    this.texture = this.device.createTexture({
      size: [this.canvas.width, this.canvas.height],
      format: "r8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    for (const [slot, glyph] of this.glyphs) this.rasterize(slot, glyph.text, glyph.flags);
    this.dirtyStart = this.nextSlot > 0 ? 0 : null;
    oldTexture?.destroy();
    return true;
  }

  upload() {
    if (this.dirtyStart === null) return;
    for (let start = this.dirtyStart; start < this.nextSlot;) {
      const row = Math.floor(start / this.columns);
      const end = Math.min(this.nextSlot, (row + 1) * this.columns);
      const firstColumn = start % this.columns;
      const width = (end - start) * this.tileWidth;
      const bytesPerRow = Math.ceil(width / 256) * 256;
      if (this.staging.length < bytesPerRow * this.tileHeight) this.staging = new Uint8Array(bytesPerRow * this.tileHeight);
      const image = this.context.getImageData(firstColumn * this.tileWidth, row * this.tileHeight, width, this.tileHeight);
      this.staging.fill(0, 0, bytesPerRow * this.tileHeight);
      for (let y = 0; y < this.tileHeight; y += 1) {
        for (let x = 0; x < width; x += 1) this.staging[y * bytesPerRow + x] = image.data[(y * width + x) * 4 + 3];
      }
      this.device.queue.writeTexture(
        { texture: this.texture, origin: [firstColumn * this.tileWidth, row * this.tileHeight] },
        this.staging,
        { bytesPerRow, rowsPerImage: this.tileHeight },
        [width, this.tileHeight, 1],
      );
      start = end;
    }
    this.dirtyStart = null;
  }
}

// JS drives WebGPU, but WASM owns the data-driven frame/cell/bitmap buffers shared across this boundary. CSS/DPR is converted once to integer raw-pixel font/cell metrics, which are then the single source of truth for both WASM rasterization and GPU uniforms.
export class GpuTerminal {
  static async create(canvas, pixelViewport, textRenderer) {
    if (!navigator.gpu) throw new Error("WebGPU is unavailable; use an HTTPS or loopback origin with WebGPU support");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("WebGPU adapter unavailable");
    const device = await adapter.requestDevice();
    const terminal = new GpuTerminal(canvas, device, adapter, textRenderer);
    terminal.resize(pixelViewport.width, pixelViewport.height);
    return terminal;
  }

  constructor(canvas, device, adapter, textRenderer) {
    this.canvas = canvas;
    this.device = device;
    this.textRenderer = textRenderer;
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
    this.uniformData = new ArrayBuffer(64);
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
    this.maxGlyphs = 0;
    this.atlasRequiredSlots = 0;
    this.background = 0x111111;
    this.foreground = 0xeeeeee;
    this.cursorX = 0xffff;
    this.cursorY = 0xffff;
    this.cursorFlags = 0;
    this.cursorStyle = 1;
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
    this.device.lost.then(info => { this.error = `WebGPU device lost: ${info.message}`; });
    this.device.addEventListener("uncapturederror", event => { if (this.error === null) this.error = event.error.message; });
  }

  initialize(cellSource, maxCellsValue, maxGlyphsValue, atlasSlots, cellSize) {
    if (this.initialized) return 1;
    if (maxCellsValue <= 0 || maxGlyphsValue <= 0 || atlasSlots <= 0 || atlasSlots > maxGlyphsValue || cellSize <= 0 || cellSize % 4 !== 0) {
      throw new Error("invalid GPU initialization constants");
    }
    this.maxCells = maxCellsValue;
    this.maxGlyphs = maxGlyphsValue;
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
      this.physicalCellWidth,
      this.physicalCellHeight,
      this.physicalFontSize,
    );
    this.uniformBuffer = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.cellBuffer = device.createBuffer({ size: maxCellsValue * cellSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.drawIndirectBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
    const cellModule = device.createShaderModule({ code: cellSource });
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
        { binding: 2, resource: this.atlas.texture.createView() },
      ],
    });
    const encoder = this.device.createRenderBundleEncoder({ colorFormats: [this.format] });
    encoder.setPipeline(this.cellPipeline);
    encoder.setBindGroup(0, this.cellBindGroup);
    encoder.drawIndirect(this.drawIndirectBuffer, 0);
    this.cellBundle = encoder.finish();
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

  glyph(slot, text, flags) {
    if (slot >= this.maxGlyphs) throw new Error("glyph slot out of range");
    if (this.atlas.ensureCapacity(slot + 1)) this.rebuildCellBundle();
    this.atlas.set(slot, text, flags);
    return 1;
  }

  glyphBitmap(slot, pixels, width, height, stride) {
    if (slot >= this.maxGlyphs) throw new Error("glyph slot out of range");
    if (this.atlas.ensureCapacity(slot + 1)) this.rebuildCellBundle();
    this.atlas.setBitmap(slot, pixels, width, height, stride);
    return 1;
  }

  update(memory, framePtr, cellsPtr) {
    const frame = new DataView(memory, framePtr, 64);
    if (frame.getUint32(0, true) !== 0x46574342 || frame.getUint32(4, true) !== 2) throw new Error("invalid renderer frame");
    const cols = frame.getUint32(8, true);
    const rows = frame.getUint32(12, true);
    const cellCount = frame.getUint32(16, true);
    if (cellCount !== cols * rows || cellCount > this.maxCells) throw new Error(`terminal grid exceeds ${this.maxCells} GPU cells`);
    this.cols = cols;
    this.rows = rows;
    const cacheData = frame.getUint32(20, true);
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
    const atlasSlots = frame.getUint32(60, true);
    if (atlasSlots > this.maxGlyphs) throw new Error(`terminal glyph atlas exceeds ${this.maxGlyphs} glyphs`);
    if (this.atlas.ensureCapacity(atlasSlots)) this.rebuildCellBundle();
    this.atlasRequiredSlots = atlasSlots;
    if (cellCount !== this.drawnCellCount) {
      this.drawnCellCount = cellCount;
      this.indirectData[1] = cellCount;
      this.device.queue.writeBuffer(this.drawIndirectBuffer, 0, this.indirectData);
    }
    this.atlas.upload();
    this.device.queue.writeBuffer(this.cellBuffer, 0, memory, cellsPtr, cellCount * this.cellSize);
    this.draw();
    this.updateBlinkTimer();
    return { cols, rows, scrollTotal, scrollOffset, scrollLength };
  }

  draw() {
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
    this.uniformU32[13] = this.atlas.rows;
    this.uniformU32[14] = Math.floor(performance.now() / 500) % 2 === 0 ? 1 : 0;
    this.uniformU32[15] = this.cols * this.rows;
    const queue = this.device.queue;
    queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
    const encoder = this.device.createCommandEncoder();
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
      atlasFormat: "r8unorm",
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
