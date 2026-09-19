// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { SUBMISSION_SIZE, FRAME_SIZE } from "./FrameSchema.js";
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

function validateRange(memoryLength, ptr, length, label) {
  if (!Number.isSafeInteger(ptr) || !Number.isSafeInteger(length) || ptr < 0 || length < 0 ||
      ptr > memoryLength || length > memoryLength - ptr) {
    throw new Error(`invalid submission ${label} range`);
  }
}

function validateRecords(memoryLength, ptr, count, size, label) {
  if (!Number.isSafeInteger(count) || count < 0 || count > Math.floor(Number.MAX_SAFE_INTEGER / size)) {
    throw new Error(`invalid submission ${label} count`);
  }
  validateRange(memoryLength, ptr, count * size, label);
}

export function parseRendererSubmission(renderer, terminal, memory, submissionPtr) {
  if (!renderer.initialized) throw new Error("GPU terminal is not initialized");
  if (renderer.activeTerminal !== terminal) throw new Error("invalid renderer terminal");
  const glyphPartition = renderer.glyphPartition(terminal);
  if (!glyphPartition) throw new Error("missing renderer glyph partition");
  const { baseSlot: committedGlyphPartitionBase, slotCapacity: committedGlyphPartitionCapacity,
    generation: committedGlyphPartitionGeneration } = glyphPartition;
  if (!(memory instanceof ArrayBuffer)) throw new Error("invalid renderer memory");
  validateRange(memory.byteLength, submissionPtr, SUBMISSION_SIZE, "header");
  const header = new DataView(memory, submissionPtr, SUBMISSION_SIZE);
  if (header.getUint32(0, true) !== 0x5355424d || header.getUint32(4, true) !== 4 ||
      header.getUint32(8, true) !== SUBMISSION_SIZE || header.getUint32(12, true) !== 0) {
    throw new Error("invalid renderer submission");
  }
  const framePtr = header.getUint32(16, true);
  const frameLen = header.getUint32(20, true);
  const cellsPtr = header.getUint32(24, true);
  const cellsCount = header.getUint32(28, true);
  const dirtyRangesPtr = header.getUint32(32, true);
  const dirtyRangesCount = header.getUint32(36, true);
  const stylesPtr = header.getUint32(40, true);
  const stylesFirst = header.getUint32(44, true);
  const stylesCount = header.getUint32(48, true);
  const selectionsPtr = header.getUint32(52, true);
  const selectionsCount = header.getUint32(56, true);
  const bitmapUploadsPtr = header.getUint32(60, true);
  const bitmapUploadsCount = header.getUint32(64, true);
  const bitmapUploadPixelsPtr = header.getUint32(68, true);
  const bitmapUploadPixelsLen = header.getUint32(72, true);
  const canvasRequestsPtr = header.getUint32(76, true);
  const canvasRequestsCount = header.getUint32(80, true);
  const canvasTextPtr = header.getUint32(84, true);
  const canvasTextLen = header.getUint32(88, true);
  const textRowsPtr = header.getUint32(92, true);
  const textCellsPtr = header.getUint32(96, true);
  const textBytesPtr = header.getUint32(100, true);
  const textBytesLen = header.getUint32(104, true);
  const textChanged = header.getUint32(108, true);
  if (frameLen !== FRAME_SIZE) throw new Error("invalid renderer frame length");
  validateRange(memory.byteLength, framePtr, frameLen, "frame");
  const frame = new DataView(memory, framePtr, frameLen);
  validateRange(memory.byteLength, cellsPtr, cellsCount * renderer.cellSize, "cells");
  const cells = new DataView(memory, cellsPtr, cellsCount * renderer.cellSize);
  for (let index = 0; index < cellsCount; index += 1) {
    const base = index * renderer.cellSize;
    const glyph = cells.getUint32(base, true);
    if (glyph !== 0) {
      const glyphSlot = glyph - 1;
      const meta = cells.getUint32(base + 4, true);
      if (glyphSlot < committedGlyphPartitionBase ||
          glyphSlot >= committedGlyphPartitionBase + committedGlyphPartitionCapacity ||
          ((meta & 0x00010000) !== 0 &&
           glyphSlot + 1 >= committedGlyphPartitionBase + committedGlyphPartitionCapacity)) {
        throw new Error("invalid renderer cell glyph");
      }
    }
  }
  validateRecords(memory.byteLength, dirtyRangesPtr, dirtyRangesCount, 8, "dirty");
  const dirtyRanges = new DataView(memory, dirtyRangesPtr, dirtyRangesCount * 8);
  validateRecords(memory.byteLength, stylesPtr + stylesFirst * renderer.styleSize, stylesCount, renderer.styleSize, "styles");
  validateRecords(memory.byteLength, selectionsPtr, selectionsCount, 4, "selections");
  validateRecords(memory.byteLength, bitmapUploadsPtr, bitmapUploadsCount, 16, "bitmap upload");
  const bitmapUploads = new DataView(memory, bitmapUploadsPtr, bitmapUploadsCount * 16);
  validateRecords(memory.byteLength, canvasRequestsPtr, canvasRequestsCount, 24, "Canvas");
  const canvasRequests = new DataView(memory, canvasRequestsPtr, canvasRequestsCount * 24);
  validateRange(memory.byteLength, bitmapUploadPixelsPtr, bitmapUploadPixelsLen, "bitmap upload pixels");
  const bitmapUploadPixels = new Uint8Array(memory, bitmapUploadPixelsPtr, bitmapUploadPixelsLen);
  validateRange(memory.byteLength, canvasTextPtr, canvasTextLen, "Canvas text");
  validateRange(memory.byteLength, textBytesPtr, textBytesLen, "text bytes");
  if (frame.getUint32(0, true) !== 0x46574342 || frame.getUint32(4, true) !== 4) {
    throw new Error("invalid renderer frame");
  }
  const cols = frame.getUint32(8, true);
  const rows = frame.getUint32(12, true);
  const frameCells = frame.getUint32(16, true);
  if (cellsCount !== frameCells || frameCells !== cols * rows || frameCells > renderer.maxCells) {
    throw new Error(`terminal grid exceeds ${renderer.maxCells} GPU cells`);
  }
  if (selectionsCount !== rows) throw new Error("invalid renderer selections");
  if (stylesFirst + stylesCount > renderer.maxStyles) throw new Error("invalid renderer styles");
  for (let index = 0; index < dirtyRangesCount; index += 1) {
    const firstRow = dirtyRanges.getUint32(index * 8, true);
    const rowCount = dirtyRanges.getUint32(index * 8 + 4, true);
    if (rowCount === 0 || firstRow >= rows || rowCount > rows - firstRow) {
      throw new Error("invalid renderer dirty range");
    }
  }
  if (textChanged) {
    validateRecords(memory.byteLength, textRowsPtr, rows, 32, "text rows");
    validateRecords(memory.byteLength, textCellsPtr, cellsCount, 4, "text cells");
  }
  const viewportModeValue = frame.getUint32(60, true);
  if (viewportModeValue > 2) throw new Error("invalid renderer viewport mode");
  const glyphPartitionBase = frame.getUint32(64, true);
  const glyphPartitionCapacity = frame.getUint32(68, true);
  const glyphPartitionGeneration = frame.getUint32(72, true);
  const glyphSlotsUsed = frame.getUint32(76, true);
  if (glyphPartitionBase !== committedGlyphPartitionBase ||
      glyphPartitionCapacity !== committedGlyphPartitionCapacity ||
      glyphPartitionGeneration !== committedGlyphPartitionGeneration ||
      glyphSlotsUsed > glyphPartitionCapacity) {
    throw new Error("invalid renderer glyph partition");
  }
  for (let index = 0; index < bitmapUploadsCount; index += 1) {
    const base = index * 16;
    const firstSlot = bitmapUploads.getUint32(base, true);
    const slotCount = bitmapUploads.getUint32(base + 4, true);
    const pixelOffset = bitmapUploads.getUint32(base + 8, true);
    const bytesPerRow = bitmapUploads.getUint32(base + 12, true);
    const width = slotCount * renderer.atlas.tileWidth;
    const byteLength = bytesPerRow * renderer.atlas.tileHeight;
    if (slotCount === 0 ||
        firstSlot < glyphPartitionBase ||
        slotCount > glyphPartitionBase + glyphSlotsUsed - firstSlot ||
        slotCount > renderer.atlas.columns - (firstSlot % renderer.atlas.columns) ||
        bytesPerRow !== width || pixelOffset > bitmapUploadPixelsLen ||
        byteLength > bitmapUploadPixelsLen - pixelOffset) {
      throw new Error("invalid renderer bitmap upload");
    }
  }
  for (let index = 0; index < canvasRequestsCount; index += 1) {
    const base = index * 24;
    const slot = canvasRequests.getUint32(base, true);
    const slotCount = canvasRequests.getUint32(base + 4, true);
    const spanCells = canvasRequests.getUint32(base + 8, true);
    const offset = canvasRequests.getUint32(base + 12, true);
    const length = canvasRequests.getUint32(base + 16, true);
    if (slot < glyphPartitionBase || slotCount === 0 ||
        slotCount > glyphPartitionBase + glyphSlotsUsed - slot ||
        slotCount !== spanCells || spanCells === 0 ||
        offset > canvasTextLen || length > canvasTextLen - offset) {
      throw new Error("invalid renderer Canvas request");
    }
  }
  return {
    memory,
    cellsPtr,
    dirtyRangesPtr,
    dirtyRangesCount,
    dirtyRanges,
    stylesPtr,
    stylesFirst,
    stylesCount,
    selectionsPtr,
    bitmapUploads,
    bitmapUploadsCount,
    bitmapUploadPixels,
    canvasRequests,
    canvasRequestsCount,
    canvasTextPtr,
    textRowsPtr,
    textCellsPtr,
    textBytesPtr,
    textBytesLen,
    textChanged: textChanged !== 0,
    cols,
    rows,
    frameCells,
    cacheHits: frame.getUint32(20, true) >>> 16,
    cacheMisses: frame.getUint32(20, true) & 0xffff,
    background: frame.getUint32(24, true),
    foreground: frame.getUint32(28, true),
    cursorX: frame.getUint32(32, true),
    cursorY: frame.getUint32(36, true),
    cursorFlags: frame.getUint32(40, true),
    cursorStyle: frame.getUint32(44, true),
    scrollTotal: frame.getUint32(48, true),
    scrollOffset: frame.getUint32(52, true),
    scrollLength: frame.getUint32(56, true),
    viewportMode: ["active", "top", "pinned"][viewportModeValue],
    glyphPartitionBase,
    glyphPartitionCapacity,
    glyphPartitionGeneration,
    glyphSlotsUsed,
  };
}

