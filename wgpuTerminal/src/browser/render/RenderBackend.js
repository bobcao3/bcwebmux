// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { GpuTerminal } from "./webgpu/GpuTerminal.js";
import { WebGlTerminal } from "./webgl/WebGlTerminal.js";

let activeOwner;

export function normalizeRenderBackend(value) {
  return value === "webgpu" || value === "webgl2" ? value : "auto";
}

export async function acquireRenderBackend(owner, canvas, pixelViewport, textRenderer, requestedBackend = "auto", glyphCacheMaxBytes) {
  if (activeOwner !== undefined) throw new Error("A render backend is already active");
  activeOwner = owner;
  const backend = normalizeRenderBackend(requestedBackend);
  try {
    if (backend === "webgpu") return await GpuTerminal.create(canvas, pixelViewport, textRenderer, glyphCacheMaxBytes);
    if (backend === "webgl2") return await WebGlTerminal.create(canvas, pixelViewport, textRenderer, glyphCacheMaxBytes);
    let webGpuError;
    try {
      return await GpuTerminal.create(canvas, pixelViewport, textRenderer, glyphCacheMaxBytes);
    } catch (error) {
      webGpuError = error;
    }
    try {
      return await WebGlTerminal.create(canvas, pixelViewport, textRenderer, glyphCacheMaxBytes);
    } catch (webGlError) {
      throw new AggregateError([webGpuError, webGlError], "No supported GPU render backend is available");
    }
  } catch (error) {
    activeOwner = undefined;
    throw error;
  }
}

export function releaseRenderBackend(owner, renderer) {
  if (activeOwner !== owner) return;
  activeOwner = undefined;
  renderer.dispose();
}
