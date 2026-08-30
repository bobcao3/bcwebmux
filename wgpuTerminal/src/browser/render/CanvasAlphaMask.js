// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

export function extractCanvasAlpha(context, x, y, width, height, storage) {
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount <= 0) {
    throw new RangeError("invalid Canvas glyph mask dimensions");
  }
  const target = storage?.byteLength >= pixelCount ? storage : new Uint8Array(pixelCount);
  const rgba = context.getImageData(x, y, width, height).data;
  if (rgba.byteLength !== pixelCount * 4) throw new Error("invalid Canvas glyph raster");
  for (let index = 0; index < pixelCount; index += 1) target[index] = rgba[index * 4 + 3];
  return { storage: target, pixels: target.subarray(0, pixelCount) };
}
