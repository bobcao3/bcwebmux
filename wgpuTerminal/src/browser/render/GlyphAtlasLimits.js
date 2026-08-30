// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

export const ABSOLUTE_GLYPH_CACHE_MAX_BYTES = 256 * 1024 * 1024;
export const GLYPH_SLOT_PROTOCOL_LIMIT = 0xfffffffe;
export const TERMINAL_CELL_PROTOCOL_LIMIT = 0xffff;

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`);
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
  const maxTextureDimension = positiveInteger(options.maxTextureDimension, "maximum texture dimension");
  const cellWidth = positiveInteger(options.cellWidth, "glyph cell width");
  const cellHeight = positiveInteger(options.cellHeight, "glyph cell height");
  const protocolSlotLimit = positiveInteger(
    options.protocolSlotLimit ?? GLYPH_SLOT_PROTOCOL_LIMIT,
    "glyph slot protocol limit",
  );
  const configuredMaxBytes = normalizeByteLimit(
    options.configuredMaxBytes,
    ABSOLUTE_GLYPH_CACHE_MAX_BYTES,
    "glyph cache byte limit",
  );
  const byteLimit = configuredMaxBytes;
  const bytesPerSlot = checkedMultiply(cellWidth, cellHeight, "glyph slot bytes");
  const maximumColumns = Math.floor(maxTextureDimension / cellWidth);
  const maximumRows = Math.floor(maxTextureDimension / cellHeight);
  if (maximumColumns < 1 || maximumRows < 1) {
    throw new GlyphAtlasCapacityError("hardware", {
      requestedSlots: 1,
      reservedSlots: 0,
      slotLimit: 0,
      bytesPerSlot,
      byteLimit,
    });
  }
  const hardwareSlotLimit = checkedMultiply(maximumColumns, maximumRows, "hardware glyph slots");
  const byteSlotLimit = Math.floor(byteLimit / bytesPerSlot);
  const slotLimit = Math.min(hardwareSlotLimit, byteSlotLimit, protocolSlotLimit);
  return Object.freeze({
    maxTextureDimension,
    cellWidth,
    cellHeight,
    bytesPerSlot,
    byteLimit,
    maximumColumns,
    maximumRows,
    hardwareSlotLimit,
    byteSlotLimit,
    protocolSlotLimit,
    slotLimit,
  });
}

function geometryForColumns(limits, requiredSlots, columns) {
  if (columns < 1 || columns > limits.maximumColumns) return null;
  const rows = Math.max(1, Math.ceil(requiredSlots / columns));
  if (rows > limits.maximumRows) return null;
  const textureSlots = checkedMultiply(columns, rows, "glyph texture slots");
  const byteLength = checkedMultiply(textureSlots, limits.bytesPerSlot, "glyph texture bytes");
  if (byteLength > limits.byteLimit) return null;
  return { columns, rows, textureSlots, byteLength, paddingSlots: textureSlots - requiredSlots };
}

export function planGlyphAtlasGeometry(limits, requestedSlots, options = {}) {
  if (!Number.isSafeInteger(requestedSlots) || requestedSlots < 0) {
    throw new TypeError("requested glyph slots must be a nonnegative safe integer");
  }
  const requiredSlots = Math.max(1, requestedSlots);
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
  const preferredColumns = Math.min(
    limits.maximumColumns,
    positiveInteger(options.preferredColumns ?? Math.min(requiredSlots, limits.maximumColumns), "preferred atlas columns"),
  );
  const preferred = geometryForColumns(limits, requiredSlots, preferredColumns);
  if (preferred) return Object.freeze(preferred);
  for (let columns = 1; columns <= limits.maximumColumns; columns += 1) {
    const candidate = geometryForColumns(limits, requiredSlots, columns);
    if (!candidate) continue;
    return Object.freeze(candidate);
  }
  throw new GlyphAtlasCapacityError("hardware", {
    requestedSlots,
    reservedSlots: options.reservedSlots ?? 0,
    slotLimit: limits.slotLimit,
    bytesPerSlot: limits.bytesPerSlot,
    byteLimit: limits.byteLimit,
  });
}
