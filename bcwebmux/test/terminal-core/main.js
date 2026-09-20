// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { Terminal } from "/wgpuTerminal/src/index.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

async function pixels(terminal) {
  await nextFrame();
  return terminal.readPixels();
}

function averageCell(image, terminal, x, y) {
  const style = getComputedStyle(terminal.element);
  const scaleX = image.width / terminal.screenElement.clientWidth;
  const scaleY = image.height / terminal.screenElement.clientHeight;
  const cellWidth = parseFloat(style.getPropertyValue("--cell-width")) * scaleX;
  const cellHeight = parseFloat(style.getPropertyValue("--cell-height")) * scaleY;
  const x0 = Math.max(0, Math.floor((x + 0.3) * cellWidth));
  const x1 = Math.min(image.width, Math.ceil((x + 0.7) * cellWidth));
  const y0 = Math.max(0, Math.floor((y + 0.3) * cellHeight));
  const y1 = Math.min(image.height, Math.ceil((y + 0.7) * cellHeight));
  const bgra = image.format.toLowerCase().startsWith("bgra");
  const red = bgra ? 2 : 0;
  const blue = bgra ? 0 : 2;
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let py = y0; py < y1; py += 1) for (let px = x0; px < x1; px += 1) {
    const offset = (py * image.width + px) * 4;
    r += image.data[offset + red];
    g += image.data[offset + 1];
    b += image.data[offset + blue];
    count += 1;
  }
  return [r / count, g / count, b / count];
}

function redGlyphPixels(image, terminal, row, columns) {
  const style = getComputedStyle(terminal.element);
  const scaleX = image.width / terminal.screenElement.clientWidth;
  const scaleY = image.height / terminal.screenElement.clientHeight;
  const cellWidth = parseFloat(style.getPropertyValue("--cell-width")) * scaleX;
  const cellHeight = parseFloat(style.getPropertyValue("--cell-height")) * scaleY;
  const x1 = Math.min(image.width, Math.ceil(columns * cellWidth));
  const y0 = Math.max(0, Math.floor(row * cellHeight));
  const y1 = Math.min(image.height, Math.ceil((row + 1) * cellHeight));
  const bgra = image.format.toLowerCase().startsWith("bgra");
  const red = bgra ? 2 : 0;
  const blue = bgra ? 0 : 2;
  let count = 0;
  for (let y = y0; y < y1; y += 1) for (let x = 0; x < x1; x += 1) {
    const offset = (y * image.width + x) * 4;
    const r = image.data[offset + red];
    const g = image.data[offset + 1];
    const b = image.data[offset + blue];
    if (r > 100 && r > g * 1.35 && r > b * 1.35) count += 1;
  }
  return count;
}

function selectedText(core) {
  if (!core.setSelectionRange({ row: 0, col: 0 }, { row: core.rows - 1, col: core.cols })) return "";
  const text = core.getSelection() || "";
  core.clearSelection();
  return text;
}

