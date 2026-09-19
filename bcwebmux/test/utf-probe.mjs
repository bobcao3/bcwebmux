// Probe the shipped kb-stb WASM renderer with UTF-8 input (CJK + emoji + ASCII).
// Stubs the GPU host imports and captures glyph bitmaps + cell metadata.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const webRoot = process.argv[2] ? pathToFileURL(resolve(process.argv[2]) + "/") : new URL("../zig-out/web/", import.meta.url);

const fontBytes = await Promise.all([
  readFile(new URL("fonts/JetBrainsMonoNerdFontMono-Regular.ttf", webRoot)),
  readFile(new URL("fonts/JetBrainsMonoNerdFontMono-Bold.ttf", webRoot)),
  readFile(new URL("fonts/JetBrainsMonoNerdFontMono-Italic.ttf", webRoot)),
  readFile(new URL("fonts/JetBrainsMonoNerdFontMono-BoldItalic.ttf", webRoot)),
]);
function font(style) {
  if (!Number.isSafeInteger(style) || style < 0 || style >= fontBytes.length) {
    throw new Error(`invalid font style: ${style}`);
  }
  return fontBytes[style];
}

const wasmBytes = await readFile(new URL("terminal.wasm", webRoot));
const { instance } = await WebAssembly.instantiate(wasmBytes, {
  host: {
    terminal_log() {},
    pty_write(ptr, len) { return 1; },
    set_title() {},
    ring_bell() {},
    font_size(style) { return font(style).byteLength; },
    font_copy(style, ptr, len) {
      const bytes = font(style);
      if (!Number.isSafeInteger(ptr) || !Number.isSafeInteger(len) ||
          ptr < 0 || len !== bytes.byteLength) {
        throw new Error("invalid font copy range");
      }
      const memory = new Uint8Array(instance.exports.memory.buffer);
      if (ptr > memory.byteLength - len) {
        throw new Error("font copy out of bounds");
      }
      memory.set(bytes, ptr);
      return 1;
    },
    user_write() { return 1; },
    terminal_reply() { return 1; },
    clipboard_write() { return 1; },
    desktop_notification() {},
    gpu_submit(submissionPtr) {
      const mem = instance.exports.memory.buffer;
      const submission = new DataView(mem, submissionPtr, 112);
      if (submission.getUint32(0, true) !== 0x5355424d ||
          submission.getUint32(4, true) !== 4 ||
          submission.getUint32(8, true) !== 112) {
        throw new Error("invalid GPU submission");
      }
      const framePtr = submission.getUint32(16, true);
      const frameLen = submission.getUint32(20, true);
      const cellsPtr = submission.getUint32(24, true);
      const cellCount = submission.getUint32(28, true);
      const bitmapRequestsPtr = submission.getUint32(60, true);
      const bitmapRequestCount = submission.getUint32(64, true);
      const bitmapPixelsPtr = submission.getUint32(68, true);
      const bitmapPixelsCount = submission.getUint32(72, true);
      const requests = new DataView(mem, bitmapRequestsPtr, bitmapRequestCount * 16);
      const pixels = new Uint8Array(mem, bitmapPixelsPtr, bitmapPixelsCount);
      for (let i = 0; i < bitmapRequestCount; i++) {
        const off = i * 16;
        const firstSlot = requests.getUint32(off, true);
        const slotCount = requests.getUint32(off + 4, true);
        const pixelOffset = requests.getUint32(off + 8, true);
        const bytesPerRow = requests.getUint32(off + 12, true);
        for (let slotIndex = 0; slotIndex < slotCount; slotIndex++) {
          const mask = new Uint8Array(8 * 16);
          for (let y = 0; y < 16; y++) {
            const rowOffset = pixelOffset + y * bytesPerRow + slotIndex * 8;
            mask.set(pixels.subarray(rowOffset, rowOffset + 8), y * 8);
          }
          const slot = firstSlot + slotIndex;
          bitmaps.push({ slot, width: 8, height: 16, mask, nonZero: mask.reduce((a, b) => a + (b > 0 ? 1 : 0), 0) });
        }
      }
      const frame = new DataView(mem, framePtr, frameLen);
      frames.push({ frame, cols: frame.getUint32(8, true), rows: frame.getUint32(12, true) });
      const cols = frame.getUint32(8, true);
      const cells = new DataView(mem, cellsPtr, cellCount * 8);
      for (let i = 0; i < cellCount; i++) {
        const glyph = cells.getUint32(i * 8, true);
        const meta = cells.getUint32(i * 8 + 4, true);
        const wide = (meta & (1 << 16)) !== 0;
        const active = (meta & (1 << 17)) !== 0;
        if (active) cellList.push({ x: i % cols, y: Math.floor(i / cols), w: wide ? 2 : 1, glyph });
      }
      return 1;
    },
  },
});
const e = instance.exports;
const bitmaps = [];
const frames = [];
const cellList = [];

