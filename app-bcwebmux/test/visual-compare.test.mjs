// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { pixelDifference, compareScreenshot } from "./visual-compare.mjs";

test("pixel comparison tolerates small channel noise but detects local missing content", () => {
  const expected = Buffer.alloc(1024 * 1024 * 3);
  assert.equal(pixelDifference(Buffer.alloc(expected.length, 12), expected, 1024, 1024).changedRatio, 0);
  const actual = Buffer.from(expected);
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) actual.fill(255, (y * 1024 + x) * 3, (y * 1024 + x) * 3 + 3);
  const result = pixelDifference(actual, expected, 1024, 1024);
  assert.ok(result.changedRatio < 0.002);
  assert.ok(result.maxTileRatio > 0.02, "local regression must not be diluted by the full viewport");
});

test("screenshot artifacts, explicit updates, missing baselines and viewport dimensions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "visual-compare-"));
  const options = { name: "test", goldenDir: path.join(dir, "golden"), outputDir: path.join(dir, "actual"), width: 64, height: 64 };
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "black" } }).png().toBuffer();
  try {
    await assert.rejects(compareScreenshot({ ...options, png }), /Missing/);
    assert.deepEqual(await readFile(path.join(options.outputDir, "test.png")), png);
    await compareScreenshot({ ...options, png, update: true });
    assert.equal((await compareScreenshot({ ...options, png })).changedRatio, 0);
    assert.equal((await compareScreenshot({ ...options, name: "returned", goldenName: "test", png })).changedRatio, 0);
    await assert.rejects(compareScreenshot({ ...options, png, width: 65 }), /screenshot width/);
    const changed = await sharp({ create: { width: 64, height: 64, channels: 3, background: "white" } }).png().toBuffer();
    await assert.rejects(compareScreenshot({ ...options, png: changed }), /worst tile/);
    assert.ok((await readFile(path.join(options.outputDir, "test.diff.png"))).length);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
