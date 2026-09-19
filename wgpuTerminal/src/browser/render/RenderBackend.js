// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { GpuTerminal } from "./webgpu/GpuTerminal.js";
import { WebGlTerminal } from "./webgl/WebGlTerminal.js";

let activeOwner;
let ownershipGeneration = 0;
let activeRenderer;

export function normalizeRenderBackend(value) {
  return value === "webgpu" || value === "webgl2" ? value : "auto";
}

export async function acquireRenderBackend(owner, canvas, pixelViewport, textRenderer, requestedBackend = "auto", glyphCacheMaxBytes, powerPreference) {
  if (activeOwner !== undefined) throw new Error("A render backend is already active");
  activeOwner = owner;
  const generation = ++ownershipGeneration;
  const current = () => activeOwner === owner && generation === ownershipGeneration;
  const accept = async (promise) => {
    const renderer = await promise;
    if (activeOwner !== owner || generation !== ownershipGeneration) {
      renderer.dispose();
      throw new Error('render backend acquisition cancelled');
    }
    activeRenderer = renderer;
    return renderer;
  };
  const backend = normalizeRenderBackend(requestedBackend);
  try {
    if (backend === "webgpu") return await accept(GpuTerminal.create(canvas, pixelViewport, textRenderer, glyphCacheMaxBytes, powerPreference, current));
    if (backend === "webgl2") return await accept(WebGlTerminal.create(canvas, pixelViewport, textRenderer, glyphCacheMaxBytes, powerPreference));
    let webGpuError;
    try {
      return await accept(GpuTerminal.create(canvas, pixelViewport, textRenderer, glyphCacheMaxBytes, powerPreference, current));
    } catch (error) {
      if (generation !== ownershipGeneration) throw error;
      webGpuError = error;
    }
    try {
      return await accept(WebGlTerminal.create(canvas, pixelViewport, textRenderer, glyphCacheMaxBytes, powerPreference));
    } catch (webGlError) {
      if (generation !== ownershipGeneration) throw webGlError;
      throw new AggregateError([webGpuError, webGlError], "No supported GPU render backend is available");
    }
  } catch (error) {
    if (generation === ownershipGeneration) {
      activeOwner = undefined;
      activeRenderer = undefined;
    }
    throw error;
  }
}

export function releaseRenderBackend(owner, renderer) {
  if (activeOwner !== owner) return;
  if (activeRenderer !== undefined && renderer !== activeRenderer) return;
  ++ownershipGeneration;
  activeOwner = undefined;
  activeRenderer = undefined;
  renderer?.dispose();
}