const encoder = new TextEncoder();
function feed(str) {
  const bytes = encoder.encode(str);
  const ptr = e.term_reserve(bytes.length);
  new Uint8Array(e.memory.buffer, ptr, bytes.length).set(bytes);
  return e.term_feed(bytes.length);
}

function utf8For(cp) {
  if (cp <= 0x7f) return String.fromCharCode(cp);
  if (cp <= 0x7ff) return String.fromCharCode(
    0xc0 | (cp >> 6),
    0x80 | (cp & 0x3f),
  );
  if (cp <= 0xffff) return String.fromCharCode(
    0xe0 | (cp >> 12),
    0x80 | ((cp >> 6) & 0x3f),
    0x80 | (cp & 0x3f),
  );
  return String.fromCharCode(
    0xf0 | (cp >> 18),
    0x80 | ((cp >> 12) & 0x3f),
    0x80 | ((cp >> 6) & 0x3f),
    0x80 | (cp & 0x3f),
  );
}

function feedRaw(str) {
  const bytes = Uint8Array.from(str, ch => ch.charCodeAt(0));
  const ptr = e.term_reserve(bytes.length);
  new Uint8Array(e.memory.buffer, ptr, bytes.length).set(bytes);
  return e.term_feed(bytes.length);
}

function report(label, codepoints = []) {
  const bitmapBySlot = new Map(bitmaps.map(b => [b.slot, b]));
  const detail = cellList
    .filter(c => c.glyph > 0)
    .map(c => {
      const b = bitmapBySlot.get(c.glyph - 1);
      const cp = codepoints[c.x];
      const label = cp === undefined ? "" : ` U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
      return `  cell(${c.x},${c.y})${label} w=${c.w} slot=${c.glyph - 1} bitmap=${b ? `${b.width}x${b.height} nonZero=${b.nonZero}` : "MISSING"}`;
    })
    .join("\n");
  console.log(`\n=== ${label} ===`);
  console.log(`frame cols=${frames.at(-1)?.cols} rows=${frames.at(-1)?.rows} cells=${cellList.length}`);
  console.log(detail || "  (no active cells with glyphs)");
}

// ASCII
e.term_init(40, 10);
e.term_set_glyph_partition(0, 400, 40, 1);
e.term_resize(40, 10, 8, 16, 8, 16, 15);
cellList.length = 0; bitmaps.length = 0; frames.length = 0;
feed("\x1b[2J\x1b[HABC");
if (e.term_frame() !== 1) console.log("term_frame failed for ASCII");
assert.equal(bitmaps.length, 3);
assert.ok(bitmaps.every(b => b.width === 8 && b.height === 16));
report("ASCII 'ABC'");

// CJK
cellList.length = 0; bitmaps.length = 0; frames.length = 0;
feed("\x1b[2J\x1b[H中");
if (e.term_frame() !== 1) console.log("term_frame failed for CJK");
assert.equal(bitmaps.length, 2);
assert.equal(bitmaps[1].slot, bitmaps[0].slot + 1);
assert.ok(bitmaps.every(b => b.width === 8 && b.height === 16));
report("CJK '中' (U+4E2D)");

// Emoji
cellList.length = 0; bitmaps.length = 0; frames.length = 0;
feed("\x1b[2J\x1b[H😀");
if (e.term_frame() !== 1) console.log("term_frame failed for emoji");
assert.equal(bitmaps.length, 2);
assert.equal(bitmaps[1].slot, bitmaps[0].slot + 1);
assert.ok(bitmaps.every(b => b.width === 8 && b.height === 16));
report("Emoji '😀' (U+1F600)");

// Mixed ASCII+CJK
cellList.length = 0; bitmaps.length = 0; frames.length = 0;
feed("\x1b[2J\x1b[Ha中b");
if (e.term_frame() !== 1) console.log("term_frame failed for mixed");
report("Mixed 'a中b'");

// Nerd Font icons
const iconCodepoints = [0xe0a0, 0xe0b0, 0xe700, 0xe7ae, 0xe7c3, 0xe736, 0xf0001, 0xf1af0, 0xf533];
cellList.length = 0; bitmaps.length = 0; frames.length = 0;
feedRaw("\x1b[2J\x1b[H" + iconCodepoints.map(utf8For).join(""));
if (e.term_frame() !== 1) console.log("term_frame failed for Nerd Font icons");
report("Nerd Font icons", iconCodepoints);

// Classic Font Awesome brand codepoint, absent from this font
const missingCodepoint = 0xf09b;
cellList.length = 0; bitmaps.length = 0; frames.length = 0;
feedRaw("\x1b[2J\x1b[H" + utf8For(missingCodepoint));
if (e.term_frame() !== 1) console.log("term_frame failed for missing FA icon");
report("Missing FA brand icon", [missingCodepoint]);
