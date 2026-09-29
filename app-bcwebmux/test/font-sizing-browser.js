// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { CanvasGlyphRasterizer } from "../../wgpuTerminal/src/browser/render/CanvasAlphaMask.js";
import { loadTerminalFonts } from "../../wgpuTerminal/src/TerminalOptions.js";

const ascii = Array.from({ length: 95 }, (_, index) => String.fromCharCode(index + 32)).join("");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function inkBounds(pixels, width, height, channels = 1) {
  let left = width,
    top = height,
    right = -1,
    bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * channels + channels - 1] === 0) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  assert(right >= left && bottom >= top, "The real Canvas rasterizer must produce glyph ink");
  return { width: right - left + 1, height: bottom - top + 1 };
}

export async function run() {
  const base = "/app-bcwebmux/zig-out/web/fonts/JetBrainsMonoNerdFontMono-";
  for (const [suffix, weight, style] of [
    ["Regular", "400", "normal"],
    ["Bold", "700", "normal"],
    ["Italic", "400", "italic"],
    ["BoldItalic", "700", "italic"],
  ]) {
    document.fonts.add(
      await new FontFace("Sizing Latin", `url("${base}${suffix}.ttf")`, { weight, style }).load(),
    );
  }
  const cjk = new FontFace("Sizing CJK", 'local("Noto Sans Mono CJK SC")');
  document.fonts.add(await cjk.load());
  document.fonts.add(
    await new FontFace(
      "Sizing Emoji",
      'url("/app-bcwebmux/zig-out/web/fonts/NotoEmoji-Regular.woff2")',
    ).load(),
  );
  await document.fonts.ready;
  const context = document.createElement("canvas").getContext("2d");
  const rasterizer = new CanvasGlyphRasterizer();
  const observations = [];
  let cases = 0;
  const raster = (text, family, fallback, size, style, cellWidth, span = 2) => {
    const font = { cssFamily: family, fallbacks: [fallback], ligatures: true, size };
    const atlas = {
      columns: 4,
      rows: 1,
      tileWidth: cellWidth,
      tileHeight: size * 2,
      fontSize: size,
    };
    const encoded = new TextEncoder().encode(text);
    let pixels;
    rasterizer.rasterize(
      0,
      span,
      span,
      encoded,
      0,
      encoded.length,
      style,
      atlas,
      font,
      (firstSlot, slotCount, mask, offset, stride) => {
        assert(
          firstSlot === 0 && slotCount === span && stride === span * cellWidth,
          "Unexpected Canvas upload layout",
        );
        pixels = mask.slice(offset, offset + span * cellWidth * size * 2);
      },
    );
    assert(pixels, "Canvas rasterizer must invoke its upload callback");
    return pixels;
  };
  for (const size of [24, 48]) {
    context.font = `${size}px "Sizing Latin"`;
    const cellWidth = Math.ceil(context.measureText("M").width);
    for (const family of ["Sizing Latin", "Sizing CJK"]) {
      const fallback = family === "Sizing Latin" ? "Sizing CJK" : "Sizing Latin";
      const widths =
        family === "Sizing CJK" ? [cellWidth] : [cellWidth, Math.max(1, Math.floor(cellWidth / 2))];
      for (const width of widths)
        for (let style = 0; style < 4; style++) {
          context.font = `${style & 1 ? "bold " : ""}${style & 2 ? "italic " : ""}${size}px "Sizing CJK"`;
          const water = context.measureText("水");
          const waterInk = water.actualBoundingBoxLeft + water.actualBoundingBoxRight;
          let target;
          if (family === "Sizing CJK") {
            context.font = `${size}px "Sizing CJK"`;
            target = context.measureText("水").width;
          } else {
            context.font = `${size}px "Sizing Latin"`;
            const asciiMetrics = context.measureText(ascii);
            target = Math.min(
              asciiMetrics.actualBoundingBoxAscent + asciiMetrics.actualBoundingBoxDescent,
              2 * width,
            );
          }
          const before = raster("M", family, fallback, size, 0, width, 1);
          await Promise.all(
            loadTerminalFonts({ cssFamily: family, fallbacks: [fallback], ligatures: true, size }),
          );
          const pixels = raster("水", family, fallback, size, style, width);
          const bounds = inkBounds(pixels, 2 * width, size * 2);
          const inferredAdvance = (bounds.width * water.width) / waterInk;
          const inferredVerticalAdvance =
            (bounds.height * water.width) /
            (water.actualBoundingBoxAscent + water.actualBoundingBoxDescent);
          const aspect = bounds.width / bounds.height;
          const expectedAspect =
            waterInk / (water.actualBoundingBoxAscent + water.actualBoundingBoxDescent);
          assert(
            Math.abs(inferredVerticalAdvance - target) <= 2.001,
            `CJK vertical scaling mismatch: ${JSON.stringify({ size, family, width, style, target, inferredVerticalAdvance, actualFont: rasterizer.runContext.font })}`,
          );
          if (!(style & 2)) {
            assert(
              Math.abs(inferredAdvance - target) <= 2.001,
              `CJK advance mismatch: ${JSON.stringify({ size, family, width, style, target, inferredAdvance })}`,
            );
            assert(
              Math.abs(aspect - expectedAspect) <= 0.15,
              `CJK ink aspect mismatch: ${JSON.stringify({ size, family, width, style, aspect, expectedAspect })}`,
            );
          }
          const after = raster("M", family, fallback, size, 0, width, 1);
          assert(
            before.length === after.length &&
              before.every((value, index) => value === after[index]),
            "ASCII raster changed after CJK rendering",
          );
          cases++;
          if (style === 0)
            observations.push({ size, family, width, target, inferredAdvance, bounds });
        }
    }
  }
  for (const text of ["😀", "🈲", "㊗️"]) {
    context.canvas.width = 32;
    context.canvas.height = 144;
    context.font = '48px "Sizing Latin", "Sizing Emoji"';
    context.fontKerning = "normal";
    context.textRendering = "optimizeLegibility";
    context.fillText(text, 0, 80, 32);
    const reference = inkBounds(context.getImageData(0, 0, 32, 144).data, 32, 144, 4);
    const pixels = raster(text, "Sizing Latin", "Sizing Emoji", 48, 0, 16);
    const bounds = inkBounds(pixels, 32, 96);
    assert(
      bounds.height === reference.height,
      `Emoji height changed: ${JSON.stringify({ text, reference, bounds })}`,
    );
  }
  return { ok: true, cases, observations };
}