export function decodeCanvasRequestText(submission, index) {
  const base = index * 24;
  const offset = submission.canvasRequests.getUint32(base + 12, true);
  const length = submission.canvasRequests.getUint32(base + 16, true);
  try {
    return strictDecoder.decode(new Uint8Array(submission.memory, submission.canvasTextPtr + offset, length));
  } catch {
    throw new Error("invalid renderer Canvas UTF-8");
  }
}

export function applyRendererSubmission(renderer, submission) {
  renderer.cols = submission.cols;
  renderer.rows = submission.rows;
  renderer.cacheHits = submission.cacheHits;
  renderer.cacheMisses = submission.cacheMisses;
  renderer.background = submission.background;
  renderer.foreground = submission.foreground;
  renderer.cursorX = submission.cursorX;
  renderer.cursorY = submission.cursorY;
  renderer.cursorFlags = submission.cursorFlags;
  renderer.cursorStyle = submission.cursorStyle;
  Object.assign(renderer.submissionMetadata, {
    cols: submission.cols,
    rows: submission.rows,
    viewportMode: submission.viewportMode,
    scrollTotal: submission.scrollTotal,
    scrollOffset: submission.scrollOffset,
    scrollLength: submission.scrollLength,
    textRowsPtr: submission.textRowsPtr,
    textCellsPtr: submission.textCellsPtr,
    textBytesPtr: submission.textBytesPtr,
    textBytesLen: submission.textBytesLen,
    textChanged: submission.textChanged,
  });
  renderer.submissionMemory = submission.memory;
  renderer.submissionCellsPtr = submission.cellsPtr;
  renderer.submissionDirtyRangesPtr = submission.dirtyRangesPtr;
  renderer.submissionDirtyRangesCount = submission.dirtyRangesCount;
  renderer.submissionStylesPtr = submission.stylesPtr;
  renderer.submissionStylesFirst = submission.stylesFirst;
  renderer.submissionStylesCount = submission.stylesCount;
  renderer.submissionSelectionsPtr = submission.selectionsPtr;
  renderer.submissionCanvasRequestsPtr = submission.canvasRequests.byteOffset;
  renderer.submissionCanvasRequestsCount = submission.canvasRequestsCount;
  return renderer.submissionMetadata;
}
