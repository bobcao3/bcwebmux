// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CanvasGlyphRasterizer } from "../../wgpuTerminal/src/browser/render/CanvasAlphaMask.js";
import { decodeCanvasText } from "../../wgpuTerminal/src/FramePacket.js";
import { MAX_RUN_TEXT_BYTES } from "../../wgpuTerminal/src/browser/render/FrameSchema.js";
import { DEFAULT_FONT } from "../../wgpuTerminal/src/TerminalOptions.js";
import { GpuTerminal } from "../../wgpuTerminal/src/browser/render/webgpu/GpuTerminal.js";
import { WebGlTerminal } from "../../wgpuTerminal/src/browser/render/webgl/WebGlTerminal.js";
import { WebGlGlyphAtlas } from "../../wgpuTerminal/src/browser/render/webgl/WebGlGlyphAtlas.js";

const encoder = new TextEncoder();
const sample = "=>😀";
const bytes = encoder.encode(sample);
assert.equal(decodeCanvasText(bytes, 0, bytes.length), sample);
for (const text of ["中文 日本語 한글", "e\u0301", "👩🏽‍💻", "🇯🇵", "❤️", "\ufeffa"]) {
  const encoded = encoder.encode(text);
  assert.equal(decodeCanvasText(encoded, 0, encoded.length), text);
}
for (const bad of [
  new Uint8Array([0xff]),
  new Uint8Array([0xf0, 0x9f]),
  new Uint8Array([0xc0, 0x80]),
]) {
  assert.throws(() => decodeCanvasText(bad, 0, bad.length), /UTF-8/);
}
for (const [offset, count] of [
  [-1, 1],
  [0, 1.5],
  [bytes.length, 1],
  [0, MAX_RUN_TEXT_BYTES + 1],
  [0, 0],
]) {
  assert.throws(() => decodeCanvasText(bytes, offset, count), /text range/);
}
assert.throws(() => decodeCanvasText(encoder.encode("x".repeat(33)), 0, 33), /text count/);
const calls = [];
const context = {
  clearRect: (...args) => calls.push(["clearRect", ...args]),
  fillText: (...args) => calls.push(["fillText", ...args]),
  measureText: () => ({ fontBoundingBoxAscent: 1, fontBoundingBoxDescent: 0 }),
};
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
  rasterizer.rasterize(
    2,
    4,
    4,
    bytes,
    0,
    bytes.length,
    0,
    { columns: 3, rows: 2, tileWidth: 2, tileHeight: 2, fontSize: 2 },
    DEFAULT_FONT,
    (first, count, pixels, offset, stride) =>
      uploads.push([first, count, [...pixels], offset, stride]),
  );
  assert.deepEqual(calls, [
    ["clearRect", 0, 0, 8, 2],
    ["fillText", sample, 0, 2, 8],
    ["read", 0, 0, 8, 2],
  ]);
  assert.match(context.font, /normal 400 2px "JetBrains Mono Nerd Font"/);
  assert.match(context.font, /"Noto Emoji"/);
  assert.equal(context.textBaseline, "alphabetic");
  assert.deepEqual(uploads, [
    [2, 1, [1, 2, 9, 10], 0, 2],
    [3, 3, [3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 16], 0, 6],
  ]);
  const backendUploads = [];
  for (const backend of ["webgpu", "webgl2"]) {
    const rectangles = [];
    const atlas = {
      columns: 3,
      rows: 2,
      tileWidth: 2,
      tileHeight: 2,
      fontSize: 2,
      nextSlot: 0,
      texture: {},
    };
    let sink;
    if (backend === "webgpu") {
      sink = Object.assign(Object.create(GpuTerminal.prototype), {
        atlas,
        flushAtlasGrowthCopies() {},
        device: {
          queue: {
            writeTexture(destination, pixels, layout, size) {
              rectangles.push([destination.origin.slice(0, 2), size.slice(0, 2), [...pixels]]);
              assert.equal(layout.offset, 0);
              assert.equal(layout.bytesPerRow, size[0]);
            },
          },
        },
      });
    } else {
      const gl = {
        bindTexture() {},
        pixelStorei() {},
        texSubImage2D(target, level, x, y, width, height, format, type, pixels) {
          rectangles.push([[x, y], [width, height], [...pixels]]);
        },
      };
      sink = Object.assign(Object.create(WebGlTerminal.prototype), {
        atlas: Object.assign(Object.create(WebGlGlyphAtlas.prototype), atlas, { gl }),
      });
    }
    rasterizer.rasterize(2, 4, 4, bytes, 0, bytes.length, 0, sink.atlas, DEFAULT_FONT, (...args) =>
      sink.uploadBitmap(...args),
    );
    assert.equal(sink.atlas.nextSlot, 6);
    backendUploads.push(rectangles);
  }
  assert.deepEqual(backendUploads[0], backendUploads[1]);
  assert.deepEqual(
    backendUploads[0].map(([origin, size]) => [origin, size]),
    [
      [
        [4, 0],
        [2, 2],
      ],
      [
        [0, 2],
        [6, 2],
      ],
    ],
  );
  // Text offsets are bytes; preserve an entire grapheme in a single browser call.
  calls.length = 0;
  const prefixed = encoder.encode("prefix👩🏽‍💻");
  rasterizer.rasterize(
    0,
    2,
    2,
    prefixed,
    6,
    prefixed.length - 6,
    3,
    { columns: 3, rows: 2, tileWidth: 2, tileHeight: 2, fontSize: 2 },
    { ...DEFAULT_FONT, ligatures: false },
    () => {},
  );
  assert.ok(calls.some((call) => call[0] === "fillText" && call[1] === "👩🏽‍💻"));
  assert.match(context.font, /^italic 700/);
  assert.equal(context.fontKerning, "none");
  assert.equal(context.textRendering, "optimizeSpeed");
} finally {
  globalThis.document = previousDocument;
}
for (const name of ["webgpu/GlyphAtlas.js", "webgl/WebGlGlyphAtlas.js"]) {
  const source = await readFile(
    new URL(`../../wgpuTerminal/src/browser/render/${name}`, import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /getImageData|fillText|setCanvasRun|extends Canvas/);
}
console.log("Canvas text contract passed");
