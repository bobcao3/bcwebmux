// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

export function pixelDifference(actual, expected, width, height, tolerance = 24) {
  assert.equal(actual.length, width * height * 3);
  assert.equal(expected.length, actual.length);
  const diff = Buffer.alloc(actual.length);
  const tiles = new Map();
  let changed = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 3;
    const differs = [0, 1, 2].some(c => Math.abs(actual[offset + c] - expected[offset + c]) > tolerance);
    const key = `${Math.floor(x / 64)},${Math.floor(y / 64)}`;
    const tile = tiles.get(key) || { changed: 0, total: 0 };
    tile.total++;
    if (differs) {
      changed++;
      tile.changed++;
      diff[offset] = 255;
      diff[offset + 2] = 255;
    }
    tiles.set(key, tile);
  }
  return { diff, changedRatio: changed / (width * height), maxTileRatio: Math.max(...[...tiles.values()].map(t => t.changed / t.total)) };
}

export async function compareScreenshot({ png, name, goldenName = name, goldenDir, outputDir, width, height, update = false }) {
  await mkdir(outputDir, { recursive: true });
  const actualPath = path.join(outputDir, `${name}.png`);
  const diffPath = path.join(outputDir, `${name}.diff.png`);
  await writeFile(actualPath, png);
  await rm(diffPath, { force: true });
  const decode = buffer => sharp(buffer).toColorspace("srgb").removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const actual = await decode(png);
  assert.equal(actual.info.width, width, `${name}: screenshot width`);
  assert.equal(actual.info.height, height, `${name}: screenshot height`);
  const goldenPath = path.join(goldenDir, `${goldenName}.webp`);
  if (update) {
    await mkdir(goldenDir, { recursive: true });
    await sharp(png).webp({ lossless: true }).toFile(goldenPath);
  }
  let golden;
  try { golden = await readFile(goldenPath); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error(`Missing ${goldenPath}; inspect ${actualPath}, then run UPDATE_GOLDEN=1 zig build visual-test`);
  }
  const expected = await decode(golden);
  assert.equal(expected.info.width, width, `${name}: golden width; actual: ${actualPath}`);
  assert.equal(expected.info.height, height, `${name}: golden height; actual: ${actualPath}`);
  const { diff, changedRatio, maxTileRatio } = pixelDifference(actual.data, expected.data, width, height);
  // A local limit prevents a missing glyph from disappearing in a mostly dark full viewport.
  if (changedRatio > 0.002 || maxTileRatio > 0.02) {
    await sharp(diff, { raw: { width, height, channels: 3 } }).png().toFile(diffPath);
    throw new Error(`${name}: changed ${(changedRatio * 100).toFixed(3)}%, worst tile ${(maxTileRatio * 100).toFixed(2)}%; actual: ${actualPath}; diff: ${diffPath}`);
  }
  return { changedRatio, maxTileRatio };
}
