// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { GLYPH_SLOT_PROTOCOL_LIMIT, planGlyphAtlasGeometry } from "./GlyphAtlasLimits.js";

function slotCount(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > GLYPH_SLOT_PROTOCOL_LIMIT)
    throw new RangeError(`${label} must be a positive protocol slot count`);
  return value;
}

function incrementGeneration(record) {
  if (
    !Number.isSafeInteger(record.generation) ||
    record.generation <= 0 ||
    record.generation >= 0xffffffff
  )
    throw new RangeError("glyph partition generation exhausted");
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
    this.activeTerminal = null;
    this.settingsEpoch = 1;
    this.revision = 0;
    this.geometry = planGlyphAtlasGeometry(limits, 1, { preferredColumns: this.preferredColumns });
  }

  get size() {
    return this.entries.size;
  }
  get reservedSlots() {
    const terminal = this.activeTerminal ?? this.entries.keys().next().value;
    return this.entries.get(terminal)?.slotCapacity ?? 0;
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
    records.set(terminal, {
      baseSlot: 0,
      slotCapacity: capacity,
      viewportCellHighWater: capacity,
      visibleSlots: capacity,
      generation: 1,
    });
    return this._plan(records);
  }

  planResize(terminal, visibleSlots) {
    const current = this.entries.get(terminal);
    if (!current) throw new Error("terminal has no glyph partition");
    const visible = slotCount(visibleSlots, "visible terminal cells");
    const records = cloneRecords(this.entries);
    const record = records.get(terminal);
    record.visibleSlots = visible;
    if (visible <= record.viewportCellHighWater)
      return this._plan(records, this.limits, this.geometry.columns, false, true);
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

  planActivate(terminal) {
    if (!this.entries.has(terminal)) throw new Error("terminal has no glyph partition");
    const records = cloneRecords(this.entries);
    const invalidated = new Set();
    if (this.activeTerminal !== terminal) {
      incrementGeneration(records.get(terminal));
      invalidated.add(terminal);
    }
    return this._plan(
      records,
      this.limits,
      this.geometry.columns,
      false,
      false,
      invalidated,
      this.settingsEpoch,
      terminal,
    );
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
    if (this.settingsEpoch >= Number.MAX_SAFE_INTEGER)
      throw new RangeError("glyph settings epoch exhausted");
    const epoch = this.settingsEpoch + 1;
    return this._plan(
      records,
      limits,
      slotCount(preferredColumns, "preferred atlas columns"),
      true,
      false,
      invalidated,
      epoch,
    );
  }

  _plan(
    records,
    limits = this.limits,
    preferredColumns = this.geometry.columns,
    settingsChange = false,
    keepGeometry = false,
    invalidated = new Set(),
    settingsEpoch = this.settingsEpoch,
    activeTerminal = this.activeTerminal,
  ) {
    const capacityOwner = records.has(activeTerminal)
      ? activeTerminal
      : records.keys().next().value;
    const reservedSlots = records.get(capacityOwner)?.slotCapacity ?? 0;
    const geometry = keepGeometry
      ? this.geometry
      : planGlyphAtlasGeometry(
          limits,
          Math.max(1, settingsChange ? reservedSlots : this.geometry.textureSlots, reservedSlots),
          { preferredColumns, reservedSlots },
        );
    const columnsChanged = geometry.columns !== this.geometry.columns;
    if (columnsChanged)
      for (const [terminal, record] of records) {
        if (!invalidated.has(terminal)) incrementGeneration(record);
        invalidated.add(terminal);
      }
    return Object.freeze({
      owner: this,
      revision: this.revision,
      records,
      activeTerminal: records.has(activeTerminal) ? activeTerminal : null,
      invalidated,
      limits,
      preferredColumns,
      geometry,
      settingsEpoch,
      reservedSlots,
      requiredExtent: reservedSlots,
      textureReset: settingsChange || columnsChanged,
      textureChanged: settingsChange || columnsChanged || geometry.rows !== this.geometry.rows,
    });
  }

  commit(plan) {
    if (plan.owner !== this || plan.revision !== this.revision)
      throw new Error("stale glyph atlas plan");
    this.entries = plan.records;
    this.activeTerminal = plan.activeTerminal;
    this.limits = plan.limits;
    this.preferredColumns = plan.preferredColumns;
    this.geometry = plan.geometry;
    this.settingsEpoch = plan.settingsEpoch;
    this.revision += 1;
    return plan;
  }
}
