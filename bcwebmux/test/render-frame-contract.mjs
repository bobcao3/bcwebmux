// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { TerminalCore } from "../../wgpuTerminal/src/TerminalCore.js";
import { generateGrain, GRAIN_SIZE } from "../../wgpuTerminal/src/browser/render/Grain.js";
import { CELL_SIZE, STYLE_SIZE, FRAME_SIZE, SUBMISSION_SIZE } from "../../wgpuTerminal/src/browser/render/FrameSchema.js";

assert.deepEqual([CELL_SIZE, STYLE_SIZE, FRAME_SIZE, SUBMISSION_SIZE], [8, 12, 80, 112]);
const grain = generateGrain();
assert.equal(grain.length, GRAIN_SIZE ** 2);
// Golden from the previous Zig xorshift32 generator: preserve signed bytes and shuffle.
assert.equal(createHash("sha256").update(grain).digest("hex"),
  "e42c5d8c94feb4091aa375e532590ad4975b2e93d30162d3c56cb9f4418e0dc4");
assert.deepEqual(generateGrain(), grain);

const wasmPath = process.argv[2] ?? new URL("../zig-out/wgpu-terminal/terminal.wasm", import.meta.url);
const module = await WebAssembly.compile(await readFile(wasmPath));
const names = WebAssembly.Module.imports(module).map(entry => entry.name);
assert.ok(names.includes("gpu_submit"));
assert.ok(!names.includes("gpu_init"));
assert.ok(!names.includes("gpu_text_backend"));
for (const renderer of ["kb-stb", "kb-canvas"]) {
  const core = new TerminalCore({ renderer });
  const imports = core._createWasmImports();
  assert.ok(!("gpu_init" in imports.host));
  assert.ok(!("gpu_text_backend" in imports.host));
  core._wasm = (await WebAssembly.instantiate(module, imports)).exports;
  core.wasm.term_bootstrap();
  assert.equal(core.wasm.term_init(80, 24), 1);
  assert.equal(core.setRenderer(renderer), renderer);
  assert.equal(core.wasm.term_set_renderer(2), 0);
  core.wasm.term_deinit();
}
const source = await readFile(new URL("../../common/terminal/RenderFrame.zig", import.meta.url), "utf8");
assert.doesNotMatch(source, /@embedFile|gpu_init|gpu_text_backend|grain/);
assert.match(source, /extern "host" fn gpu_submit/);
const terminal = await readFile(new URL("../../wgpuTerminal/src/Terminal.js", import.meta.url), "utf8");
assert.doesNotMatch(terminal, /_gpuInit/);
assert.ok(terminal.indexOf("this._registerTerminal(core, initialLayout)") <
  terminal.indexOf("await this._renderer.initialize("));
console.log("render frame contract passed (ABI v4, browser assets, both text renderers)");
