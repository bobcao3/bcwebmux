// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CanvasGlyphRasterizer } from "../../wgpuTerminal/src/browser/render/CanvasAlphaMask.js";
import { validateCanvasPath } from "../../wgpuTerminal/src/FramePacket.js";
import { PATH_COMMAND_SIZE, PATH_OP, MAX_RUN_PATH_COMMANDS } from "../../wgpuTerminal/src/browser/render/FrameSchema.js";
import { GpuTerminal } from "../../wgpuTerminal/src/browser/render/webgpu/GpuTerminal.js";
import { WebGlTerminal } from "../../wgpuTerminal/src/browser/render/webgl/WebGlTerminal.js";
import { WebGlGlyphAtlas } from "../../wgpuTerminal/src/browser/render/webgl/WebGlGlyphAtlas.js";

function stream(records) {
  const view = new DataView(new ArrayBuffer(records.length * PATH_COMMAND_SIZE));
  records.forEach(([op, ...values], i) => {
    view.setUint32(i * PATH_COMMAND_SIZE, op, true);
    values.forEach((v, j) => view.setFloat32(i * PATH_COMMAND_SIZE + 4 + j * 4, v, true));
  });
  return view;
}
const records = [
  [PATH_OP.move, 1, 2], [PATH_OP.line, 3, 4],
  [PATH_OP.quadratic, 5, 6, 7, 8],
  [PATH_OP.cubic, 9, 10, 11, 12, 13, 14], [PATH_OP.close],
];
const commands = stream(records);
validateCanvasPath(commands, 0, records.length);
for (const bad of [
  [[9]], [[PATH_OP.line]], [[PATH_OP.close]], [[PATH_OP.move]],
  [[PATH_OP.move], [PATH_OP.move], [PATH_OP.close]],
  [[PATH_OP.move, NaN], [PATH_OP.close]],
  [[PATH_OP.move, Infinity], [PATH_OP.close]],
  [[PATH_OP.move, 1048577], [PATH_OP.close]],
]) assert.throws(() => validateCanvasPath(stream(bad), 0, bad.length), /Canvas path/);
for (const [offset, count] of [[-1, 1], [0, 1.5], [5, 1], [0, MAX_RUN_PATH_COMMANDS + 1]]) {
  assert.throws(() => validateCanvasPath(commands, offset, count), /path range/);
}
const calls = [];
const context = Object.fromEntries(["clearRect", "beginPath", "moveTo", "lineTo", "quadraticCurveTo", "bezierCurveTo", "closePath", "fill"].map(name =>
  [name, (...args) => calls.push([name, ...args])]));
context.fillText = context.measureText = () => { throw Error("browser text layout forbidden"); };
context.getImageData = (x, y, width, height) => {
  calls.push(["read", x, y, width, height]);
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data[i * 4 + 3] = i + 1;
  return { data };
};
const previousDocument = globalThis.document;
globalThis.document = { createElement: () => ({ width: 1, height: 1, getContext: () => context }) };
try {
  const rasterizer = new CanvasGlyphRasterizer();
  const uploads = [];
  // Four tiles start in the last column: two row rectangles, one complete-run readback.
  rasterizer.rasterize(2, 4, 4, commands, 0, records.length,
    { columns: 3, rows: 2, tileWidth: 2, tileHeight: 2 },
    (first, count, pixels, offset, stride) => uploads.push([first, count, [...pixels], offset, stride]));
  assert.deepEqual(calls, [
    ["clearRect", 0, 0, 8, 2], ["beginPath"], ["moveTo", 1, 2], ["lineTo", 3, 4],
    ["quadraticCurveTo", 7, 8, 5, 6], ["bezierCurveTo", 11, 12, 13, 14, 9, 10],
    ["closePath"], ["fill", "nonzero"], ["read", 0, 0, 8, 2],
  ]);
  assert.deepEqual(uploads, [
    [2, 1, [1, 2, 9, 10], 0, 2],
    [3, 3, [3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 16], 0, 6],
  ]);
  const backendUploads = [];
  for (const backend of ["webgpu", "webgl2"]) {
    const rectangles = [];
    const atlas = { columns: 3, rows: 2, tileWidth: 2, tileHeight: 2, nextSlot: 0, texture: {} };
    let sink;
    if (backend === "webgpu") {
      sink = Object.assign(Object.create(GpuTerminal.prototype), {
        atlas, flushAtlasGrowthCopies() {},
        device: { queue: { writeTexture(destination, pixels, layout, size) {
          rectangles.push([destination.origin.slice(0, 2), size.slice(0, 2), [...pixels]]);
          assert.equal(layout.offset, 0);
          assert.equal(layout.bytesPerRow, size[0]);
        } } },
      });
    } else {
      const gl = {
        bindTexture() {}, pixelStorei() {},
        texSubImage2D(target, level, x, y, width, height, format, type, pixels) {
          rectangles.push([[x, y], [width, height], [...pixels]]);
        },
      };
      sink = Object.assign(Object.create(WebGlTerminal.prototype), {
        atlas: Object.assign(Object.create(WebGlGlyphAtlas.prototype), atlas, { gl }),
      });
    }
    rasterizer.rasterize(2, 4, 4, commands, 0, records.length, sink.atlas,
      (...args) => sink.uploadBitmap(...args));
    assert.equal(sink.atlas.nextSlot, 6);
    backendUploads.push(rectangles);
  }
  assert.deepEqual(backendUploads[0], backendUploads[1]);
  assert.deepEqual(backendUploads[0].map(([origin, size]) => [origin, size]), [
    [[4, 0], [2, 2]], [[0, 2], [6, 2]],
  ]);
  // Nonzero command offsets use command indices, not byte offsets.
  calls.length = 0;
  const prefixed = stream([...records, ...records]);
  rasterizer.rasterize(0, 1, 1, prefixed, records.length, records.length,
    { columns: 3, rows: 2, tileWidth: 2, tileHeight: 2 }, () => {});
  assert.ok(calls.some(call => call[0] === "bezierCurveTo"));
} finally {
  globalThis.document = previousDocument;
}
for (const name of ["CanvasAlphaMask.js", "webgpu/GlyphAtlas.js", "webgl/WebGlGlyphAtlas.js"]) {
  const source = await readFile(new URL(`../../wgpuTerminal/src/browser/render/${name}`, import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:fillText|measureText|textBaseline|fontFamily)\b/);
  if (name !== "CanvasAlphaMask.js") assert.doesNotMatch(source, /getImageData|setCanvasRun|extends Canvas/);
}
console.log("Canvas path contract passed");
