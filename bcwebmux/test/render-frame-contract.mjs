import { FrameScheduler } from "../../wgpuTerminal/src/browser/FrameScheduler.js";
import { FramePresenter } from "../../wgpuTerminal/src/browser/render/FramePresenter.js";
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { TerminalCore } from "../../wgpuTerminal/src/TerminalCore.js";
import { Terminal } from "../../wgpuTerminal/src/Terminal.js";
import { parseFramePacket } from "../../wgpuTerminal/src/FramePacket.js";
import { generateGrain, GRAIN_SIZE } from "../../wgpuTerminal/src/browser/render/Grain.js";
import { CELL_SIZE, STYLE_SIZE, FRAME_SIZE, SUBMISSION_SIZE } from "../../wgpuTerminal/src/browser/render/FrameSchema.js";

assert.deepEqual([CELL_SIZE, STYLE_SIZE, FRAME_SIZE, SUBMISSION_SIZE], [8, 12, 80, 156]);
const grain = generateGrain();
assert.equal(grain.length, GRAIN_SIZE ** 2);
// Golden from the previous Zig xorshift32 generator: preserve signed bytes and shuffle.
assert.equal(createHash("sha256").update(grain).digest("hex"),
  "e42c5d8c94feb4091aa375e532590ad4975b2e93d30162d3c56cb9f4418e0dc4");
assert.deepEqual(generateGrain(), grain);

