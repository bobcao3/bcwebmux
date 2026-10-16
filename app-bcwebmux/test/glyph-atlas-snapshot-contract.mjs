// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { glyphAtlasSnapshotLayout } from "../../wgpuTerminal/src/browser/render/GlyphAtlasSnapshot.js";

// Asymmetric grid: a transposed axis order cannot pass below.
const geometry = { width: 512, columns: 39, rows: 22, colorRows: 7, tileWidth: 13, tileHeight: 19 };
const layout = glyphAtlasSnapshotLayout(geometry);
assert.equal(layout.width, 512, "snapshots include the five right-padding pixels");
assert.equal(layout.height, 418);
for (const key of ["columns", "rows", "tileWidth", "tileHeight"]) {
  assert.equal(layout[key], geometry[key], `${key} round-trips`);
}
const color = glyphAtlasSnapshotLayout(geometry, true);
assert.equal(color.width, 512);
assert.equal(color.height, 133, "color snapshots use the compact texture's independent height");
assert.equal(color.rows, 7);
for (const tileWidth of [0, NaN, Infinity, 16 * 1024 * 1024]) {
  assert.throws(
    () => glyphAtlasSnapshotLayout({ ...geometry, width: undefined, tileWidth }),
    /debug limit/,
  );
}
for (const rows of [0, NaN, Infinity, 16 * 1024 * 1024]) {
  assert.throws(() => glyphAtlasSnapshotLayout({ ...geometry, rows }), /debug limit/);
  assert.throws(
    () => glyphAtlasSnapshotLayout({ ...geometry, colorRows: rows }, true),
    /debug limit/,
  );
}
console.log("glyph atlas snapshot contract passed");
