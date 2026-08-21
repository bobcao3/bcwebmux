// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import {
  DEFAULT_WASM_FONT_FILES,
  loadWasmFontFaces,
  resolveWasmFontUrls,
} from "../../wgpuTerminal/src/WasmFonts.js";

const defaults = resolveWasmFontUrls("https://example.test/assets/terminal.wasm");
assert.deepEqual(defaults, DEFAULT_WASM_FONT_FILES.map(file => `https://example.test/assets/fonts/${file}`));
assert.deepEqual(
  resolveWasmFontUrls("https://example.test/assets/terminal.wasm", ["a.ttf", "b.ttf", "c.ttf", "d.ttf"]),
  ["a.ttf", "b.ttf", "c.ttf", "d.ttf"].map(file => `https://example.test/assets/${file}`),
);
assert.throws(() => resolveWasmFontUrls("/terminal.wasm", ["only-one.ttf"]), /four|regular/i);
assert.throws(() => resolveWasmFontUrls("/terminal.wasm", "abcd"), /array/i);

const originalFetch = globalThis.fetch;
let fetches = 0;
globalThis.fetch = async url => {
  fetches += 1;
  const bytes = new TextEncoder().encode(String(url));
  return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer };
};
try {
  const first = await loadWasmFontFaces(defaults);
  const second = await loadWasmFontFaces(defaults);
  assert.equal(fetches, 4);
  for (let index = 0; index < 4; index += 1) assert.strictEqual(first[index], second[index]);

} finally {
  globalThis.fetch = originalFetch;
}

console.log(JSON.stringify({ wasmFontContract: "ok", fetches }));