const wasmPath = process.argv[2] ?? new URL("../zig-out/wgpu-terminal/terminal.wasm", import.meta.url);
const wasmUrl = wasmPath instanceof URL ? wasmPath : pathToFileURL(resolve(wasmPath));
const module = await WebAssembly.compile(await readFile(wasmPath));
const names = WebAssembly.Module.imports(module).map(entry => entry.name);
assert.ok(!names.includes("gpu_submit"));
assert.ok(!names.includes("gpu_init"));
assert.ok(!names.includes("gpu_text_backend"));
const expectations = {
  cellSize: 8, styleSize: 12, frameSize: 80, packetSize: 156,
  maxCells: 256, maxStyles: 257,
  atlas: { columns: 16, tileWidth: 8, tileHeight: 16 },
};
for (const renderer of ["kb-stb", "kb-canvas"]) {
  const core = new TerminalCore({ renderer });
  if (renderer === "kb-stb") {
    core._fontFaces = await Promise.all([
      "JetBrainsMonoNerdFontMono-Regular.ttf",
      "JetBrainsMonoNerdFontMono-Bold.ttf",
      "JetBrainsMonoNerdFontMono-Italic.ttf",
      "JetBrainsMonoNerdFontMono-BoldItalic.ttf",
    ].map(name => readFile(new URL(`fonts/${name}`, wasmUrl))));
  }
  const imports = core._createWasmImports();
  assert.ok(!("gpu_init" in imports.host));
  assert.ok(!("gpu_text_backend" in imports.host));
  core._wasm = (await WebAssembly.instantiate(module, imports)).exports;
  const e = core._wasm;
  e.term_bootstrap();
  assert.equal(e.term_init(8, 3), 1);
  Object.assign(core._state, { cols: 8, rows: 3 });
  assert.equal(e.term_frame_prepare(), -1, "missing metrics preparation fails without leaving a borrow");
  assert.equal(e.term_frame_token(), 0);
  assert.equal(core.setRenderer(renderer), renderer);
  core.setGlyphPartition({ baseSlot: 0, slotCapacity: 256, generation: 1 }, 16);
  core.setRenderMetrics({ cellWidth: 8, cellHeight: 16, fontSize: 15 });
  core.setTextViewEnabled(true);
  core.write("ABC");
  let frame;
  core.consumeFrame(value => { frame = value; }, expectations);
  assert.equal(frame.fullFrame, true);
  assert.equal(frame.textChanged, true);
  assert.equal(frame.graphicsRevision, 0);
  assert.ok(!("memory" in frame));
  assert.ok(!("cellsPtr" in frame));
  assert.ok(renderer === "kb-stb" ? frame.bitmapUploadsCount > 0 : frame.canvasRequestsCount > 0);
  assert.equal(core.consumeFrame(() => { throw new Error("unexpected consumer"); }, expectations), 0);

  const failures = [
    () => { throw new Error("consumer failure"); },
    () => false,
    () => Promise.resolve(),
    () => Promise.reject(new Error("async consumer rejected")),
    () => ({ get then() { throw new Error("then getter failed"); } }),
    () => core.write("nested"),
    () => core.reset(),
    () => core.dispose(),
    () => core.consumeFrame(() => {}, expectations),
    () => core.setTheme(core.options.theme),
  ];
  for (const failure of failures) {
    core.write("x");
    assert.throws(() => core.consumeFrame(failure, expectations));
    assert.equal(core.ready, true);
    frame = undefined;
    core.consumeFrame(value => { frame = value; }, expectations);
    assert.equal(frame.fullFrame, true);
    assert.equal(frame.textChanged, true);
    assert.equal(frame.stylesFirst, 0);
    assert.ok(renderer === "kb-stb" ? frame.bitmapUploadsCount > 0 : frame.canvasRequestsCount > 0);
    assert.equal(core.consumeFrame(() => { throw new Error("unexpected consumer"); }, expectations), 0);
  }
  core.write("x");
  assert.throws(() => core.consumeFrame(() => {}, { ...expectations, packetSize: 155 }));
  frame = undefined;
  core.consumeFrame(value => { frame = value; }, expectations);
  assert.equal(frame.fullFrame, true);

  core.write("y");
  const ptr = e.term_frame_prepare();
  assert.ok(ptr > 0);
  const token = e.term_frame_token();
  const identity = { ...expectations, abi: 5, coreGeneration: e.term_core_generation(),
    configGeneration: e.term_config_generation(), token,
    partition: { baseSlot: 0, slotCapacity: 256, generation: 1 } };
  for (const override of [{ abi: 4 }, { token: token + 1 }, { coreGeneration: 999 },
    { configGeneration: 999 }, { partition: { baseSlot: 0, slotCapacity: 256, generation: 2 } }]) {
    assert.throws(() => parseFramePacket(e.memory.buffer, ptr, { ...identity, ...override }));
  }
  for (const [offset, invalid] of [[24, 0xffffffff], [28, 0xffffffff], [36, 0xffffffff],
    [108, 2], [128, 2], [136, 1], [140, 4], [144, 1], [148, 4], [152, 1]]) {
    const copy = e.memory.buffer.slice(0);
    new DataView(copy, ptr).setUint32(offset, invalid, true);
    assert.throws(() => parseFramePacket(copy, ptr, identity), `invalid header offset ${offset}`);
  }
  assert.equal(e.term_frame_prepare(), -2);
  assert.equal(e.term_feed(0), 0);
  assert.equal(e.term_reserve(1), 0);
  assert.equal(e.term_set_renderer(0), 0);
  assert.equal(e.term_set_text_view_enabled(0), 0);
  assert.equal(e.term_snapshot_reserve(8), 0);
  assert.equal(e.bc_font_alloc(65536), 0);
  assert.equal(e.term_resize_canonical(9, 3, 8, 16), 0);
  e.term_deinit();
  assert.equal(e.term_frame_finish(token + 1, 1), -2);
  assert.equal(e.term_frame_token(), 0);
  const replacementPtr = e.term_frame_prepare();
  assert.equal(replacementPtr, ptr, "packet header has core-owned stable storage");
  assert.equal(new DataView(e.memory.buffer, replacementPtr).getUint32(128, true), 1);
  assert.equal(e.term_frame_finish(e.term_frame_token(), 1), 1);
  assert.equal(e.term_frame_finish(token, 1), -2);
  core.write("\x1b[2J\x1b[H\x1b[1;3;4;5;7;9;53;38;2;90;80;70;48;2;10;20;30mA中😀e\u0301");
  core.setSelectionRange({ row: 0, col: 0 }, { row: 0, col: 7 });
  assert.equal(core.consumeFrame(() => {}, expectations), 1);
  core.clearSelection();
  core.write("\x1b[0m\r\nline\r\nline\r\nline\r\nline");
  assert.equal(core.consumeFrame(() => {}, expectations), 1);
  assert.equal(core.scrollRow(0), 1);
  assert.equal(core.consumeFrame(packet => assert.equal(packet.viewportMode, "top"), expectations), 1);
  const oldGeneration = e.term_core_generation();
  const oldToken = token;
  assert.equal(core.reset(), true);
  assert.equal(e.term_core_generation(), oldGeneration + 1);
  assert.equal(e.term_frame_finish(oldToken, 1), -2);
  assert.equal(core.consumeFrame(packet => assert.equal(packet.fullFrame, true), expectations), 1);
  core.dispose();
}

