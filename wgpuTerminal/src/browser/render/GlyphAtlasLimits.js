// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

export const ABSOLUTE_GLYPH_CACHE_MAX_BYTES = 256 * 1024 * 1024;
export const GLYPH_SLOT_PROTOCOL_LIMIT = 0xfffffffe;
export const TERMINAL_CELL_PROTOCOL_LIMIT = 0xffff;
export const GLYPH_ATLAS_WIDTH = 1024;
export const GLYPH_ATLAS_MIN_SLOTS = 256;

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${label} must be a positive integer`);
  return value;
}

function checkedMultiply(left, right, label) {
  const value = left * right;
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} exceeds integer range`);
  return value;
}

export function normalizeByteLimit(value, absolute, label) {
  if (value === undefined || value === null) return absolute;
  const normalized = positiveInteger(Number(value), label);
  return Math.min(normalized, absolute);
}

export class GlyphAtlasCapacityError extends RangeError {
  constructor(reason, details) {
    super(`glyph atlas ${reason}: requested ${details.requestedSlots}, limit ${details.slotLimit}`);
    this.name = "GlyphAtlasCapacityError";
    this.code = "ERR_GLYPH_ATLAS_CAPACITY";
    this.reason = reason;
    Object.assign(this, details);
  }
}

export function computeGlyphAtlasLimits(options) {
  const maxTextureDimension = positiveInteger(
    options.maxTextureDimension,
    "maximum texture dimension",
  );
  const cellWidth = positiveInteger(options.cellWidth, "glyph cell width");
  const cellHeight = positiveInteger(options.cellHeight, "glyph cell height");
  const protocolSlotLimit = positiveInteger(
    options.protocolSlotLimit ?? GLYPH_SLOT_PROTOCOL_LIMIT,
    "glyph slot protocol limit",
  );
  const maximumLayers = positiveInteger(
    options.maxTextureArrayLayers ?? 256,
    "maximum texture array layers",
  );
  const configuredMaxBytes = normalizeByteLimit(
    options.configuredMaxBytes,
    ABSOLUTE_GLYPH_CACHE_MAX_BYTES,
    "glyph cache byte limit",
  );
  const byteLimit = configuredMaxBytes;
  const bytesPerSlot = checkedMultiply(cellWidth, cellHeight, "glyph slot bytes");
  const maximumColumns = Math.floor(GLYPH_ATLAS_WIDTH / cellWidth);
  const maximumRows = Math.floor(maxTextureDimension / cellHeight);
  if (maxTextureDimension < GLYPH_ATLAS_WIDTH || maximumColumns < 1 || maximumRows < 1) {
    throw new GlyphAtlasCapacityError("hardware", {
      requestedSlots: 1,
      reservedSlots: 0,
      slotLimit: 0,
      bytesPerSlot,
      byteLimit,
    });
  }
  const hardwareRows = checkedMultiply(maximumRows, maximumLayers, "hardware glyph rows");
  const hardwareSlotLimit = checkedMultiply(maximumColumns, hardwareRows, "hardware glyph slots");
  const bytesPerRow = checkedMultiply(GLYPH_ATLAS_WIDTH, cellHeight, "glyph texture row bytes");
  const budgetRows = Math.floor(byteLimit / bytesPerRow);
  const allocatedBudgetRows =
    budgetRows > maximumRows ? Math.floor(budgetRows / maximumRows) * maximumRows : budgetRows;
  const byteSlotLimit = allocatedBudgetRows * maximumColumns;
  const slotLimit = Math.min(hardwareSlotLimit, byteSlotLimit, protocolSlotLimit);
  return Object.freeze({
    maxTextureDimension,
    cellWidth,
    cellHeight,
    bytesPerSlot,
    bytesPerRow,
    byteLimit,
    maximumColumns,
    maximumRows,
    maximumLayers,
    hardwareSlotLimit,
    byteSlotLimit,
    protocolSlotLimit,
    slotLimit,
  });
}

export function planGlyphAtlasGeometry(limits, requestedSlots, options = {}) {
  if (!Number.isSafeInteger(requestedSlots) || requestedSlots < 0) {
    throw new TypeError("requested glyph slots must be a nonnegative safe integer");
  }
  const requiredSlots = Math.max(GLYPH_ATLAS_MIN_SLOTS, requestedSlots);
  if (requiredSlots > limits.slotLimit) {
    const reason = requiredSlots > limits.hardwareSlotLimit ? "hardware" : "byte-budget";
    throw new GlyphAtlasCapacityError(reason, {
      requestedSlots,
      reservedSlots: options.reservedSlots ?? 0,
      slotLimit: limits.slotLimit,
      bytesPerSlot: limits.bytesPerSlot,
      byteLimit: limits.byteLimit,
    });
  }
  const columns = limits.maximumColumns;
  const rows = pageAlignedGlyphAtlasRows(Math.ceil(requiredSlots / columns), limits.maximumRows);
  const initialSlots = Math.max(GLYPH_ATLAS_MIN_SLOTS, Math.ceil(requestedSlots / 4));
  const textureSlots = checkedMultiply(columns, rows, "glyph texture slots");
  return Object.freeze({
    width: GLYPH_ATLAS_WIDTH,
    columns,
    rows,
    rowsPerPage: limits.maximumRows,
    maxLayers: limits.maximumLayers,
    initialRows: pageAlignedGlyphAtlasRows(Math.ceil(initialSlots / columns), limits.maximumRows),
    textureSlots,
    byteLength: checkedMultiply(rows, limits.bytesPerRow, "glyph texture bytes"),
    paddingSlots: textureSlots - requestedSlots,
  });
}

export function pageAlignedGlyphAtlasRows(rows, rowsPerPage) {
  return rows > rowsPerPage ? Math.ceil(rows / rowsPerPage) * rowsPerPage : rows;
}

export function growGlyphAtlasRows(
  currentRows,
  requiredSlots,
  columns,
  maxRows,
  rowsPerPage = Infinity,
) {
  positiveInteger(currentRows, "current glyph rows");
  positiveInteger(requiredSlots, "required glyph slots");
  positiveInteger(columns, "glyph atlas columns");
  positiveInteger(maxRows, "maximum glyph rows");
  const requiredRows = Math.ceil(requiredSlots / columns);
  if (requiredRows > maxRows) throw new RangeError("glyph atlas capacity exceeded");
  if (requiredRows <= currentRows) return currentRows;
  return Math.min(
    maxRows,
    pageAlignedGlyphAtlasRows(Math.max(requiredRows, currentRows * 2), rowsPerPage),
  );
}
