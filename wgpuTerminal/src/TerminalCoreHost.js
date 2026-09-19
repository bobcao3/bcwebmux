// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { TerminalCore } from "./TerminalCore.js";
import { normalizeFont } from "./TerminalOptions.js";

export async function createCore(host, options = {}) {
  host._core?.assertMutable();
  if (!host._opened || !host._core?.ready) throw new Error("terminal is not open");
  if (options.wasmUrl !== undefined && String(options.wasmUrl) !== String(host.options.wasmUrl)) {
    throw new Error("terminal core WASM build does not match host");
  }
  const font = normalizeFont({ ...host.options.font, ...(options.font || {}) });
  const core = new TerminalCore({
    wasmUrl: options.wasmUrl ?? host.options.wasmUrl,
    wasmFontUrls: options.wasmFontUrls ?? host.options.wasmFontUrls,
    renderer: options.renderer ?? host.options.renderer,
    font,
    theme: options.theme ?? host.options.theme,
    clipboardWrite: options.clipboardWrite ?? host.options.clipboardWrite,
  });
  const pixelViewport = host._viewportController.latestPixelViewport;
  const layout = host._viewportController.physicalLayout(pixelViewport);
  host._cores.add(core);
  try {
    host._registerTerminal(core, layout);
    await core.open({ cols: layout.cols, rows: layout.rows, host });
    if ((host.options.canonicalGeometry
      ? core.setRenderMetrics(layout)
      : core.resize(layout)) !== 1) {
      throw new Error("terminal core resize failed");
    }
    return core;
  } catch (error) {
    host._releaseTerminal(core);
    host._cores.delete(core);
    core.dispose();
    throw error;
  }
}

export function attachCore(host, core) {
  host._core?.assertMutable();
  if (!host._opened) throw new Error("terminal is not open");
  if (!(core instanceof TerminalCore) || !core.ready) {
    throw new TypeError("an opened terminal core is required");
  }
  core.assertMutable();
  if (String(core.options.wasmUrl) !== String(host.options.wasmUrl)) {
    throw new Error("terminal core WASM build does not match host");
  }
  if (core === host._core) return core;
  host._viewportController.cancelScrollGesture();
  core._setHost(host);
  const previousCore = host._core;
  const wasOwned = host._cores.has(core);
  host._cores.add(core);
  const pixelViewport = host._viewportController.latestPixelViewport;
  const layout = host._viewportController.physicalLayout(pixelViewport);
  if (host._selectionMode) host.exitSelectionMode({ restoreFocus: false });
  host._renderingCore = core;
  try {
    if (!wasOwned) host._registerTerminal(core, layout);
    host._prepareTerminalFrame(core, host.options.canonicalGeometry
      ? Math.max(layout.cols * layout.rows, core.cols * core.rows)
      : layout.cols * layout.rows);
    host._presenter.selectTerminal(core);
    core.setRenderer(host.options.renderer);
    core.setFont(host.options.font);
    core.invalidateForAttach();
    if ((host.options.canonicalGeometry
      ? core.setRenderMetrics(layout)
      : core.resize(layout)) !== 1) throw new Error("terminal core resize failed");
    if (core.renderFrame() !== 1) throw new Error("terminal core render failed");
    host._core = core;
    host.clearPendingLatency();
    host._renderingCore = null;
  } catch (error) {
    host._renderingCore = previousCore;
    host._core = previousCore;
    try {
      host._presenter.selectTerminal(previousCore);
      previousCore.setRenderer(host.options.renderer);
      previousCore.setFont(host.options.font);
      previousCore.invalidateForAttach();
      if ((host.options.canonicalGeometry
        ? previousCore.setRenderMetrics(layout)
        : previousCore.resize(layout)) !== 1) throw new Error("previous core resize failed");
      if (previousCore.renderFrame() !== 1) throw new Error("previous core render failed");
    } catch {}
    host._renderingCore = null;
    if (!wasOwned) {
      host._releaseTerminal(core);
      host._cores.delete(core);
      core._clearHost(host);
    }
    throw error;
  }
  return core;
}

export function restoreSnapshot(host, data, core = host._core) {
  if (!host._opened || !host._cores.has(core) || !core?.ready) {
    throw new Error("an opened terminal core is required");
  }
  if (core === host._core) host._pendingRxAt = performance.now();
  core.restoreSnapshot(data);
}
