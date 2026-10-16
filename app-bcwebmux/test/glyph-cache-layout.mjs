// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import {
  ABSOLUTE_GLYPH_CACHE_MAX_BYTES,
  GlyphAtlasCapacityError,
  computeGlyphAtlasLimits,
  growGlyphAtlasRows,
  planGlyphAtlasGeometry,
} from "../../wgpuTerminal/src/browser/render/GlyphAtlasLimits.js";
import { GlyphAtlasPartitions } from "../../wgpuTerminal/src/browser/render/GlyphAtlasPartitions.js";

const mib = 1024 * 1024;
const r8 = computeGlyphAtlasLimits({
  maxTextureDimension: 8192,
  cellWidth: 30,
  cellHeight: 72,
  configuredMaxBytes: 32 * mib,
});
const r8Settings = computeGlyphAtlasLimits({
  maxTextureDimension: 8192,
  cellWidth: 30,
  cellHeight: 72,
  configuredMaxBytes: 16 * mib,
});
assert.equal(
  computeGlyphAtlasLimits({
    maxTextureDimension: 65536,
    cellWidth: 1,
    cellHeight: 1,
    configuredMaxBytes: Number.MAX_SAFE_INTEGER,
  }).byteLimit,
  ABSOLUTE_GLYPH_CACHE_MAX_BYTES,
);

const requestedSlots = 528;
const exact = planGlyphAtlasGeometry(r8, requestedSlots, { preferredColumns: 66 });
assert.equal(exact.width, 1024, "physical width stays fixed despite the preferred width");
assert.equal(exact.columns, 34, "the atlas admits only complete cells across a page");
assert.equal(exact.rows, 16);
assert.equal(exact.initialRows, 8, "the 256-slot minimum exceeds a quarter of 528 cells");
assert.equal(exact.textureSlots, 544);
assert.ok(exact.textureSlots >= requestedSlots, "plan covers the requested slots");
assert.equal(exact.textureSlots % exact.columns, 0, "rows are whole tiles");
assert.equal(exact.byteLength, 1024 * 16 * 72, "the R8 ceiling includes right-edge pixel padding");
assert.ok(exact.byteLength <= r8.byteLimit, "plan fits the configured byte budget");
assert.equal(
  exact.paddingSlots,
  exact.textureSlots - requestedSlots,
  "padding covers exactly the unwritten slots",
);

const partitions = new GlyphAtlasPartitions(r8, 66);
const terminalA = {};
const terminalB = {};
let plan = partitions.planRegister(terminalA, 528);
partitions.commit(plan);
assert.equal(partitions.get(terminalA).slotCapacity, 528);
assert.equal(partitions.geometry.textureSlots, 544);

plan = partitions.planResize(terminalA, 264);
partitions.commit(plan);
assert.equal(partitions.get(terminalA).slotCapacity, 528);
assert.equal(partitions.get(terminalA).visibleSlots, 264);
assert.equal(partitions.geometry.textureSlots, 544);

plan = partitions.planRegister(terminalB, 528);
partitions.commit(plan);
assert.equal(partitions.reservedSlots, 528, "inactive terminals do not reserve extra GPU capacity");
assert.equal(partitions.get(terminalB).baseSlot, 0);
assert.equal(partitions.geometry.textureSlots, 544);

plan = partitions.planResize(terminalA, 600);
partitions.commit(plan);
assert.equal(partitions.get(terminalA).slotCapacity, 600);
assert.equal(partitions.reservedSlots, 600);
assert.ok(!plan.invalidated.has(terminalB));
const a = partitions.get(terminalA);
const b = partitions.get(terminalB);
assert.equal(a.baseSlot, b.baseSlot, "only the active terminal owns the shared slot space");
partitions.commit(partitions.planActivate(terminalA));
const generationA = partitions.get(terminalA).generation;
partitions.commit(partitions.planActivate(terminalB));
assert.equal(partitions.get(terminalA).generation, generationA);
partitions.commit(partitions.planActivate(terminalA));
assert.equal(
  partitions.get(terminalA).generation,
  generationA + 1,
  "reactivation invalidates glyphs overwritten by another terminal",
);
const stableGeneration = partitions.get(terminalA).generation;
partitions.commit(partitions.planActivate(terminalA));
assert.equal(
  partitions.get(terminalA).generation,
  stableGeneration,
  "reselecting the current owner preserves valid glyph mappings",
);

const beforeRevision = partitions.revision;
const beforeA = partitions.get(terminalA);
assert.throws(
  () => partitions.planResize(terminalA, r8.slotLimit + 1),
  (error) => error instanceof GlyphAtlasCapacityError && error.reason === "byte-budget",
);
assert.equal(partitions.revision, beforeRevision);
assert.deepEqual(partitions.get(terminalA), beforeA);

