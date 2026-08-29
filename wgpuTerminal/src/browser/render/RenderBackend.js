// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { GpuTerminal } from "./webgpu/GpuTerminal.js";
import { WebGlTerminal } from "./webgl/WebGlTerminal.js";

export function normalizeRenderBackend(value) {
  return value === "webgpu" || value === "webgl2" ? value : "auto";
}

export async function createRenderBackend(canvas, pixelViewport, textRenderer, requestedBackend = "auto") {
  const backend = normalizeRenderBackend(requestedBackend);
  if (backend === "webgpu") return GpuTerminal.create(canvas, pixelViewport, textRenderer);
  if (backend === "webgl2") return WebGlTerminal.create(canvas, pixelViewport, textRenderer);
  let webGpuError;
  try {
    return await GpuTerminal.create(canvas, pixelViewport, textRenderer);
  } catch (error) {
    webGpuError = error;
  }
  try {
    return await WebGlTerminal.create(canvas, pixelViewport, textRenderer);
  } catch (webGlError) {
    throw new AggregateError([webGpuError, webGlError], "No supported GPU render backend is available");
  }
}
