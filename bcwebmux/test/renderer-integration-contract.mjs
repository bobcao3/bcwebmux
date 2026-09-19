// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { Terminal } from "../../wgpuTerminal/src/Terminal.js";
import { FramePresenter } from "../../wgpuTerminal/src/browser/render/FramePresenter.js";
import { GpuTerminal } from "../../wgpuTerminal/src/browser/render/webgpu/GpuTerminal.js";
import { WebGlTerminal } from "../../wgpuTerminal/src/browser/render/webgl/WebGlTerminal.js";
import { acquireRenderBackend, releaseRenderBackend } from "../../wgpuTerminal/src/browser/render/RenderBackend.js";
import { PointerController } from "../../wgpuTerminal/src/browser/input/PointerController.js";
import { disposeWebGl } from "../../wgpuTerminal/src/browser/render/webgl/WebGlTerminalResources.js";

const root = new URL("../../wgpuTerminal/src/", import.meta.url);
for (const path of ["browser/ViewportController.js", "browser/input/PointerController.js", "browser/input/InputController.js"]) {
  assert.doesNotMatch(await readFile(new URL(path, root), "utf8"), /getCore|TerminalCore|\.term_|\._wasm/);
}
async function inspect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) await inspect(url);
    else if (entry.name.endsWith(".js")) {
      const source = await readFile(url, "utf8");
      if (!["TerminalCore.js", "FramePacket.js"].includes(entry.name))
        assert.doesNotMatch(source, /\.memory\.buffer|instance\.exports|\._wasm\b/);
      if (/\/(webgpu|webgl)\//.test(url.pathname))
        assert.doesNotMatch(source, /requestAnimationFrame|setInterval|_scheduler|submissionMetadata/);
    }
  }
}
await inspect(root);
assert.doesNotMatch(await readFile(new URL("browser/render/CanvasAlphaMask.js", root), "utf8"),
  /fillText|strokeText|measureText/);
assert.throws(() => new Terminal({ powerPreference: "turbo" }), /power preference/);
assert.equal(new Terminal().options.powerPreference, undefined);
const lostGl = { contextLost: true, initialized: true,
  canvas: { removeEventListener() {} },
  gl: new Proxy({}, { get() { assert.fail("must not delete invalid pre-restoration GL handles"); } }),
};
disposeWebGl(lostGl);
assert.equal(lostGl.disposed, true);
assert.equal(lostGl.initialized, false);
disposeWebGl(lostGl);

const pointer = Object.create(PointerController.prototype);
pointer.getMetrics = () => ({ scaleX: 2, scaleY: 3 });
pointer.surface = { getBoundingClientRect: () => ({ left: 10, top: 20 }) };
let mouse;
pointer.mouse = (...args) => { mouse = args; return true; };
assert.equal(pointer.sendMouse({ clientX: 14, clientY: 25, buttons: 1 }, "press", "left"), true);
assert.deepEqual(mouse, ["press", "left", { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false }, 8, 15, true]);

