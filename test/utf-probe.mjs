// Probe the shipped kb-stb WASM renderer with UTF-8 input (CJK + emoji + ASCII).
// Stubs the WebGPU host imports and captures glyph bitmaps + cell metadata.
import { readFile } from "node:fs/promises";

const wasmBytes = await readFile(new URL("../zig-out/web/terminal.wasm", import.meta.url));
const { instance } = await WebAssembly.instantiate(wasmBytes, {
  host: {
    pty_write(ptr, len) { return 1; },
    set_title() {},
    ring_bell() {},
    gpu_text_backend() { return 0; }, // kb-stb
    gpu_init() { return 1; },
    gpu_glyph(slot, ptr, len, flags) {
      const bytes = new Uint8Array(instance.exports.memory.buffer, ptr, len);
      glyphs.push({ slot, text: new TextDecoder().decode(bytes), flags });
      return 1;
    },
    gpu_glyph_bitmap(slot, ptr, width, height, stride) {
      const bytes = new Uint8Array(instance.exports.memory.buffer, ptr, stride * height);
      const mask = new Uint8Array(width * height);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
          mask[y * width + x] = bytes[y * stride + x];
      bitmaps.push({ slot, width, height, mask, nonZero: mask.reduce((a, b) => a + (b > 0 ? 1 : 0), 0) });
      return 1;
    },
    gpu_submit(framePtr, cellsPtr) {
      const mem = instance.exports.memory.buffer;
      const frame = new DataView(mem, framePtr, 64);
      frames.push({ frame, cols: frame.getUint32(8, true), rows: frame.getUint32(12, true) });
      const cols = frame.getUint32(8, true);
      const cellCount = frame.getUint32(16, true);
      const cells = new DataView(mem, cellsPtr, cellCount * 32);
      for (let i = 0; i < cellCount; i++) {
        const off = i * 32;
        const glyph = cells.getUint32(off + 24, true);
        const active = cells.getUint32(off + 28, true);
        if (active) cellList.push({ x: cells.getUint32(off, true), y: cells.getUint32(off + 4, true), w: cells.getUint32(off + 8, true), glyph });
      }
      return 1;
    },
  },
});
const e = instance.exports;
const glyphs = [];
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
e.term_resize(40, 10, 8, 16, 8, 16, 15);
cellList.length = 0; bitmaps.length = 0; frames.length = 0;
feed("\x1b[2J\x1b[HABC");
if (e.term_frame() !== 1) console.log("term_frame failed for ASCII");
report("ASCII 'ABC'");

// CJK
cellList.length = 0; bitmaps.length = 0; frames.length = 0;
feed("\x1b[2J\x1b[H中");
if (e.term_frame() !== 1) console.log("term_frame failed for CJK");
report("CJK '中' (U+4E2D)");

// Emoji
cellList.length = 0; bitmaps.length = 0; frames.length = 0;
feed("\x1b[2J\x1b[H😀");
if (e.term_frame() !== 1) console.log("term_frame failed for emoji");
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
