// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { Terminal } from "../../wgpuTerminal/src/Terminal.js";
import { GlyphAtlas } from "../../wgpuTerminal/src/browser/render/webgpu/GlyphAtlas.js";
import { glyphAtlasSnapshotLayout } from "../../wgpuTerminal/src/browser/render/GlyphAtlasSnapshot.js";

const geometry = { columns: 1, rows: 1, tileWidth: 3, tileHeight: 2 };
assert.equal(glyphAtlasSnapshotLayout(geometry).width, 3);
for (const tileWidth of [0, NaN, Infinity, 16 * 1024 * 1024]) {
  assert.throws(() => glyphAtlasSnapshotLayout({ ...geometry, tileWidth }), /debug limit/);
}

const renderer = { atlas: { texture: {} } };
const terminal = { _assertMutable() {}, _renderer: renderer };
let complete;
renderer.readGlyphAtlas = () =>
  new Promise((resolve) => {
    complete = resolve;
  });
const read = () => Terminal.prototype.readGlyphAtlas.call(terminal);
let pending = read();
await assert.rejects(read(), /already pending/);
complete({ data: new Uint8Array([123]) });
assert.equal((await pending).data[0], 123);
pending = read();
renderer.atlas.texture = {};
complete({});
await assert.rejects(pending, /changed during readback/);
assert.equal(terminal._glyphAtlasReadPending, false);
pending = read();
terminal._disposed = true;
complete({});
await assert.rejects(pending, /changed during readback/);
await assert.rejects(read(), /unavailable/);
terminal._disposed = false;
renderer.readGlyphAtlas = () => {
  throw new Error("device lost");
};
await assert.rejects(read(), /device lost/);
assert.equal(terminal._glyphAtlasReadPending, false);

globalThis.GPUBufferUsage = { MAP_READ: 1, COPY_DST: 2 };
globalThis.GPUMapMode = { READ: 1 };
let destroyed = false;
const buffer = {
  mapAsync: async () => {
    throw new Error("map failed");
  },
  destroy() {
    destroyed = true;
  },
};
const atlas = Object.assign(Object.create(GlyphAtlas.prototype), geometry, {
  texture: {},
  pendingTextureCopies: [],
  device: {
    createBuffer({ size }) {
      assert.equal(size, 512);
      return buffer;
    },
    createCommandEncoder: () => ({
      copyTextureToBuffer() {},
      finish() {
        return {};
      },
    }),
    queue: { submit() {} },
  },
});
await assert.rejects(atlas.readPixels(), /map failed/);
assert.equal(destroyed, true);
atlas.pendingTextureCopies.push({});
await assert.rejects(atlas.readPixels(), /not ready/);
console.log("glyph atlas snapshot contract passed");
