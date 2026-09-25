// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import {
  SUBMISSION_SIZE,
  FRAME_SIZE,
  CANVAS_REQUEST_SIZE,
  CANVAS_TEXT_UNIT_SIZE,
  MAX_RUN_TEXT_BYTES,
  MAX_RUN_CODEPOINTS,
  MAX_RUN_PIXELS,
} from "./browser/render/FrameSchema.js";
const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function validateRange(memoryLength, ptr, length, label) {
  if (
    !Number.isSafeInteger(ptr) ||
    !Number.isSafeInteger(length) ||
    ptr < 0 ||
    length < 0 ||
    ptr > memoryLength ||
    length > memoryLength - ptr
  ) {
    throw new Error(`invalid submission ${label} range`);
  }
}

function validateRecords(memoryLength, ptr, count, size, label) {
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > Math.floor(Number.MAX_SAFE_INTEGER / size)
  ) {
    throw new Error(`invalid submission ${label} count`);
  }
  validateRange(memoryLength, ptr, count * size, label);
}

export function decodeCanvasText(bytes, offset, length) {
  if (
    !(bytes instanceof Uint8Array) ||
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 1 ||
    length > MAX_RUN_TEXT_BYTES ||
    offset > bytes.byteLength ||
    length > bytes.byteLength - offset
  ) {
    throw new Error("invalid renderer Canvas text range");
  }
  let text;
  try {
    text = strictDecoder.decode(bytes.subarray(offset, offset + length));
  } catch {
    throw new Error("invalid renderer Canvas UTF-8");
  }
  if ([...text].length > MAX_RUN_CODEPOINTS) throw new Error("invalid renderer Canvas text count");
  return text;
}

