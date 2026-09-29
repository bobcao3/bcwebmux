# SPDX-License-Identifier: MIT

from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

root = Path(__file__).resolve().parents[1] / "src/browser/render"
for name, advance in [("Narrow", 500), ("Wide", 1500)]:
    builder = FontBuilder(1000, isTTF=True)
    builder.setupGlyphOrder([".notdef", "water"])
    builder.setupCharacterMap({0x6C34: "water"})
    builder.setupGlyf({glyph: TTGlyphPen(None).glyph() for glyph in [".notdef", "water"]})
    builder.setupHorizontalMetrics({".notdef": (500, 0), "water": (advance, 0)})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupNameTable({
        "familyName": "bcwebmux Coverage " + name,
        "styleName": "Regular",
        "uniqueFontIdentifier": "bcwebmuxCoverage" + name,
        "fullName": "bcwebmux Coverage " + name,
        "psName": "bcwebmuxCoverage" + name,
        "version": "Version 1.0",
        "copyright": "Copyright 2026 Cheng Cao. MIT license.",
    })
    builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
    builder.setupPost()
    builder.font["head"].created = builder.font["head"].modified = 2082844800
    builder.save(root / ("FontCoverage" + name + ".ttf"))
