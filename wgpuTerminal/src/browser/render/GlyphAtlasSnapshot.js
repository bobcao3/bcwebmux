// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

export function glyphAtlasSnapshotLayout(atlas, color = false) {
  const { columns, tileWidth, tileHeight } = atlas;
  const rows = color ? atlas.colorRows : atlas.rows;
  const width = atlas.width ?? columns * tileWidth;
  const height = rows * tileHeight;
  // Debug readback also needs an RGBA display copy; don't multiply the full cache budget.
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > 16 * 1024 * 1024
  ) {
    throw new Error("Glyph texture preview exceeds the 16 Mi-pixel debug limit");
  }
  return {
    width,
    height,
    columns,
    rows,
    tileWidth,
    tileHeight,
    format: color ? "rgba8unorm" : "r8unorm",
  };
}