export function parseFramePacket(memory, submissionPtr, expectations) {
  const { partition, abi, coreGeneration, configGeneration, token } = expectations;
  if (
    abi !== 7 ||
    expectations.cellSize !== 8 ||
    expectations.styleSize !== 12 ||
    expectations.frameSize !== FRAME_SIZE ||
    expectations.packetSize !== SUBMISSION_SIZE
  ) {
    throw new Error("invalid frame schema expectations");
  }
  for (const value of [
    coreGeneration,
    configGeneration,
    token,
    expectations.maxCells,
    expectations.maxStyles,
    partition?.baseSlot,
    partition?.slotCapacity,
    partition?.generation,
    expectations.atlas?.columns,
    expectations.atlas?.tileWidth,
    expectations.atlas?.tileHeight,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff)
      throw new Error("invalid frame expectations");
  }
  if (
    !token ||
    !coreGeneration ||
    !partition.slotCapacity ||
    !expectations.atlas.columns ||
    !expectations.maxCells ||
    !expectations.maxStyles ||
    !expectations.atlas.tileWidth ||
    !expectations.atlas.tileHeight ||
    partition.baseSlot + partition.slotCapacity > 0xffffffff
  ) {
    throw new Error("invalid frame capacities");
  }
  const {
    baseSlot: committedGlyphPartitionBase,
    slotCapacity: committedGlyphPartitionCapacity,
    generation: committedGlyphPartitionGeneration,
  } = partition;
  if (!(memory instanceof ArrayBuffer)) throw new Error("invalid renderer memory");
  validateRange(memory.byteLength, submissionPtr, SUBMISSION_SIZE, "header");
  const header = new DataView(memory, submissionPtr, SUBMISSION_SIZE);
  if (
    header.getUint32(0, true) !== 0x5355424d ||
    header.getUint32(4, true) !== 7 ||
    header.getUint32(8, true) !== SUBMISSION_SIZE ||
    header.getUint32(12, true) !== CANVAS_TEXT_UNIT_SIZE
  ) {
    throw new Error("invalid renderer submission");
  }
  if (
    header.getUint32(112, true) !== token ||
    header.getUint32(116, true) !== coreGeneration ||
    header.getUint32(120, true) !== configGeneration ||
    header.getUint32(124, true) !== partition.generation ||
    header.getUint32(128, true) > 1 ||
    header.getUint32(132, true) !== token
  ) {
    throw new Error("invalid frame identity");
  }
  const graphicsRevision = header.getUint32(136, true);
  const drawsPtr = header.getUint32(140, true);
  const drawsCount = header.getUint32(144, true);
  const resourcesPtr = header.getUint32(148, true);
  const resourcesCount = header.getUint32(152, true);
  if (drawsCount > 2048 || resourcesCount > 512 || drawsPtr % 4 || resourcesPtr % 4) {
    throw new Error("invalid graphics stream size");
  }
  validateRecords(memory.byteLength, drawsPtr, drawsCount, 48, "graphics draws");
  validateRecords(memory.byteLength, resourcesPtr, resourcesCount, 44, "graphics resources");
  const graphicsDraws = new DataView(memory, drawsPtr, drawsCount * 48);
  const graphicsResources = new DataView(memory, resourcesPtr, resourcesCount * 44);
  const graphicsBytes = [];
  let sourceBytes = 0;
  for (let i = 0; i < resourcesCount; i++) {
    const o = i * 44;
    const width = graphicsResources.getUint32(o + 16, true);
    const height = graphicsResources.getUint32(o + 20, true);
    const format = graphicsResources.getUint32(o + 24, true);
    const compression = graphicsResources.getUint32(o + 28, true);
    const length = graphicsResources.getUint32(o + 40, true);
    const pixels = width * height;
    if (
      graphicsResources.getUint32(o, true) > 1 ||
      !graphicsResources.getUint32(o + 4, true) ||
      !width ||
      !height ||
      width > 4096 ||
      height > 4096 ||
      pixels * 4 > 16 * 1024 * 1024 ||
      ![24, 32, 100].includes(format) ||
      compression > 1 ||
      graphicsResources.getUint32(o + 32, true) > 32 * 1024 * 1024 ||
      !length ||
      length > 8 * 1024 * 1024 ||
      (format !== 100 && compression === 0 && length !== pixels * (format === 24 ? 3 : 4))
    ) {
      throw new Error("invalid graphics resource");
    }
    sourceBytes += length;
    if (sourceBytes > 32 * 1024 * 1024) throw new Error("graphics source budget exceeded");
    const ptr = graphicsResources.getUint32(o + 36, true);
    validateRange(memory.byteLength, ptr, length, "graphics source");
    graphicsBytes.push(new Uint8Array(memory, ptr, length));
  }
  for (let i = 0; i < drawsCount; i++) {
    const o = i * 48;
    const index = graphicsDraws.getUint32(o, true);
    if (index >= resourcesCount) throw new Error("invalid graphics draw resource");
    const r = index * 44;
    const width = graphicsDraws.getUint32(o + 16, true);
    const height = graphicsDraws.getUint32(o + 20, true);
    const x = graphicsDraws.getUint32(o + 24, true);
    const y = graphicsDraws.getUint32(o + 28, true);
    const sw = graphicsDraws.getUint32(o + 32, true);
    const sh = graphicsDraws.getUint32(o + 36, true);
    if (
      !width ||
      !height ||
      width > 0xffffff ||
      height > 0xffffff ||
      width * height > 16 * 1024 * 1024 ||
      !sw ||
      !sh ||
      x > graphicsResources.getUint32(r + 16, true) ||
      sw > graphicsResources.getUint32(r + 16, true) - x ||
      y > graphicsResources.getUint32(r + 20, true) ||
      sh > graphicsResources.getUint32(r + 20, true) - y ||
      graphicsDraws.getUint32(o + 40, true) > 65535 ||
      graphicsDraws.getUint32(o + 44, true) > 65535
    ) {
      throw new Error("invalid graphics draw geometry");
    }
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
  if (textChanged > 1) throw new Error("invalid text changed flag");
  if (frameLen !== FRAME_SIZE) throw new Error("invalid renderer frame length");
  validateRange(memory.byteLength, framePtr, frameLen, "frame");
  const frame = new DataView(memory, framePtr, frameLen);
  const usedSlots = frame.getUint32(76, true);
  validateRange(memory.byteLength, cellsPtr, cellsCount * expectations.cellSize, "cells");
  const cells = new DataView(memory, cellsPtr, cellsCount * expectations.cellSize);
  for (let index = 0; index < cellsCount; index += 1) {
    const base = index * expectations.cellSize;
    const glyph = cells.getUint32(base, true);
    if (glyph !== 0) {
      const glyphSlot = glyph - 1;
      const meta = cells.getUint32(base + 4, true);
      if (
        glyphSlot < committedGlyphPartitionBase ||
        glyphSlot >= committedGlyphPartitionBase + usedSlots ||
        ((meta & 0x00010000) !== 0 && glyphSlot + 1 >= committedGlyphPartitionBase + usedSlots)
      ) {
        throw new Error("invalid renderer cell glyph");
      }
    }
  }
  validateRecords(memory.byteLength, dirtyRangesPtr, dirtyRangesCount, 8, "dirty");
  const dirtyRanges = new DataView(memory, dirtyRangesPtr, dirtyRangesCount * 8);
  validateRecords(
    memory.byteLength,
    stylesPtr + stylesFirst * expectations.styleSize,
    stylesCount,
    expectations.styleSize,
    "styles",
  );
  validateRecords(memory.byteLength, selectionsPtr, selectionsCount, 4, "selections");
  validateRecords(memory.byteLength, bitmapUploadsPtr, bitmapUploadsCount, 16, "bitmap upload");
  const bitmapUploads = new DataView(memory, bitmapUploadsPtr, bitmapUploadsCount * 16);
  if (canvasRequestsCount > expectations.maxCells)
    throw new Error("invalid renderer Canvas request count");
  validateRecords(
    memory.byteLength,
    canvasRequestsPtr,
    canvasRequestsCount,
    CANVAS_REQUEST_SIZE,
    "Canvas",
  );
  const canvasRequests = new DataView(
    memory,
    canvasRequestsPtr,
    canvasRequestsCount * CANVAS_REQUEST_SIZE,
  );
  validateRange(
    memory.byteLength,
    bitmapUploadPixelsPtr,
    bitmapUploadPixelsLen,
    "bitmap upload pixels",
  );
  const bitmapUploadPixels = new Uint8Array(memory, bitmapUploadPixelsPtr, bitmapUploadPixelsLen);
  if (canvasTextLen > canvasRequestsCount * MAX_RUN_TEXT_BYTES)
    throw new Error("invalid renderer Canvas text count");
  validateRecords(
    memory.byteLength,
    canvasTextPtr,
    canvasTextLen,
    CANVAS_TEXT_UNIT_SIZE,
    "Canvas text",
  );
  const canvasText = new Uint8Array(memory, canvasTextPtr, canvasTextLen);
  validateRange(memory.byteLength, textBytesPtr, textBytesLen, "text bytes");
  if (frame.getUint32(0, true) !== 0x46574342 || frame.getUint32(4, true) !== 7) {
    throw new Error("invalid renderer frame");
  }
  const cols = frame.getUint32(8, true);
  const rows = frame.getUint32(12, true);
  const frameCells = frame.getUint32(16, true);
  if (
    !cols ||
    !rows ||
    cellsCount !== frameCells ||
    frameCells !== cols * rows ||
    frameCells > expectations.maxCells
  ) {
    throw new Error(`terminal grid exceeds ${expectations.maxCells} GPU cells`);
  }
  if (selectionsCount !== rows) throw new Error("invalid renderer selections");
  if (stylesFirst + stylesCount > expectations.maxStyles)
    throw new Error("invalid renderer styles");
  let dirtyEnd = 0;
  for (let index = 0; index < dirtyRangesCount; index += 1) {
    const firstRow = dirtyRanges.getUint32(index * 8, true);
    const rowCount = dirtyRanges.getUint32(index * 8 + 4, true);
    if (firstRow < dirtyEnd || rowCount === 0 || firstRow >= rows || rowCount > rows - firstRow) {
      throw new Error("invalid renderer dirty range");
    }
    dirtyEnd = firstRow + rowCount;
  }
  if (
    header.getUint32(128, true) === 1 &&
    (dirtyRangesCount !== 1 || dirtyRanges.getUint32(0, true) !== 0 || dirtyEnd !== rows)
  ) {
    throw new Error("incomplete full frame");
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
  if (
    glyphPartitionBase !== committedGlyphPartitionBase ||
    glyphPartitionCapacity !== committedGlyphPartitionCapacity ||
    glyphPartitionGeneration !== committedGlyphPartitionGeneration ||
    glyphSlotsUsed > glyphPartitionCapacity
  ) {
    throw new Error("invalid renderer glyph partition");
  }
  for (let index = 0; index < bitmapUploadsCount; index += 1) {
    const base = index * 16;
    const firstSlot = bitmapUploads.getUint32(base, true);
    const slotCount = bitmapUploads.getUint32(base + 4, true);
    const pixelOffset = bitmapUploads.getUint32(base + 8, true);
    const bytesPerRow = bitmapUploads.getUint32(base + 12, true);
    const width = slotCount * expectations.atlas.tileWidth;
    const byteLength = bytesPerRow * expectations.atlas.tileHeight;
    if (
      slotCount === 0 ||
      firstSlot < glyphPartitionBase ||
      slotCount > glyphPartitionBase + glyphSlotsUsed - firstSlot ||
      slotCount > expectations.atlas.columns - (firstSlot % expectations.atlas.columns) ||
      bytesPerRow !== width ||
      pixelOffset > bitmapUploadPixelsLen ||
      byteLength > bitmapUploadPixelsLen - pixelOffset
    ) {
      throw new Error("invalid renderer bitmap upload");
    }
  }
  let canvasTextOffset = 0;
  for (let index = 0; index < canvasRequestsCount; index += 1) {
    const base = index * CANVAS_REQUEST_SIZE;
    const slot = canvasRequests.getUint32(base, true);
    const slotCount = canvasRequests.getUint32(base + 4, true);
    const spanCells = canvasRequests.getUint32(base + 8, true);
    const offset = canvasRequests.getUint32(base + 12, true);
    const length = canvasRequests.getUint32(base + 16, true);
    if (
      canvasRequests.getUint32(base + 20, true) > 3 ||
      slot < glyphPartitionBase ||
      slotCount === 0 ||
      slotCount > glyphPartitionBase + glyphSlotsUsed - slot ||
      spanCells < 1 ||
      spanCells > 16 ||
      spanCells * expectations.atlas.tileWidth * expectations.atlas.tileHeight > MAX_RUN_PIXELS ||
      slotCount !== spanCells ||
      length > MAX_RUN_TEXT_BYTES ||
      offset !== canvasTextOffset ||
      offset > canvasTextLen ||
      length > canvasTextLen - offset
    ) {
      throw new Error("invalid renderer Canvas request");
    }
    decodeCanvasText(canvasText, offset, length);
    canvasTextOffset = offset + length;
  }
  if (canvasTextOffset !== canvasTextLen) throw new Error("incomplete renderer Canvas text");
  for (const ptr of [cellsPtr, stylesPtr, selectionsPtr]) {
    if (ptr % 4) throw new Error("unaligned frame stream");
  }
  const styleData = new DataView(
    memory,
    stylesPtr + stylesFirst * expectations.styleSize,
    stylesCount * expectations.styleSize,
  );
  for (let i = 0; i < stylesCount; i++) {
    if (
      styleData.getUint32(i * 12, true) > 0xffffff ||
      styleData.getUint32(i * 12 + 4, true) > 0xffffff ||
      (styleData.getUint32(i * 12 + 8, true) & ~0x1bf) !== 0
    ) {
      throw new Error("invalid frame style");
    }
  }
  const selectionData = new DataView(memory, selectionsPtr, rows * 4);
  for (let y = 0; y < rows; y++) {
    const value = selectionData.getUint32(y * 4, true);
    const start = value & 0xffff;
    const end = (value >>> 16) & 0x7fff;
    if (value !== 0 && (!(value & 0x80000000) || start > end || end >= cols)) {
      throw new Error("invalid frame selection");
    }
  }
  if (
    frame.getUint32(24, true) > 0xffffff ||
    frame.getUint32(28, true) > 0xffffff ||
    frame.getUint32(52, true) + frame.getUint32(56, true) > frame.getUint32(48, true)
  ) {
    throw new Error("invalid frame metadata");
  }
  if (
    frame.getUint32(40, true) > 7 ||
    frame.getUint32(44, true) > 3 ||
    (frame.getUint32(32, true) >= cols && frame.getUint32(32, true) !== 0xffff) ||
    (frame.getUint32(36, true) >= rows && frame.getUint32(36, true) !== 0xffff)
  ) {
    throw new Error("invalid frame cursor");
  }
  for (let index = 0; index < cellsCount; index++) {
    const meta = cells.getUint32(index * 8 + 4, true);
    if ((meta & 0xfffc0000) !== 0 || (meta & 0xffff) >= stylesFirst + stylesCount) {
      throw new Error("invalid frame cell style");
    }
  }
  const textRows = new DataView(memory, textRowsPtr, textChanged ? rows * 32 : 0);
  const textCells = new DataView(memory, textCellsPtr, textChanged ? cellsCount * 4 : 0);
  const textBytes = new Uint8Array(memory, textBytesPtr, textBytesLen);
  if (textChanged) {
    for (let y = 0; y < rows; y++) {
      const offset = textRows.getUint32(y * 32, true);
      const length = textRows.getUint32(y * 32 + 4, true);
      validateRange(textBytesLen, offset, length, "text row");
      if (textRows.getUint32(y * 32 + 20, true) > 1) throw new Error("invalid text row flags");
      const text = strictDecoder.decode(textBytes.subarray(offset, offset + length));
      let utf16Length = 0;
      for (let x = 0; x < cols; x++) utf16Length += textCells.getUint16((y * cols + x) * 4, true);
      if (text.length !== utf16Length) throw new Error("invalid text cell lengths");
    }
    for (let i = 0; i < cellsCount; i++) {
      const length = textCells.getUint16(i * 4, true);
      const width = textCells.getUint8(i * 4 + 2);
      if (width > 2 || textCells.getUint8(i * 4 + 3) > 1 || (width === 0) !== (length === 0)) {
        throw new Error("invalid text cell");
      }
    }
  }
  return {
    token,
    coreGeneration,
    configGeneration,
    leaseGeneration: partition.generation,
    fullFrame: header.getUint32(128, true) === 1,
    revision: header.getUint32(132, true),
    graphicsRevision,
    graphicsDraws,
    graphicsResources,
    graphicsBytes,
    cells: new Uint8Array(memory, cellsPtr, cellsCount * expectations.cellSize),
    dirtyRangesCount,
    dirtyRanges,
    styles: new Uint32Array(
      memory,
      stylesPtr + stylesFirst * expectations.styleSize,
      stylesCount * 3,
    ),
    styleBytes: new Uint8Array(
      memory,
      stylesPtr + stylesFirst * expectations.styleSize,
      stylesCount * expectations.styleSize,
    ),
    stylesFirst,
    stylesCount,
    selections: new Uint32Array(memory, selectionsPtr, selectionsCount),
    selectionBytes: new Uint8Array(memory, selectionsPtr, selectionsCount * 4),
    bitmapUploads,
    bitmapUploadsCount,
    bitmapUploadPixels,
    canvasRequests,
    canvasRequestsCount,
    canvasText,
    canvasTextLen,
    textRows,
    textCells,
    textBytes,
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
