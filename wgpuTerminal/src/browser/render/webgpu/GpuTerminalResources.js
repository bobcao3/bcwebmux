// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { CELL_SIZE, STYLE_SIZE } from "../FrameSchema.js";

const UNIFORM_BUFFER_SIZE = 68;

function validateFrameCapacity(renderer, cells, styles, cellSize, styleSize) {
  const limit = Math.min(renderer.device.limits.maxBufferSize, renderer.device.limits.maxStorageBufferBindingSize);
  if (cells * cellSize > limit || styles * styleSize > limit || cells * 4 > limit) {
    throw new Error("frame capacity exceeds GPU buffer limits");
  }
}

export function initialize(renderer, cellSource, grain, grainSize, maxCellsValue, maxStylesValue, styleSize, cellSize) {
  if (renderer.initialized) {
    const matches = styleSize === renderer.styleSize && cellSize === renderer.cellSize &&
      grainSize === 64 && grain.length === grainSize * grainSize;
    if (!matches) throw new Error("terminal renderer ABI mismatch");
    ensureFrameCapacity(renderer, maxCellsValue);
    return 1;
  }
  if (!renderer.atlas || !renderer.glyphPartitions) throw new Error("glyph atlas was not registered");
  if (!(grain instanceof Int8Array) || grainSize !== 64 || grain.length !== grainSize * grainSize) {
    throw new Error("invalid grain texture");
  }
  if (maxCellsValue <= 0 || maxStylesValue <= 0 || styleSize !== STYLE_SIZE || cellSize !== CELL_SIZE) {
    throw new Error("invalid GPU initialization constants");
  }
  validateFrameCapacity(renderer, maxCellsValue, maxStylesValue, cellSize, styleSize);
  Object.assign(renderer, { maxCells: maxCellsValue, maxStyles: maxStylesValue, styleSize, cellSize });
  const device = renderer.device;
  renderer.context.configure({
    device,
    format: renderer.format,
    alphaMode: "opaque",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
  });
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
  renderer.initialized = true;
  rebuildCellBundle(renderer);
  return 1;
}

export function ensureFrameCapacity(renderer, cellCapacity) {
  if (!Number.isSafeInteger(cellCapacity) || cellCapacity <= 0) {
    throw new Error("invalid frame capacity");
  }
  if (!renderer.initialized) return false;
  const styleCapacity = Math.min(65536, cellCapacity + 1);
  if (renderer.maxCells >= cellCapacity && renderer.maxStyles >= styleCapacity) return false;
  const maxCells = Math.max(renderer.maxCells, cellCapacity);
  const maxStyles = Math.max(renderer.maxStyles, styleCapacity);
  validateFrameCapacity(renderer, maxCells, maxStyles, renderer.cellSize, renderer.styleSize);
  const device = renderer.device;
  let cellBuffer = null;
  let styleBuffer = null;
  let selectionBuffer = null;
  try {
    cellBuffer = device.createBuffer({ size: maxCells * renderer.cellSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    styleBuffer = device.createBuffer({ size: maxStyles * renderer.styleSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    selectionBuffer = device.createBuffer({ size: maxCells * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  } catch (error) {
    cellBuffer?.destroy();
    styleBuffer?.destroy();
    selectionBuffer?.destroy();
    throw error;
  }
  const oldCellBuffer = renderer.cellBuffer;
  const oldStyleBuffer = renderer.styleBuffer;
  const oldSelectionBuffer = renderer.selectionBuffer;
  const oldMaxCells = renderer.maxCells;
  const oldMaxStyles = renderer.maxStyles;
  renderer.cellBuffer = cellBuffer;
  renderer.styleBuffer = styleBuffer;
  renderer.selectionBuffer = selectionBuffer;
  renderer.maxCells = maxCells;
  renderer.maxStyles = maxStyles;
  try {
    rebuildCellBundle(renderer);
  } catch (error) {
    renderer.cellBuffer = oldCellBuffer;
    renderer.styleBuffer = oldStyleBuffer;
    renderer.selectionBuffer = oldSelectionBuffer;
    renderer.maxCells = oldMaxCells;
    renderer.maxStyles = oldMaxStyles;
    cellBuffer.destroy();
    styleBuffer.destroy();
    selectionBuffer.destroy();
    throw error;
  }
  oldCellBuffer.destroy();
  oldStyleBuffer.destroy();
  oldSelectionBuffer.destroy();
  return true;
}

export function rebuildCellBundle(renderer) {
  const cellBindGroup = renderer.device.createBindGroup({
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
  encoder.setBindGroup(0, cellBindGroup);
  encoder.drawIndirect(renderer.drawIndirectBuffer, 0);
  const cellBundle = encoder.finish();
  renderer.cellBindGroup = cellBindGroup;
  renderer.cellBundle = cellBundle;
}

export function setGrainStrength(renderer, value) {
  const strength = Number(value);
  if (!Number.isFinite(strength) || strength < 0 || strength > 32) throw new Error("invalid grain strength");
  if (strength === renderer.grainStrength) return;
  renderer.grainStrength = strength;
  if (renderer.initialized && renderer.rows) renderer.presenter?.requestPresentation();
}

export function resize(renderer, widthValue, heightValue) {
  const width = Math.round(Number(widthValue));
  const height = Math.round(Number(heightValue));
  const maximum = renderer.device.limits.maxTextureDimension2D;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > maximum || height > maximum) {
    throw new Error("invalid GPU viewport dimensions");
  }
  const pixelScaleX = width / Math.max(1, renderer.canvas.clientWidth);
  const pixelScaleY = height / Math.max(1, renderer.canvas.clientHeight);
  if (renderer.canvas.width === width && renderer.canvas.height === height && renderer.offscreen) {
    renderer.viewportWidth = width;
    renderer.viewportHeight = height;
    renderer.pixelScaleX = pixelScaleX;
    renderer.pixelScaleY = pixelScaleY;
    return;
  }
  let offscreen = null;
  let offscreenView = null;
  try {
    offscreen = renderer.device.createTexture({
      size: [width, height],
      format: renderer.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    offscreenView = offscreen.createView();
  } catch (error) {
    offscreen?.destroy();
    throw error;
  }
  const oldOffscreen = renderer.offscreen;
  renderer.viewportWidth = width;
  renderer.viewportHeight = height;
  renderer.pixelScaleX = pixelScaleX;
  renderer.pixelScaleY = pixelScaleY;
  renderer.canvas.width = width;
  renderer.canvas.height = height;
  renderer.offscreen = offscreen;
  renderer.offscreenView = offscreenView;
  oldOffscreen?.destroy();
  if (renderer.rows) renderer.presenter?.requestPresentation();
}

export async function readPixels(renderer) {
  await renderer.device.queue.onSubmittedWorkDone();
  if (renderer.disposed) throw new Error("renderer disposed");
  const width = renderer.canvas.width;
  const height = renderer.canvas.height;
  const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
  const buffer = renderer.device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  try {
    const encoder = renderer.device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: renderer.offscreen }, { buffer, bytesPerRow, rowsPerImage: height }, [width, height, 1]);
    renderer.device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const source = new Uint8Array(buffer.getMappedRange());
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) data.set(source.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
    buffer.unmap();
    return { width, height, format: renderer.format, data };
  } finally {
    buffer.destroy();
  }
}

export function dispose(renderer) {
  if (renderer.disposed) return;
  renderer.disposed = true;
  renderer.device?.removeEventListener("uncapturederror", renderer.onUncapturedError);
  renderer.queueProbePending = false;
  renderer.atlas?.dispose?.();
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