async function run() {
  const requestedBackend = new URLSearchParams(window.location.search).get("backend");
  const root = document.querySelector("#terminal-core-test");
  const terminal = new Terminal({
    wasmUrl: "/terminal.wasm",
    renderBackend: requestedBackend === "webgl2" ? "webgl2" : "webgpu",
  });
  await terminal.open(root);
  const coreA = terminal.core;
  coreA.write("\x1b[2J\x1b[H\x1b[48;2;220;40;40m  \x1b[0m CORE-A\r\n");
  for (let index = 0; index < 400; index += 1) coreA.write(`A-history-${index}\r\n`);
  coreA.write("\x1b[2J\x1b[H\x1b[48;2;220;40;40m  \x1b[0m CORE-A-ACTIVE");
  const imageA = await pixels(terminal);
  if (new URLSearchParams(location.search).get("recovery") === "1") {
    const previous = terminal._renderer;
    let recoveryError;
    const listener = terminal.onError(error => { recoveryError = error.message; });
    if (requestedBackend === "webgl2") {
      const loss = previous.gl.getExtension("WEBGL_lose_context");
      if (!loss) throw new Error("context loss extension unavailable");
      loss.loseContext();
      await sleep(100);
      loss.restoreContext();
    } else previous.device.destroy();
    for (let attempt = 0; attempt < 200 &&
      (terminal._renderer === previous || terminal._recovering || !terminal._presenter.valid); attempt++) {
      await sleep(25);
    }
    listener.dispose();
    if (terminal._renderer === previous || terminal._recovering || !terminal._presenter.valid || terminal.core !== coreA) {
      throw new Error(`backend recovery failed: ${recoveryError ?? terminal._renderer.error}`);
    }
  }
  const renderer = terminal._renderer;
  terminal._ensureFrameCapacity(0xffff);
  if (renderer.maxCells < 0xffff || renderer.maxStyles !== 0x10000) {
    throw new Error("maximum frame/style resource sizing mismatch");
  }
  const partitionA = renderer.glyphPartitions.get(coreA);
  const initialVisibleCapacity = coreA.cols * coreA.rows;
  if (!partitionA || partitionA.slotCapacity !== initialVisibleCapacity) {
    throw new Error(`core A glyph partition capacity mismatch: ${JSON.stringify(partitionA)}`);
  }
  const atlasTextureBeforeBudgetFailure = renderer.atlas.texture;
  const glyphCacheMaxBytesBefore = terminal.options.glyphCacheMaxBytes;
  let budgetError = null;
  try {
    terminal.setGlyphCacheMaxBytes(1);
  } catch (error) {
    budgetError = error;
  }
  const budgetRollback = budgetError?.code === "ERR_GLYPH_ATLAS_CAPACITY" &&
    renderer.atlas.texture === atlasTextureBeforeBudgetFailure &&
    terminal.options.glyphCacheMaxBytes === glyphCacheMaxBytesBefore;
  if (!budgetRollback) throw new Error("glyph cache budget failure was not transactional");
  const surface = root.querySelector('[data-terminal-role="surface"]');
  const scrollbar = root.querySelector('[data-terminal-role="scrollbar"]');
  if (!surface || !scrollbar) throw new Error("semantic viewport elements were not found");
  const assertActive = (label) => {
    const state = terminal.state;
    if (state.viewportMode !== "active" || state.scrollOffset + state.scrollLength !== state.scrollTotal) {
      throw new Error(`${label}: active viewport was not at semantic bottom`);
    }
  };
  const scrollKey = async (key) => {
    scrollbar.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await nextFrame();
    await nextFrame();
  };
  if (getComputedStyle(surface).overflowY !== "hidden" || surface.scrollHeight !== surface.clientHeight) {
    throw new Error("terminal surface is a DOM scroll container");
  }
  if (terminal.state.scrollTotal <= terminal.state.scrollLength) throw new Error("core A did not create scrollback");
  if (scrollbar.hidden) throw new Error("semantic scrollbar is hidden with scrollback");
  assertActive("initial frame");
  const initialRows = coreA.rows;
  root.style.height = "70%";
  await nextFrame();
  await nextFrame();
  if (coreA.rows >= initialRows) throw new Error("shrinking root height did not reduce rows");
  if (renderer.glyphPartitions.get(coreA).slotCapacity !== initialVisibleCapacity) {
    throw new Error("viewport shrink reduced glyph cache high-water capacity");
  }
  assertActive("active resize");
  await scrollKey("Home");
  coreA.write("\r\nA-WROTE-AT-TOP");
  await nextFrame();
  await nextFrame();
  if (terminal.state.viewportMode !== "top" || terminal.state.scrollOffset !== 0) {
    throw new Error("writing at the top moved the semantic viewport");
  }
  await scrollKey("ArrowDown");
  await scrollKey("ArrowDown");
  if (terminal.state.viewportMode !== "pinned" || terminal.state.scrollOffset <= 0) {
    throw new Error("row scrolling did not create a pinned viewport");
  }
  let pinnedOffset = terminal.state.scrollOffset;
  coreA.write("\r\nA-WROTE-IN-MIDDLE");
  await nextFrame();
  await nextFrame();
  if (terminal.state.viewportMode !== "pinned") throw new Error("writing in the middle changed viewport mode");
  if (terminal.state.scrollOffset !== pinnedOffset) throw new Error("writing in the middle changed scroll offset");
  for (let batch = 0; batch < 12; batch += 1) {
    let output = "";
    for (let row = 0; row < 8; row += 1) output += `A-SUSTAINED-${batch}-${row}\r\n`;
    coreA.write(output);
    await nextFrame();
    if (terminal.state.viewportMode !== "pinned") throw new Error("sustained output changed viewport mode");
    if (terminal.state.scrollOffset !== pinnedOffset) throw new Error("sustained output moved the pinned viewport");
  }
  pinnedOffset = terminal.state.scrollOffset;
  root.style.height = "60%";
  await nextFrame();
  await nextFrame();
  if (terminal.state.viewportMode !== "pinned") throw new Error("pinned middle viewport mode changed during resize");
  if (terminal.state.scrollOffset !== pinnedOffset) throw new Error("pinned middle viewport offset changed during resize");
  await scrollKey("End");
  assertActive("End");
  root.style.height = "100%";
  await nextFrame();
  await nextFrame();
  assertActive("active grow");
  const colorA = averageCell(imageA, terminal, 0, 0);

  const coreB = await terminal.createCore();
  const coreBMemoryBeforeRender = coreB.memoryBytes;
  coreB.write("\x1b[2J\x1b[H\x1b[48;2;20;190;210m  \x1b[0m CORE-B-ACTIVE");
  terminal.attachCore(coreB);
  const imageB = await pixels(terminal);
  const partitionB = renderer.glyphPartitions.get(coreB);
  if (!partitionB || partitionA.baseSlot + partitionA.slotCapacity > partitionB.baseSlot &&
      partitionB.baseSlot + partitionB.slotCapacity > partitionA.baseSlot) {
    throw new Error("core glyph partitions overlap");
  }
  if (renderer.glyphPartitions.reservedSlots !== partitionA.slotCapacity + partitionB.slotCapacity) {
    throw new Error("shared atlas required slot count mismatch");
  }
  const coreBMemoryAfterRender = coreB.memoryBytes;
  const colorB = averageCell(imageB, terminal, 0, 0);

  const hiddenFrames = coreA.state.frames;
  coreA.write("\r\nA-WROTE-WHILE-INACTIVE");
  await sleep(40);
  if (coreA.state.frames !== hiddenFrames) throw new Error("inactive core scheduled a frame");

  terminal.attachCore(coreA);
  const hiddenGeometry = [coreB.cols, coreB.rows];
  const activeCols = coreA.cols;
  root.style.width = "80%";
  await nextFrame();
  await nextFrame();
  if (coreA.cols === activeCols) throw new Error("active core geometry did not change");
  if (coreB.cols !== hiddenGeometry[0] || coreB.rows !== hiddenGeometry[1]) {
    throw new Error("inactive core geometry changed");
  }
  root.style.width = "100%";
  await nextFrame();
  await nextFrame();

  const fontReloads = terminal.state.fontReloads;
  const atlasTextureBeforeSwitches = renderer.atlas.texture;
  for (let index = 0; index < 12; index += 1) {
    terminal.attachCore(index % 2 === 0 ? coreA : coreB);
  }
  terminal.attachCore(coreA);
  await nextFrame();
  if (renderer.atlas.texture !== atlasTextureBeforeSwitches) throw new Error("core switches replaced the atlas texture");
  if (terminal.state.cacheHits <= 0) throw new Error("core switches did not hit the shared cache");
  if (terminal.state.fontReloads !== fontReloads) throw new Error("core switches reloaded the font");
  const textA = selectedText(coreA);
  if (!textA.includes("A-SUSTAINED-11-7") || textA.includes("CORE-B-ACTIVE")) {
    throw new Error(`core A state leaked: ${JSON.stringify(textA)}`);
  }

  terminal.attachCore(coreB);
  let replies = "";
  let userData = "";
  let hostData = "";
  const hostDataListener = terminal.onData((view) => { hostData += new TextDecoder().decode(view); });
  const replyListener = coreB.onReply((view) => { replies += new TextDecoder().decode(view); });
  const dataListener = coreB.onData((view) => { userData += new TextDecoder().decode(view); });
  coreB.setReplayMode(true);
  coreB.write("\x1b[5n");
  if (replies !== "") throw new Error(`replay reply was not suppressed: ${JSON.stringify(replies)}`);
  coreB.setReplayMode(false);
  coreB.write("\x1b[5n");
  coreB.input("u");
  if (replies !== "\x1b[0n") throw new Error(`parser reply separation failed: ${JSON.stringify(replies)}`);
  if (userData !== "u") throw new Error(`user input separation failed: ${JSON.stringify(userData)}`);
  if (hostData !== "u") throw new Error(`host input separation failed: ${JSON.stringify(hostData)}`);
  hostDataListener.dispose();
  replyListener.dispose();
  dataListener.dispose();

  let disposeReplies = 0;
  const temporary = await terminal.createCore();
  const temporaryPartition = renderer.glyphPartitions.get(temporary);
  const temporaryAtlasTexture = renderer.atlas.texture;
  const temporaryAtlasCapacity = renderer.atlas.capacity;
  temporary.onReply(() => {
    disposeReplies += 1;
    temporary.dispose();
  });
  temporary.write("\x1b[5n");
  if (disposeReplies !== 1) throw new Error(`temporary reply count mismatch: ${disposeReplies}`);
  if (!temporary.disposed) throw new Error("temporary core was not disposed");
  if (terminal.coreCount !== 2) throw new Error(`temporary core count mismatch: ${terminal.coreCount}`);
  if (renderer.glyphPartitions.size !== 2) throw new Error("temporary glyph partition was not released");
  if (renderer.atlas.texture !== temporaryAtlasTexture ||
      renderer.atlas.capacity !== temporaryAtlasCapacity) {
    throw new Error("temporary core disposal shrank or replaced the shared atlas");
  }
  const replacement = await terminal.createCore();
  const replacementPartition = renderer.glyphPartitions.get(replacement);
  if (!replacementPartition || replacementPartition.baseSlot !== temporaryPartition.baseSlot) {
    throw new Error("replacement core did not reuse the disposed glyph partition");
  }
  replacement.dispose();
  if (terminal.coreCount !== 2 || renderer.glyphPartitions.size !== 2) {
    throw new Error("replacement core disposal left an unexpected core count");
  }

  const response = await fetch("/terminal-core/fixtures/terminal-core-csi.snapshot");
  if (!response.ok) throw new Error(`snapshot fixture fetch failed: ${response.status}`);
  terminal.restoreSnapshot(await response.arrayBuffer(), coreB);
  coreB.write("mSNAPSHOT-CONTINUATION\x1b[0m");
  terminal.attachCore(coreB);
  const snapshotImage = await pixels(terminal);
  const snapshotText = selectedText(coreB);
  if (!snapshotText.includes("ALTERNATE SNAPSHOT READY") || !snapshotText.includes("SNAPSHOT-CONTINUATION")) {
    throw new Error(`snapshot state missing: ${JSON.stringify(snapshotText)}`);
  }
  const redPixels = redGlyphPixels(snapshotImage, terminal, 2, 24);
  if (redPixels < 4) throw new Error(`snapshot parser continuation did not preserve red SGR: ${redPixels}`);
  coreB.write("\x1b[?1049l");
  await nextFrame();
  const primaryText = selectedText(coreB);
  if (!primaryText.includes("PRIMARY SNAPSHOT READY")) {
    throw new Error(`primary snapshot state missing: ${JSON.stringify(primaryText)}`);
  }

  const utf8Response = await fetch("/terminal-core/fixtures/terminal-core-utf8.snapshot");
  if (!utf8Response.ok) throw new Error(`UTF-8 snapshot fixture fetch failed: ${utf8Response.status}`);
  terminal.restoreSnapshot(await utf8Response.arrayBuffer(), coreA);
  coreA.write(new Uint8Array([0x98, 0x84]));
  coreA.write(" UTF8-CONTINUATION");
  terminal.attachCore(coreA);
  await nextFrame();
  const utf8Text = selectedText(coreA);
  if (!utf8Text.includes("UTF8 SNAPSHOT READY") || !utf8Text.includes("😄 UTF8-CONTINUATION")) {
    throw new Error(`UTF-8 snapshot state missing: ${JSON.stringify(utf8Text)}`);
  }

  if (document.querySelectorAll("canvas").length !== 1) throw new Error("multiple canvases were created");
  if (terminal.coreCount !== 2) throw new Error(`unexpected core count: ${terminal.coreCount}`);
  if (terminal.state.gpuError !== null) throw new Error(`GPU error: ${terminal.state.gpuError}`);

  const result = {
    backend: terminal.state.backend,
    physicalCellWidth: terminal.state.physicalCellWidth,
    physicalCellHeight: terminal.state.physicalCellHeight,
    coreCount: terminal.coreCount,
    coreSwitches: terminal.state.coreSwitches,
    gpuFrames: terminal.state.gpuFrames,
    colorA,
    colorB,
    budgetRollback,
    coreBMemoryBeforeRender,
    coreBMemoryAfterRender,
    partitions: {
      coreA: { base: partitionA.baseSlot, capacity: partitionA.slotCapacity },
      coreB: { base: partitionB.baseSlot, capacity: partitionB.slotCapacity },
      temporary: { base: temporaryPartition.baseSlot, capacity: temporaryPartition.slotCapacity },
      replacement: { base: replacementPartition.baseSlot, capacity: replacementPartition.slotCapacity },
    },
    atlas: {
      requiredSlots: renderer.glyphPartitions.reservedSlots,
      capacity: renderer.atlas.capacity,
      cacheHits: terminal.state.cacheHits,
      tileWidth: renderer.atlas.tileWidth,
      tileHeight: renderer.atlas.tileHeight,
      textureBytes: renderer.atlas.capacity * renderer.atlas.tileWidth * renderer.atlas.tileHeight,
    },
    viewport: {
      width: terminal.state.viewportWidth,
      height: terminal.state.viewportHeight,
    },
    devicePixelRatio: window.devicePixelRatio,
    hiddenGeometry,
    redPixels,
    textA,
    snapshotText,
    primaryText,
    utf8Text,
    replies,
    userData,
    hostData,
    disposeReplies,
  };
  await terminal.setRenderer("canvas");
  const originalFont = terminal.options.font;
  await terminal.setFont({ cssFamily: "Canvas Late Font Test", canvasOnly: true, fallbacks: ["monospace"] });
  terminal.write("\x1b[2J\x1b[H\x1b[?25l\x1b[31mCanvas late font\x1b[0m");
  const beforeFont = await pixels(terminal);
  let refusedStb = false;
  try { await terminal.setRenderer("kb-stb"); } catch { refusedStb = true; }
  if (!refusedStb || terminal.options.renderer !== "canvas") throw new Error("Canvas-only font switched to STB");
  const lateFont = new FontFace("Canvas Late Font Test", "url(/fonts/JetBrainsMonoNerdFontMono-BoldItalic.ttf)");
  document.fonts.add(lateFont);
  await document.fonts.load(`${originalFont.size}px "Canvas Late Font Test"`);
  await document.fonts.ready;
  const afterFont = await pixels(terminal);
  if (beforeFont.width === afterFont.width && beforeFont.height === afterFont.height &&
      beforeFont.data.every((value, i) => value === afterFont.data[i])) {
    throw new Error("late web font left cached fallback masks unchanged");
  }
  terminal.attachCore(coreB);
  await pixels(terminal);
  if (coreB.options.renderer !== "canvas" || terminal.state.gpuError) throw new Error("inactive core did not adopt Canvas fonts");
  await terminal.setFont({ ...originalFont, canvasOnly: false });
  await terminal.setRenderer("kb-stb");
  await pixels(terminal);
  await terminal.setRenderer("canvas");
  terminal.attachCore(coreA);
  await pixels(terminal);
  result.canvasFontLifecycle = true;
  window.terminalCoreTestTerminal = terminal;
  return result;
}

window.terminalCoreTest = run();