const originalGpuCreate = GpuTerminal.create;
const originalGlCreate = WebGlTerminal.create;
const originalRegister = FramePresenter.prototype.registerTerminal;
const originalStyle = globalThis.getComputedStyle;
globalThis.getComputedStyle = () => ({ fontFamily: "cached-font" });
FramePresenter.prototype.registerTerminal = function(core, cells) {
  this.backend.glyphPartitions.set(core, { baseSlot: this.backend.glyphPartitions.size * 64, slotCapacity: cells, generation: 2 });
};
let made = [], calls = [], pending = null, fail = false;
function backend(kind) {
  return {
    stats: { backend: kind }, error: null, initialized: false, atlasColumns: 16,
    glyphPartitions: new Map(), coreSwitches: 0,
    setPhysicalCellMetrics(...args) { this.metrics = args; },
    setGrainStrength(value) { this.grain = value; },
    async initialize(capacity) { this.capacity = capacity; this.initialized = true; },
    reloadFont(font) { this.font = font; },
    dispose() { this.disposed = true; },
    readPixels() { return "last-presentation"; },
  };
}
function create(kind) { return async (...args) => {
  calls.push({ kind, args });
  if (fail) throw new Error("x".repeat(1000));
  const b = backend(kind); made.push(b);
  if (pending) await pending;
  return b;
}; }
GpuTerminal.create = create("webgpu");
WebGlTerminal.create = create("webgl2");
try {
  for (const kind of ["webgpu", "webgl2"]) {
    const terminal = new Terminal({ renderBackend: kind, powerPreference: "low-power" });
    const canvas = {};
    terminal._view = { screen: canvas };
    terminal._terminalElement = {};
    terminal._viewportController = { latestPixelViewport: { width: 64, height: 48 } };
    terminal._renderMetrics = Object.freeze({ generation: 1, cols: 8, rows: 3, cellWidth: 8, cellHeight: 16, fontSize: 15, scaleX: 1, scaleY: 1 });
    let suspended = false, wakes = 0;
    terminal._scheduler = { suspend() { suspended = true; }, recover() { suspended = false; wakes++; } };
    const cores = [0, 1].map(id => ({ id, ready: true, cols: 8, rows: 3, invalidations: 0,
      assertMutable() {},
      setGlyphPartition(p) { this.partition = p; return 1; },
      setRenderMetrics(m) { this.metrics = m; return 1; },
      invalidateFrame() { this.invalidations++; },
      reset() { assert.fail("must not reset terminal"); }, write() { assert.fail("must not replay bytes"); },
    }));
    terminal._cores = new Set(cores); terminal._core = cores[0];
    terminal._renderer = await acquireRenderBackend(terminal, canvas, {}, "kb-stb", kind);
    const old = terminal._renderer;
    terminal._presenter = new FramePresenter(terminal, old);
    terminal._presenter.valid = true;
    terminal._bindBackendLifecycle(old);
    if (kind === "webgl2") {
      old.onContextLost();
      assert.equal(suspended, true);
      assert.equal(terminal._presenter.valid, false);
      assert.equal(terminal._recovering, null, "WebGL waits for restoration");
      old.onContextRestored();
    } else old.onDeviceLost();
    const task = terminal._recovering;
    assert.equal(terminal._recoverBackend(old), task, "coalesce loss notifications");
    assert.throws(() => terminal.setRenderer("kb-canvas"), /renderer unavailable/);
    assert.throws(() => terminal.setGlyphCacheMaxBytes(1024 * 1024), /renderer unavailable/);
    terminal.setGrainStrength(7);
    assert.equal(await task, true);
    assert.equal(old.disposed, true);
    assert.equal(terminal.core, cores[0]);
    assert.deepEqual([...terminal._cores], cores);
    assert.equal(terminal._renderer.activeTerminal, cores[0]);
    for (const core of cores) {
      assert.ok(core.partition && core.invalidations > 0);
      assert.equal(core.metrics, terminal._renderMetrics);
    }
    assert.equal(terminal._renderer.font, "cached-font");
    assert.equal(terminal._renderer.grain, 7);
    assert.equal(calls.at(-1).args[0], canvas);
    assert.equal(calls.at(-1).args[4], "low-power");
    assert.equal(terminal.readPixels(), "last-presentation");
    assert.equal(suspended, false);
    const count = wakes;
    old.onDeviceLost?.();
    assert.equal(wakes, count, "stale backend ignored");
    let error;
    terminal.onError(e => { error = e; });
    fail = true;
    const active = terminal._renderer;
    terminal._bindBackendLifecycle(active);
    active.onDeviceLost();
    assert.equal(await terminal._recovering, false);
    assert.equal(suspended, true);
    assert.ok(error.message.length < 300);
    fail = false;
    releaseRenderBackend(terminal, terminal._renderer);
  }
  // Disposal during acquisition must not release another terminal's reservation.
  let resolve;
  pending = new Promise(r => { resolve = r; });
  const owner = {};
  const acquisition = acquireRenderBackend(owner, {}, {}, "kb-stb", "webgpu");
  releaseRenderBackend(owner);
  pending = null;
  const other = {};
  const otherBackend = await acquireRenderBackend(other, {}, {}, "kb-stb", "webgpu");
  resolve();
  await assert.rejects(acquisition, /cancelled/);
  assert.equal(otherBackend.disposed, undefined);
  releaseRenderBackend(other, otherBackend);
  const disposedTerminal = new Terminal({ renderBackend: "webgpu" });
  const previousCancel = globalThis.cancelAnimationFrame;
  globalThis.cancelAnimationFrame = () => {};
  try {
    disposedTerminal._view = { screen: {}, dispose() {} };
    disposedTerminal._viewportController = { latestPixelViewport: {}, dispose() {} };
    let resumed = false;
    disposedTerminal._scheduler = { suspend() {}, dispose() {}, recover() { resumed = true; } };
    disposedTerminal._renderer = await acquireRenderBackend(disposedTerminal, {}, {}, "kb-stb", "webgpu");
    disposedTerminal._presenter = new FramePresenter(disposedTerminal, disposedTerminal._renderer);
    pending = new Promise(r => { resolve = r; });
    const recovery = disposedTerminal._recoverBackend(disposedTerminal._renderer);
    await Promise.resolve();
    disposedTerminal.dispose();
    resolve();
    pending = null;
    assert.equal(await recovery, false);
    assert.equal(disposedTerminal._renderer, null);
    assert.equal(made.at(-1).disposed, true);
    assert.equal(resumed, false, "disposed recovery must not wake scheduler");
  } finally {
    globalThis.cancelAnimationFrame = previousCancel;
  }
} finally {
  GpuTerminal.create = originalGpuCreate;
  WebGlTerminal.create = originalGlCreate;
  FramePresenter.prototype.registerTerminal = originalRegister;
  globalThis.getComputedStyle = originalStyle;
}
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
try {
  const requests = [];
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    gpu: { requestAdapter: async (...args) => { requests.push(args); return null; } },
  } });
  await assert.rejects(GpuTerminal.create({}, {}, "kb-stb"), /adapter unavailable/);
  await assert.rejects(GpuTerminal.create({}, {}, "kb-stb", undefined, "high-performance"), /adapter unavailable/);
  assert.deepEqual(requests, [[], [{ powerPreference: "high-performance" }]]);
  let resolveAdapter;
  let deviceRequests = 0;
  let current = true;
  globalThis.navigator.gpu.requestAdapter = () => new Promise(resolve => { resolveAdapter = resolve; });
  const cancelledCreate = GpuTerminal.create({}, {}, "kb-stb", undefined, undefined, () => current);
  current = false;
  resolveAdapter({ features: new Set(), requestDevice() { deviceRequests++; } });
  await assert.rejects(cancelledCreate, /acquisition cancelled/);
  assert.equal(deviceRequests, 0, "cancelled acquisition must not attach a device to the canvas");
} finally {
  if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
  else delete globalThis.navigator;
}
const contextRequests = [];
const unavailableCanvas = { getContext(type, options) { contextRequests.push({ type, options }); return null; } };
await assert.rejects(WebGlTerminal.create(unavailableCanvas, {}, "kb-stb"), /context unavailable/);
await assert.rejects(WebGlTerminal.create(unavailableCanvas, {}, "kb-stb", undefined, "low-power"), /context unavailable/);
assert.equal("powerPreference" in contextRequests[0].options, false);
assert.equal(contextRequests[1].options.powerPreference, "low-power");
const originalFetch = globalThis.fetch;
let resolveShader;
try {
  globalThis.fetch = async () => ({ ok: true, text: () => new Promise(resolve => { resolveShader = resolve; }) });
  const staleBackend = { initialized: false, disposed: false };
  const initialization = GpuTerminal.prototype.initialize.call(staleBackend, 1);
  while (!resolveShader) await Promise.resolve();
  staleBackend.disposed = true;
  resolveShader("unused shader");
  await assert.rejects(initialization, /disposed during initialization/);
} finally {
  globalThis.fetch = originalFetch;
}
console.log("renderer integration contract passed (semantic controllers, recovery, ownership, power hint)");