const inactiveLarge = {};
const activeExtent = partitions.geometry.textureSlots;
partitions.commit(partitions.planRegister(inactiveLarge, r8.slotLimit + 1));
assert.equal(
  partitions.reservedSlots,
  600,
  "an inactive viewport cannot exhaust the active owner's budget",
);
assert.equal(partitions.geometry.textureSlots, activeExtent);
partitions.commit(partitions.planRelease(inactiveLarge));

const oldTextureSlots = partitions.geometry.textureSlots;
plan = partitions.planRelease(terminalB);
partitions.commit(plan);
assert.equal(partitions.size, 1);
assert.equal(partitions.geometry.textureSlots, oldTextureSlots);

const r8Current = new Map([[terminalA, 300]]);
plan = partitions.planSettings(r8Settings, 50, r8Current);
assert.ok(plan.invalidated.has(terminalA));
partitions.commit(plan);
assert.equal(partitions.settingsEpoch, 2);
assert.equal(partitions.get(terminalA).slotCapacity, 300);
assert.equal(partitions.get(terminalA).baseSlot, 0);
assert.ok(partitions.geometry.byteLength <= r8Settings.byteLimit);

const asymmetric = computeGlyphAtlasLimits({
  maxTextureDimension: 1024,
  cellWidth: 13,
  cellHeight: 19,
  configuredMaxBytes: 16 * mib,
});
for (const [cells, rows, initialRows, textureSlots] of [
  [0, 4, 4, 312],
  [100, 4, 4, 312],
  [1025, 14, 4, 1092],
  [1600, 21, 6, 1638],
  [4134, 53, 14, 4134],
  [4135, 106, 14, 8268],
]) {
  const geometry = planGlyphAtlasGeometry(asymmetric, cells, { preferredColumns: 1 });
  assert.equal(geometry.width, 1024);
  assert.equal(geometry.columns, 78);
  assert.equal(geometry.rows, rows, `maximum rows for ${cells} cells`);
  assert.equal(geometry.initialRows, initialRows, `initial rows for ${cells} cells`);
  assert.equal(geometry.textureSlots, textureSlots);
}
assert.throws(
  () =>
    planGlyphAtlasGeometry(
      computeGlyphAtlasLimits({
        maxTextureDimension: 1024,
        maxTextureArrayLayers: 1,
        cellWidth: 13,
        cellHeight: 19,
      }),
      4135,
    ),
  (error) => error instanceof GlyphAtlasCapacityError && error.reason === "hardware",
);
for (const metrics of [
  { maxTextureDimension: 1023, cellWidth: 13, cellHeight: 19 },
  { maxTextureDimension: 1024, cellWidth: 1025, cellHeight: 19 },
  { maxTextureDimension: 1024, cellWidth: 13, cellHeight: 1025 },
  { maxTextureDimension: 512, cellWidth: 128, cellHeight: 128 },
]) {
  assert.throws(
    () => planGlyphAtlasGeometry(computeGlyphAtlasLimits(metrics), 1),
    GlyphAtlasCapacityError,
  );
}
const exactBudget = { maxTextureDimension: 1024, cellWidth: 13, cellHeight: 19 };
assert.equal(
  planGlyphAtlasGeometry(
    computeGlyphAtlasLimits({ ...exactBudget, configuredMaxBytes: 77824 }),
    256,
  ).byteLength,
  77824,
);
for (const [configuredMaxBytes, cells] of [
  [77823, 1],
  [77824, 313],
]) {
  assert.throws(
    () =>
      planGlyphAtlasGeometry(
        computeGlyphAtlasLimits({ ...exactBudget, configuredMaxBytes }),
        cells,
      ),
    (error) => error instanceof GlyphAtlasCapacityError && error.reason === "byte-budget",
    "admission includes the 256-slot floor, whole rows, and unused right-edge pixels",
  );
}
for (const [current, required, maximum, expected] of [
  [11, 429, 42, 11],
  [11, 430, 42, 22],
  [22, 859, 42, 42],
  [22, 1638, 42, 42],
])
  assert.equal(growGlyphAtlasRows(current, required, 39, maximum), expected);
assert.throws(() => growGlyphAtlasRows(11, 1639, 39, 42));
assert.equal(growGlyphAtlasRows(40, 78 * 60, 78, 159, 53), 106);
const crowded = new GlyphAtlasPartitions(asymmetric, 80);
for (let i = 0; i < 20; i++) crowded.commit(crowded.planRegister({}, 11440));
assert.equal(crowded.reservedSlots, 11440);
assert.equal(
  crowded.geometry.rows,
  159,
  "a full screen spans three pages instead of failing at one page height",
);
console.log("glyph cache layout contract passed");
