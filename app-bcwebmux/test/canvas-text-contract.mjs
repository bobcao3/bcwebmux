// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { decodeCanvasText } from "../../wgpuTerminal/src/FramePacket.js";
import { MAX_RUN_TEXT_BYTES } from "../../wgpuTerminal/src/browser/render/FrameSchema.js";

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
for (const name of ["webgpu/GlyphAtlas.js", "webgl/WebGlGlyphAtlas.js"]) {
  const source = await readFile(
    new URL(`../../wgpuTerminal/src/browser/render/${name}`, import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /getImageData|fillText|setCanvasRun|extends Canvas/);
}
console.log("Canvas text contract passed");
