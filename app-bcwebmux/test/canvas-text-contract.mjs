// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { decodeCanvasText } from "../../wgpuTerminal/src/FramePacket.js";
import { MAX_RUN_TEXT_BYTES } from "../../wgpuTerminal/src/browser/render/FrameSchema.js";
import {
  splitCanvasLayers,
  isChromaticPixel,
  COLOR_CHROMA_THRESHOLD,
} from "../../wgpuTerminal/src/browser/render/CanvasAlphaMask.js";

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
assert.equal(COLOR_CHROMA_THRESHOLD, 12);
assert.equal(isChromaticPixel(255, 255, 255, 255), false);
assert.equal(isChromaticPixel(255, 0, 0, 255), true);
assert.equal(isChromaticPixel(255, 0, 0, 0), false);
{
  const image = { data: new Uint8ClampedArray([255, 255, 255, 255, 250, 30, 40, 255]) };
  const split = splitCanvasLayers(image, 2, 1);
  assert.deepEqual(Array.from(split.mask), [255, 255]);
  assert.equal(split.hasColor, true);
  assert.deepEqual(Array.from(split.overlay.slice(0, 4)), [0, 0, 0, 0]);
  assert.deepEqual(Array.from(split.overlay.slice(4, 8)), [250, 30, 40, 255]);
}
{
  const whiteImage = { data: new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255]) };
  const whiteSplit = splitCanvasLayers(whiteImage, 2, 1);
  assert.equal(whiteSplit.hasColor, false);
  assert.deepEqual(Array.from(whiteSplit.overlay), [0, 0, 0, 0, 0, 0, 0, 0]);
}
async function readSource(relativePath) {
  return await readFile(new URL(relativePath, import.meta.url), "utf8");
}
for (const name of ["webgpu/GlyphAtlas.js", "webgl/WebGlGlyphAtlas.js"]) {
  const source = await readSource(`../../wgpuTerminal/src/browser/render/${name}`);
  assert.match(source, /colorTexture/);
  assert.match(source, /uploadColorBitmap/);
  assert.doesNotMatch(source, /getImageData|fillText|setCanvasRun|extends Canvas/);
}
{
  const cellShader = await readSource(
    "../../wgpuTerminal/src/browser/render/webgpu/shaders/cell.wgsl",
  );
  assert.match(cellShader, /color_atlas_texture/);
  assert.match(cellShader, /binding\(6\)/);
  assert.equal(cellShader.split("vec3<Lowp>(color_texel.rgb)").length - 1, 2);
}
{
  const resources = await readSource(
    "../../wgpuTerminal/src/browser/render/webgl/WebGlTerminalResources.js",
  );
  assert.match(resources, /u_color_atlas/);
}
{
  const terminal = await readSource("../../wgpuTerminal/src/Terminal.js");
  assert.match(terminal, /readColorAtlas/);
}
{
  const presenter = await readSource("../../wgpuTerminal/src/browser/render/FramePresenter.js");
  assert.match(presenter, /uploadColorBitmap/);
}
{
  const dialog = await readSource("../web/GlyphAtlasDialog.js");
  assert.match(dialog, /glyph-atlas-layer/);
  assert.match(dialog, /readColorAtlas/);
  assert.match(dialog, /RGBA overlay/);
}
{
  const page = await readSource("../web/index.html");
  assert.match(page, /glyph-atlas-layer/);
  assert.match(page, /Color overlay/);
}
{
  const terminal = await readSource("../../wgpuTerminal/src/Terminal.js");
  assert.match(terminal, /renderer === "kb-stb" \? "kb-stb" : "canvas"/);
}
console.log("Canvas text contract passed");
