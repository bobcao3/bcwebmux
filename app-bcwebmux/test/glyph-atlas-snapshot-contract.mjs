// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { glyphAtlasSnapshotLayout } from "../../wgpuTerminal/src/browser/render/GlyphAtlasSnapshot.js";

// Asymmetric grid: a transposed axis order cannot pass below.
const geometry = { columns: 5, rows: 3, tileWidth: 7, tileHeight: 11 };
const layout = glyphAtlasSnapshotLayout(geometry);
assert.equal(layout.width, 35);
assert.equal(layout.height, 33);
for (const key of ["columns", "rows", "tileWidth", "tileHeight"]) {
  assert.equal(layout[key], geometry[key], `${key} round-trips`);
}
for (const tileWidth of [0, NaN, Infinity, 16 * 1024 * 1024]) {
  assert.throws(() => glyphAtlasSnapshotLayout({ ...geometry, tileWidth }), /debug limit/);
}
console.log("glyph atlas snapshot contract passed");
