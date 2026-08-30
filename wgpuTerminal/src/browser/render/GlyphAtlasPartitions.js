// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { GLYPH_SLOT_PROTOCOL_LIMIT, GlyphAtlasCapacityError, planGlyphAtlasGeometry } from "./GlyphAtlasLimits.js";

function slotCount(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > GLYPH_SLOT_PROTOCOL_LIMIT) throw new RangeError(`${label} must be a positive protocol slot count`);
  return value;
}

function checkedAdd(left, right, label) {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value > GLYPH_SLOT_PROTOCOL_LIMIT) throw new RangeError(`${label} exceeds protocol range`);
  return value;
}

function incrementGeneration(record) {
  if (!Number.isSafeInteger(record.generation) || record.generation <= 0 || record.generation >= 0xffffffff) throw new RangeError("glyph partition generation exhausted");
  record.generation += 1;
}

function cloneRecords(records) {
  return new Map([...records].map(([terminal, record]) => [terminal, { ...record }]));
}

export class GlyphAtlasPartitions {
  constructor(limits, preferredColumns) {
    this.limits = limits;
    this.preferredColumns = slotCount(preferredColumns, "preferred atlas columns");
    this.entries = new Map();
    this.settingsEpoch = 1;
    this.revision = 0;
    this.geometry = planGlyphAtlasGeometry(limits, 1, { preferredColumns: this.preferredColumns });
  }

  get size() { return this.entries.size; }
  get reservedSlots() {
    let total = 0;
    for (const record of this.entries.values()) total = checkedAdd(total, record.slotCapacity, "shared glyph reservation");
    return total;
  }

  get(terminal) {
    const record = this.entries.get(terminal);
    return record ? { ...record } : null;
  }

  values() {
    return [...this.entries].map(([terminal, record]) => ({ terminal, ...record }));
  }

  planRegister(terminal, visibleSlots) {
    if (this.entries.has(terminal)) throw new Error("terminal already owns a glyph partition");
    const capacity = slotCount(visibleSlots, "visible terminal cells");
    const records = cloneRecords(this.entries);
    records.set(terminal, { baseSlot: this.reservedSlots, slotCapacity: capacity, viewportCellHighWater: capacity, visibleSlots: capacity, generation: 1 });
    return this._plan(records);
  }

  planResize(terminal, visibleSlots) {
    const current = this.entries.get(terminal);
    if (!current) throw new Error("terminal has no glyph partition");
    const visible = slotCount(visibleSlots, "visible terminal cells");
    const records = cloneRecords(this.entries);
    const record = records.get(terminal);
    record.visibleSlots = visible;
    if (visible <= record.viewportCellHighWater) return this._plan(records, this.limits, this.geometry.columns, false, true);
    record.viewportCellHighWater = visible;
    record.slotCapacity = visible;
    return this._plan(records);
  }

  planRelease(terminal) {
    if (!this.entries.has(terminal)) throw new Error("terminal has no glyph partition");
    const records = cloneRecords(this.entries);
    records.delete(terminal);
    return this._plan(records, this.limits, this.geometry.columns, false, true);
  }

  planSettings(limits, preferredColumns, visibleSlotsByTerminal) {
    const records = cloneRecords(this.entries);
    const invalidated = new Set();
    for (const [terminal, record] of records) {
      const visible = slotCount(visibleSlotsByTerminal.get(terminal), "visible terminal cells");
      record.visibleSlots = visible;
      record.viewportCellHighWater = visible;
      record.slotCapacity = visible;
      incrementGeneration(record);
      invalidated.add(terminal);
    }
    if (this.settingsEpoch >= Number.MAX_SAFE_INTEGER) throw new RangeError("glyph settings epoch exhausted");
    const epoch = this.settingsEpoch + 1;
    return this._plan(records, limits, slotCount(preferredColumns, "preferred atlas columns"), true, false, invalidated, epoch);
  }

  _plan(records, limits = this.limits, preferredColumns = this.geometry.columns, settingsChange = false, keepGeometry = false, invalidated = new Set(), settingsEpoch = this.settingsEpoch) {
    let reservedSlots = 0;
    for (const record of records.values()) reservedSlots = checkedAdd(reservedSlots, record.slotCapacity, "shared glyph reservation");
    if (reservedSlots > limits.slotLimit) throw new GlyphAtlasCapacityError("shared-demand", { requestedSlots: reservedSlots, reservedSlots: this.reservedSlots, slotLimit: limits.slotLimit, bytesPerSlot: limits.bytesPerSlot, byteLimit: limits.byteLimit });
    let baseSlot = 0;
    for (const [terminal, record] of records) {
      if (record.baseSlot !== baseSlot) {
        record.baseSlot = baseSlot;
        incrementGeneration(record);
        invalidated.add(terminal);
      }
      baseSlot = checkedAdd(baseSlot, record.slotCapacity, "glyph partition extent");
    }
    const geometry = keepGeometry ? this.geometry : planGlyphAtlasGeometry(limits, Math.max(1, settingsChange ? reservedSlots : this.geometry.textureSlots, reservedSlots), { preferredColumns, reservedSlots });
    const columnsChanged = geometry.columns !== this.geometry.columns;
    if (columnsChanged) for (const [terminal, record] of records) {
      if (!invalidated.has(terminal)) incrementGeneration(record);
      invalidated.add(terminal);
    }
    return Object.freeze({ owner: this, revision: this.revision, records, invalidated, limits, preferredColumns, geometry, settingsEpoch, reservedSlots, requiredExtent: reservedSlots, textureReset: settingsChange || columnsChanged, textureChanged: settingsChange || columnsChanged || geometry.rows !== this.geometry.rows });
  }

  commit(plan) {
    if (plan.owner !== this || plan.revision !== this.revision) throw new Error("stale glyph atlas plan");
    this.entries = plan.records;
    this.limits = plan.limits;
    this.preferredColumns = plan.preferredColumns;
    this.geometry = plan.geometry;
    this.settingsEpoch = plan.settingsEpoch;
    this.revision += 1;
    return plan;
  }
}
