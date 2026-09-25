// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import {
  ABSOLUTE_GLYPH_CACHE_MAX_BYTES,
  GlyphAtlasCapacityError,
  computeGlyphAtlasLimits,
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
assert.equal(r8.bytesPerSlot, 2160);
assert.equal(r8.slotLimit, Math.floor((32 * mib) / 2160));
assert.equal(
  computeGlyphAtlasLimits({
    maxTextureDimension: 65536,
    cellWidth: 1,
    cellHeight: 1,
    configuredMaxBytes: Number.MAX_SAFE_INTEGER,
  }).byteLimit,
  ABSOLUTE_GLYPH_CACHE_MAX_BYTES,
);

const exact = planGlyphAtlasGeometry(r8, 528, { preferredColumns: 66 });
assert.deepEqual(exact, {
  columns: 66,
  rows: 8,
  textureSlots: 528,
  byteLength: 528 * 2160,
  paddingSlots: 0,
});

const partitions = new GlyphAtlasPartitions(r8, 66);
const terminalA = {};
const terminalB = {};
let plan = partitions.planRegister(terminalA, 528);
partitions.commit(plan);
assert.equal(partitions.get(terminalA).slotCapacity, 528);
assert.equal(partitions.geometry.textureSlots, 528);

plan = partitions.planResize(terminalA, 264);
partitions.commit(plan);
assert.equal(partitions.get(terminalA).slotCapacity, 528);
assert.equal(partitions.get(terminalA).visibleSlots, 264);
assert.equal(partitions.geometry.textureSlots, 528);

plan = partitions.planRegister(terminalB, 528);
partitions.commit(plan);
assert.equal(partitions.reservedSlots, 1056);
assert.equal(partitions.get(terminalB).baseSlot, 528);
assert.equal(partitions.geometry.textureSlots, 1056);

plan = partitions.planResize(terminalA, 600);
partitions.commit(plan);
assert.equal(partitions.get(terminalA).slotCapacity, 600);
assert.equal(partitions.reservedSlots, 1128);
assert.ok(plan.invalidated.has(terminalB));
const a = partitions.get(terminalA);
const b = partitions.get(terminalB);
assert.ok(a.baseSlot + a.slotCapacity <= b.baseSlot || b.baseSlot + b.slotCapacity <= a.baseSlot);

const beforeRevision = partitions.revision;
const beforeA = partitions.get(terminalA);
assert.throws(
  () => partitions.planResize(terminalA, r8.slotLimit),
  (error) => error instanceof GlyphAtlasCapacityError && error.reason === "shared-demand",
);
assert.equal(partitions.revision, beforeRevision);
assert.deepEqual(partitions.get(terminalA), beforeA);

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
