// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { computeGlyphAtlasLimits } from "./GlyphAtlasLimits.js";
import { GlyphAtlasPartitions } from "./GlyphAtlasPartitions.js";

function metrics(renderer) {
  return {
    width: renderer.physicalCellWidth,
    height: renderer.physicalCellHeight,
    fontSize: renderer.physicalFontSize,
  };
}

function limits(renderer, width, height) {
  return computeGlyphAtlasLimits({
    maxTextureDimension: renderer.glyphAtlasMaxDimension,
    cellWidth: width,
    cellHeight: height,
    configuredMaxBytes: renderer.glyphCacheMaxBytes,
  });
}

function apply(renderer, plan, nextMetrics, fontFamily) {
  if (renderer.atlas) renderer.flushAtlasGrowthCopies?.();
  const candidate =
    renderer.atlas && (plan.textureChanged || plan.textureReset)
      ? renderer.atlas.prepareLayout(
          plan.geometry,
          nextMetrics.width,
          nextMetrics.height,
          nextMetrics.fontSize,
          plan.textureReset,
        )
      : null;
  if (!renderer.atlas) renderer.atlas = renderer.createGlyphAtlas(plan.geometry, nextMetrics);
  else if (candidate) renderer.atlas.commitLayout(candidate);
  renderer.atlas.fontFamily = fontFamily || renderer.atlas.fontFamily;
  renderer.glyphPartitions.commit(plan);
  if (candidate) renderer.glyphAtlasChanged?.();
  if (plan.textureReset || plan.textureChanged) renderer.presenter?.invalidate();
  return plan;
}

function visibleSlots(renderer) {
  return new Map(
    renderer.glyphPartitions.values().map((record) => [record.terminal, record.visibleSlots]),
  );
}

export function registerTerminal(renderer, terminal, visibleCells, preferredColumns) {
  if (!renderer.glyphPartitions) {
    renderer.glyphPartitions = new GlyphAtlasPartitions(
      limits(renderer, renderer.physicalCellWidth, renderer.physicalCellHeight),
      preferredColumns,
    );
  }
  return apply(
    renderer,
    renderer.glyphPartitions.planRegister(terminal, visibleCells),
    metrics(renderer),
  );
}

export function resizeTerminalPartition(renderer, terminal, visibleCells) {
  return apply(
    renderer,
    renderer.glyphPartitions.planResize(terminal, visibleCells),
    metrics(renderer),
  );
}

export function releaseTerminal(renderer, terminal) {
  if (!renderer.glyphPartitions?.get(terminal)) return null;
  const plan = renderer.glyphPartitions.planRelease(terminal);
  renderer.glyphPartitions.commit(plan);
  if (renderer.activeTerminal === terminal) renderer.activeTerminal = null;
  return plan;
}

export function glyphPartition(renderer, terminal) {
  return renderer.glyphPartitions?.get(terminal) ?? null;
}

export function reconfigureGlyphAtlas(
  renderer,
  nextMetrics,
  textRenderer,
  fontFamily,
  activeVisibleSlots,
) {
  if (!renderer.glyphPartitions) {
    Object.assign(renderer, {
      physicalCellWidth: nextMetrics.width,
      physicalCellHeight: nextMetrics.height,
      physicalFontSize: nextMetrics.fontSize,
      textRenderer,
    });
    return null;
  }
  const visible = visibleSlots(renderer);
  if (activeVisibleSlots !== undefined) visible.set(renderer.activeTerminal, activeVisibleSlots);
  const plan = renderer.glyphPartitions.planSettings(
    limits(renderer, nextMetrics.width, nextMetrics.height),
    nextMetrics.columns,
    visible,
  );
  const applied = apply(renderer, plan, nextMetrics, fontFamily);
  Object.assign(renderer, {
    physicalCellWidth: nextMetrics.width,
    physicalCellHeight: nextMetrics.height,
    physicalFontSize: nextMetrics.fontSize,
    textRenderer,
  });
  return applied;
}

export function selectTerminal(renderer, terminal) {
  if (!renderer.initialized) throw new Error("GPU terminal is not initialized");
  if (!renderer.glyphPartitions.get(terminal)) throw new Error("terminal has no glyph partition");
  for (const field of ["cols", "rows", "cursorFlags", "drawnCellCount"]) renderer[field] = 0;
  if (renderer.indirectData) {
    renderer.indirectData[1] = 0;
    renderer.indirectDirty = true;
  }
  renderer.activeTerminal = terminal;
  renderer.coreSwitches += 1;
}

export function setTextRenderer(renderer, textRenderer) {
  if (textRenderer !== "kb-stb" && textRenderer !== "canvas")
    throw new Error("invalid text renderer");
  if (textRenderer === renderer.textRenderer) return null;
  return reconfigureGlyphAtlas(
    renderer,
    {
      ...metrics(renderer),
      columns: renderer.glyphPartitions?.preferredColumns ?? 1,
    },
    textRenderer,
  );
}
