// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

assert.equal(process.argv.length, 3, "usage: node kitty-adapter-proof-wasm.mjs <proof.wasm>");
const module = await WebAssembly.compile(await readFile(process.argv[2]));
const imports = WebAssembly.Module.imports(module);
assert.deepEqual(imports, [], `unexpected WASM imports: ${JSON.stringify(imports)}`);
const instance = await WebAssembly.instantiate(module);
assert.equal(typeof instance.exports.kitty_graphics_available, "function", "missing capability probe");
assert.equal(instance.exports.kitty_graphics_available(), 0,
  "Pinned WASM capability changed: revisit the graphics integration gate and replace this limitation test");
console.log("Kitty WASM limitation confirmed: +kitty-graphics is force-disabled on freestanding targets");
