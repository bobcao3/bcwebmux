// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const VIEWPORT_MODES = new Set(["active", "top", "pinned"]);

function rowValue(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid terminal ${name}`);
  }
  return value;
}

/** A row-based, read-only projection of Ghostty's semantic viewport. */
export class RowAdjustment {
  constructor() {
    this.mode = "active";
    this.value = 0;
    this.upper = 0;
    this.pageSize = 0;
  }

  get maximum() {
    return Math.max(0, this.upper - this.pageSize);
  }

  applyFrame(metadata) {
    const mode = metadata?.viewportMode;
    if (!VIEWPORT_MODES.has(mode)) throw new Error("invalid terminal viewport mode");
    const upper = rowValue(metadata.scrollTotal, "scroll total");
    const pageSize = rowValue(metadata.scrollLength, "scroll length");
    const value = rowValue(metadata.scrollOffset, "scroll offset");
    if (pageSize > upper) throw new Error("terminal scroll length exceeds total");
    const maximum = upper - pageSize;
    if (value > maximum) throw new Error("terminal scroll offset exceeds maximum");
    if (mode === "active" && value !== maximum) {
      throw new Error("active terminal viewport is not at semantic bottom");
    }
    if (mode === "top" && value !== 0) {
      throw new Error("top terminal viewport has a nonzero offset");
    }
    this.mode = mode;
    this.value = value;
    this.upper = upper;
    this.pageSize = pageSize;
    return this;
  }
}
