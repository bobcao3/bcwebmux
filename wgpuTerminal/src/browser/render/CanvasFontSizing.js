// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { renderFontFamily } from "../../TerminalOptions.js";
import { coverageFamilies, fontCoverageReady } from "./FontCoverage.js";

const primary_probe = renderFontFamily([coverageFamilies[0]]);
const secondary_probe = renderFontFamily([coverageFamilies[1]]);
const ascii = Array.from({ length: 95 }, (_, index) => String.fromCharCode(index + 32)).join("");
const ideographic =
  /^[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}\u3000-\u303f\uff01-\uffef]/u;
export class CanvasFontSizing {
  constructor() {
    this.cache = new Map();
  }

  resolve(context, font, style, size, cell_width, text) {
    const family = renderFontFamily([font.cssFamily, ...font.fallbacks]);
    const prefix = `${style & 2 ? "italic" : "normal"} ${style & 1 ? 700 : 400}`;
    const cjk = ideographic.test(text) && !/\p{Emoji_Presentation}|\ufe0f/u.test(text);
    if (!cjk) return { css: `${prefix} ${size}px ${family}`, cjk };
    if (!fontCoverageReady()) throw new Error("Canvas font coverage probes are not loaded");
    const key = JSON.stringify([font.cssFamily, family, style & 1, size, cell_width]);
    let scale = this.cache.get(key);
    if (scale === undefined) {
      const primary = `normal 400 ${size}px ${renderFontFamily([font.cssFamily])}`;
      context.font = `${primary}, ${primary_probe}`;
      const first = context.measureText("水").width;
      context.font = `${primary}, ${secondary_probe}`;
      const second = context.measureText("水").width;
      context.font = primary;
      const latin = context.measureText(ascii);
      const target =
        first === second
          ? first
          : Math.min(
              latin.actualBoundingBoxAscent + latin.actualBoundingBoxDescent,
              2 * cell_width,
            );
      context.font = `normal ${style & 1 ? 700 : 400} ${size}px ${family}`;
      // Canvas ink bounds include synthetic bold, unlike the native face metrics.
      const water = context.measureText("水");
      const ratio = target / water.width;
      scale = water.width > 0 && Number.isFinite(ratio) && ratio >= 0.25 && ratio <= 4 ? ratio : 1;
      if (this.cache.size >= 16) this.cache.clear();
      this.cache.set(key, scale);
    }
    return { css: `${prefix} ${size * scale}px ${family}`, cjk };
  }
}