// Real cores with a synchronous upload sink exercise attach/rollback without a GPU.
const host = new Terminal({ renderer: "kb-canvas" });
const partitions = new Map();
const cores = [];
for (const baseSlot of [0, 256]) {
  const core = new TerminalCore({ renderer: "kb-canvas" });
  core._wasm = (await WebAssembly.instantiate(module, core._createWasmImports())).exports;
  core._wasm.term_bootstrap();
  assert.equal(core._wasm.term_init(8, 3), 1);
  Object.assign(core._state, { cols: 8, rows: 3 });
  const partition = { baseSlot, slotCapacity: 256, generation: 1 };
  partitions.set(core, partition);
  core.setGlyphPartition(partition, 16);
  core.setRenderer("kb-canvas");
  core.setRenderMetrics({ cellWidth: 8, cellHeight: 16, fontSize: 15 });
  core.write(baseSlot ? "second" : "first");
  core._setHost(host);
  cores.push(core);
}
host._opened = true;
host._cores = new Set(cores);
host._core = cores[0];
let failCore = null;
let presentations = 0;
host._renderer = {
  ...expectations, initialized: true, error: null, atlasColumns: 16,
  activeTerminal: cores[0], submissionMetadata: {},
  glyphPartitions: partitions,
  selectTerminal(core) { this.activeTerminal = core; },
  resizeTerminalPartition() {}, ensureFrameCapacity() { return false; },
  uploadBitmap() {}, uploadCanvasRun() {}, uploadCells() {},
  uploadStyles() {
    assert.ok(this.activeTerminal._wasm.term_frame_token() > 0);
    if (this.activeTerminal === failCore) throw new Error("upload rejected");
  },
  presentCurrentState() {
    for (const core of cores) assert.equal(core._wasm.term_frame_token(), 0);
    presentations++;
  },

};
host._presenter = new FramePresenter(host, host._renderer);
host._presenter.resizeTerminalPartition = () => {};
host._viewportController = {
  latestPixelViewport: {}, cancelScrollGesture() {}, submitFrameMetadata() {},
  physicalLayout: () => ({ cols: 8, rows: 3, cellWidth: 8, cellHeight: 16, fontSize: 15 }),
};
host._scheduler = new FrameScheduler(host, {
  document: { hidden: false }, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  setTimeout: () => 1, clearTimeout() {},
});
assert.equal(host._scheduler.flushImmediate(), 1);
assert.equal(presentations, 1);
failCore = cores[1];
const originalError = console.error;
try {
  console.error = () => {};
  assert.throws(() => host.attachCore(cores[1]), /upload rejected/);
} finally { console.error = originalError; }
assert.equal(host.core, cores[0]);
assert.equal(host._renderer.activeTerminal, cores[0]);
assert.equal(host._renderer.error, null);
assert.equal(presentations, 2, "failed upload was not presented; rollback replacement was");
failCore = null;
assert.equal(host.attachCore(cores[1]), cores[1]);
assert.equal(presentations, 3);
cores[1].write("borrow");
assert.throws(() => cores[1].consumeFrame(() => cores[0].dispose(), {
  ...expectations, partition: partitions.get(cores[1]),
}), /live frame borrow/);
assert.equal(cores[0].ready, true, "shared-host disposal fails before destroying the other core");
for (const core of cores) { core._clearHost(host); core.dispose(); }

const source = await readFile(new URL("../../common/terminal/RenderFrame.zig", import.meta.url), "utf8");
assert.doesNotMatch(source, /@embedFile|gpu_init|gpu_text_backend|grain/);
assert.doesNotMatch(source, /gpu_submit/);
const terminal = await readFile(new URL("../../wgpuTerminal/src/Terminal.js", import.meta.url), "utf8");
assert.doesNotMatch(terminal, /_gpuInit/);
assert.ok(terminal.indexOf("this._registerTerminal(core, initialLayout)") <
  terminal.indexOf("await this._renderer.initialize("));
const sourceRoot = new URL("../../wgpuTerminal/src/", import.meta.url);
for (const path of await readdir(sourceRoot, { recursive: true })) {
  if (!path.endsWith(".js") || path === "TerminalCore.js" || path === "FramePacket.js") continue;
  const text = await readFile(new URL(path, sourceRoot), "utf8");
  assert.doesNotMatch(text, /\._wasm\b|(?<!\/)\b(?:core|host|terminal|this)\??\.wasm\b|WebAssembly|\.memory\.buffer|\.term_/, path);
  assert.doesNotMatch(text, /submissionMemory|RendererSubmission|submitWasm/, path);
}
const bridgeSource = await readFile(new URL("TerminalCore.js", sourceRoot), "utf8");
assert.doesNotMatch(bridgeSource, /get wasm\(|gpu_submit/);
const packetSource = await readFile(new URL("FramePacket.js", sourceRoot), "utf8");
assert.doesNotMatch(packetSource, /renderer\.|applyRenderer|WebAssembly/);
console.log("render frame contract passed (ABI v5, browser assets, both text renderers)");
