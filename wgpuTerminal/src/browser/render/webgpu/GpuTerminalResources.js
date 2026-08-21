// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { GlyphAtlas } from "./GlyphAtlas.js";

const UNIFORM_BUFFER_SIZE = 72;

export function initialize(renderer, cellSource, grain, grainSize, maxCellsValue, maxGlyphsValue, maxStylesValue, styleSize, atlasSlots, cellSize) {
  if (renderer.initialized) {
    const matches = maxCellsValue === renderer.maxCells && maxGlyphsValue === renderer.maxGlyphs &&
      maxStylesValue === renderer.maxStyles && styleSize === renderer.styleSize &&
      cellSize === renderer.cellSize && grainSize === 64 && grain.length === grainSize * grainSize;
    if (!matches) throw new Error("terminal core renderer ABI mismatch");
    return 1;
  }
  if (!(grain instanceof Int8Array) || grainSize !== 64 || grain.length !== grainSize * grainSize) {
    throw new Error("invalid grain texture");
  }
  if (maxCellsValue <= 0 || maxGlyphsValue <= 0 || maxStylesValue <= 0 ||
      styleSize !== 12 || atlasSlots <= 0 || atlasSlots > maxGlyphsValue || cellSize !== 8) {
    throw new Error("invalid GPU initialization constants");
  }
  renderer.maxCells = maxCellsValue;
  renderer.maxGlyphs = maxGlyphsValue;
  renderer.maxStyles = maxStylesValue;
  renderer.styleSize = styleSize;
  renderer.atlasRequiredSlots = atlasSlots;
  renderer.cellSize = cellSize;
  const device = renderer.device;
  renderer.context.configure({
    device,
    format: renderer.format,
    alphaMode: "opaque",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
  });
  const font = getComputedStyle(renderer.canvas.parentElement);
  renderer.atlas = new GlyphAtlas(
    device,
    font,
    atlasSlots,
    renderer.maxGlyphs,
    renderer.textRenderer === "kb-canvas" ? "rgba8unorm" : "r8unorm",
    renderer.physicalCellWidth,
    renderer.physicalCellHeight,
    renderer.physicalFontSize,
  );
  renderer.uniformBuffer = device.createBuffer({ size: UNIFORM_BUFFER_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  renderer.cellBuffer = device.createBuffer({ size: maxCellsValue * cellSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  renderer.styleBuffer = device.createBuffer({ size: maxStylesValue * styleSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  renderer.selectionBuffer = device.createBuffer({ size: maxCellsValue * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  renderer.drawIndirectBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
  renderer.grainTexture = device.createTexture({
    size: [grainSize, grainSize],
    format: "r8snorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: renderer.grainTexture },
    grain,
    { offset: 0, bytesPerRow: grainSize, rowsPerImage: grainSize },
    [grainSize, grainSize, 1],
  );
  const shaderMarker = "alias Lowp = f32;";
  if (!cellSource.includes(shaderMarker)) throw new Error("invalid cell shader source");
  const selectedCellSource = renderer.shaderF16
    ? cellSource.replace(shaderMarker, "enable f16;\nalias Lowp = f16;")
    : cellSource;
  const cellModule = device.createShaderModule({ code: selectedCellSource });
  renderer.cellPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: cellModule, entryPoint: "vertex" },
    fragment: { module: cellModule, entryPoint: "fragment", targets: [{ format: renderer.format }] },
    primitive: { topology: "triangle-list" },
  });
  rebuildCellBundle(renderer);
  renderer.initialized = true;
  return 1;
}

export function rebuildCellBundle(renderer) {
  renderer.cellBindGroup = renderer.device.createBindGroup({
    layout: renderer.cellPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: renderer.uniformBuffer } },
      { binding: 1, resource: { buffer: renderer.cellBuffer } },
      { binding: 2, resource: { buffer: renderer.styleBuffer } },
      { binding: 3, resource: { buffer: renderer.selectionBuffer } },
      { binding: 4, resource: renderer.atlas.texture.createView() },
      { binding: 5, resource: renderer.grainTexture.createView() },
    ],
  });
  const encoder = renderer.device.createRenderBundleEncoder({ colorFormats: [renderer.format] });
  encoder.setPipeline(renderer.cellPipeline);
  encoder.setBindGroup(0, renderer.cellBindGroup);
  encoder.drawIndirect(renderer.drawIndirectBuffer, 0);
  renderer.cellBundle = encoder.finish();
}

export function setPhysicalCellMetrics(renderer, width, height, fontSize) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isInteger(fontSize) ||
      width <= 0 || height <= 0 || fontSize <= 0) {
    throw new Error("invalid physical cell metrics");
  }
  renderer.physicalCellWidth = width;
  renderer.physicalCellHeight = height;
  renderer.physicalFontSize = fontSize;
  if (renderer.initialized && renderer.atlas.setPhysicalMetrics(width, height, fontSize)) rebuildCellBundle(renderer);
}

export function setGrainStrength(renderer, value) {
  const strength = Number(value);
  if (!Number.isFinite(strength) || strength < 0 || strength > 32) throw new Error("invalid grain strength");
  if (strength === renderer.grainStrength) return;
  renderer.grainStrength = strength;
  if (renderer.initialized && renderer.rows) renderer.draw();
}

export function resize(renderer, widthValue, heightValue) {
  const width = Math.round(Number(widthValue));
  const height = Math.round(Number(heightValue));
  const maxDimension = renderer.device.limits.maxTextureDimension2D;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 ||
      width > maxDimension || height > maxDimension) {
    throw new Error("invalid GPU viewport dimensions");
  }
  renderer.viewportWidth = width;
  renderer.viewportHeight = height;
  renderer.pixelScaleX = width / Math.max(1, renderer.canvas.clientWidth);
  renderer.pixelScaleY = height / Math.max(1, renderer.canvas.clientHeight);
  if (renderer.canvas.width === width && renderer.canvas.height === height && renderer.offscreen) return;
  renderer.canvas.width = width;
  renderer.canvas.height = height;
  renderer.offscreen?.destroy();
  renderer.offscreen = renderer.device.createTexture({
    size: [width, height],
    format: renderer.format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  renderer.offscreenView = renderer.offscreen.createView();
  if (renderer.rows) renderer.draw();
}

export function reloadFont(renderer, fontFamily) {
  if (!renderer.initialized) throw new Error("GPU terminal is not initialized");
  renderer.atlas.reloadFont(fontFamily);
  rebuildCellBundle(renderer);
  renderer.fontReloads += 1;
}

export function resetForCore(renderer, fontFamily) {
  if (!renderer.initialized) throw new Error("GPU terminal is not initialized");
  if (renderer.blinkTimer) {
    clearTimeout(renderer.blinkTimer);
    renderer.blinkTimer = 0;
  }
  const pendingTextureCopies = renderer.atlas.takePendingTextureCopies();
  for (const copy of pendingTextureCopies) copy.source.destroy();
  renderer.atlas.reloadFont(fontFamily);
  rebuildCellBundle(renderer);
  Object.assign(renderer.submissionMetadata, {
    cols: 0,
    rows: 0,
    viewportMode: "active",
    scrollTotal: 0,
    scrollOffset: 0,
    scrollLength: 0,
    textRowsPtr: 0,
    textCellsPtr: 0,
    textBytesPtr: 0,
    textBytesLen: 0,
    textChanged: false,
  });
  renderer.submissionMemory = null;
  renderer.submissionCellsPtr = 0;
  renderer.submissionDirtyRangesPtr = 0;
  renderer.submissionDirtyRangesCount = 0;
  renderer.submissionStylesPtr = 0;
  renderer.submissionStylesFirst = 0;
  renderer.submissionStylesCount = 0;
  renderer.submissionSelectionsPtr = 0;
  renderer.submissionCanvasRequestsPtr = 0;
  renderer.submissionCanvasRequestsCount = 0;
  renderer.cols = 0;
  renderer.rows = 0;
  renderer.cursorFlags = 0;
  renderer.drawnCellCount = 0;
  renderer.atlasRequiredSlots = 0;
  renderer.indirectData[1] = 0;
  renderer.indirectDirty = true;
  renderer.coreSwitches += 1;
}

export function setTextRenderer(renderer, textRenderer) {
  if (textRenderer !== "kb-stb" && textRenderer !== "kb-canvas") throw new Error("invalid text renderer");
  renderer.textRenderer = textRenderer;
  if (renderer.initialized && renderer.atlas.setFormat(textRenderer === "kb-canvas" ? "rgba8unorm" : "r8unorm")) {
    rebuildCellBundle(renderer);
  }
}

export async function readPixels(renderer) {
  await renderer.device.queue.onSubmittedWorkDone();
  const width = renderer.canvas.width;
  const height = renderer.canvas.height;
  const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
  const buffer = renderer.device.createBuffer({
    size: bytesPerRow * height,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const encoder = renderer.device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: renderer.offscreen },
    { buffer, bytesPerRow, rowsPerImage: height },
    [width, height, 1],
  );
  renderer.device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const source = new Uint8Array(buffer.getMappedRange());
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    data.set(source.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
  }
  buffer.unmap();
  buffer.destroy();
  return { width, height, format: renderer.format, data };
}

export function dispose(renderer) {
  if (renderer.error === "disposed") return;
  if (renderer.blinkTimer) {
    clearTimeout(renderer.blinkTimer);
    renderer.blinkTimer = 0;
  }
  const pendingTextureCopies = renderer.atlas?.takePendingTextureCopies?.() ?? [];
  for (const copy of pendingTextureCopies) copy.source?.destroy?.();
  renderer.atlas?.texture?.destroy?.();
  renderer.offscreen?.destroy?.();
  renderer.frameUploadBuffer?.destroy?.();
  renderer.uniformBuffer?.destroy?.();
  renderer.cellBuffer?.destroy?.();
  renderer.styleBuffer?.destroy?.();
  renderer.selectionBuffer?.destroy?.();
  renderer.drawIndirectBuffer?.destroy?.();
  renderer.grainTexture?.destroy?.();
  renderer.device?.destroy?.();
  renderer.error = "disposed";
  renderer.initialized = false;
}
