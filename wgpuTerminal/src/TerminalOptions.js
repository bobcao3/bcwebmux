// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();
export const strictDecoder = new TextDecoder("utf-8", { fatal: true });

export const DEFAULT_THEME = Object.freeze({
  background: "#0a0c10",
  foreground: "#f0f3f6",
  surface: "#161b22",
  border: "#7a828e",
  accent: "#58a6ff",
  muted: "#9ea7b3",
  success: "#3fb950",
  danger: "#ff6a69",
  ansi: Object.freeze([
    "#0a0c10", "#ff6a69", "#56d364", "#e3b341", "#58a6ff", "#d2a8ff", "#39c5cf", "#b1bac4",
    "#7a828e", "#ff938a", "#6bc46d", "#f2cc60", "#79c0ff", "#d2a8ff", "#56d4dd", "#ffffff",
  ]),
});

export const DEFAULT_FONT = Object.freeze({
  id: "jetbrains-mono",
  name: "JetBrains Mono Nerd Font",
  cssFamily: "JetBrains Mono Nerd Font",
  wasmId: 0,
  size: 15,
  ligatures: true,
  fallbacks: Object.freeze([
    "ui-monospace", "Noto Emoji", "SFMono-Regular", "Cascadia Mono", "Noto Sans Mono CJK SC",
    "Noto Sans CJK SC", "Microsoft YaHei UI", "PingFang SC", "Noto Sans Symbols 2", "monospace",
  ]),
});

export const COLOR_FIELDS = Object.freeze([
  "background", "foreground", "surface", "border", "accent", "muted", "success", "danger",
]);

export function packedColor(color) {
  if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) {
    throw new TypeError(`invalid terminal color: ${color}`);
  }
  return Number.parseInt(color.slice(1), 16) >>> 0;
}

export function normalizePowerPreference(value) {
  if (value !== undefined && value !== "low-power" && value !== "high-performance") {
    throw new TypeError("invalid power preference");
  }
  return value;
}

export function renderFontFamily(families) {
  return families.map((family) => {
    const generic = family.toLowerCase();
    if (generic === "monospace" || generic === "ui-monospace") return generic;
    return `"${family.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }).join(", ");
}

export function normalizeFont(font) {
  const value = { ...DEFAULT_FONT, ...(font || {}) };
  if (value.canvasOnly) throw new TypeError("canvasOnly fonts are unsupported: both rasterizers require wasmFontUrls font bytes");
  value.size = Math.min(32, Math.max(8, Math.round(Number(value.size) || DEFAULT_FONT.size)));
  value.ligatures = value.ligatures !== false;
  value.wasmId = Number.isInteger(value.wasmId) ? value.wasmId : 0;
  value.fallbacks = Array.isArray(value.fallbacks) ? [...value.fallbacks] : [...DEFAULT_FONT.fallbacks];
  if (!value.fallbacks.includes("monospace")) value.fallbacks.push("monospace");
  if (!value.cssFamily) throw new TypeError("terminal font cssFamily is required");
  return value;
}

export function loadTerminalFonts(font) {
  const loads = [
    document.fonts.load(`normal 400 ${font.size}px "${font.cssFamily}"`),
    document.fonts.load(`normal 700 ${font.size}px "${font.cssFamily}"`),
    document.fonts.load(`italic 400 ${font.size}px "${font.cssFamily}"`),
    document.fonts.load(`italic 700 ${font.size}px "${font.cssFamily}"`),
  ];
  if (font.fallbacks.some((fallback) => /noto emoji/i.test(fallback))) {
    loads.push(document.fonts.load(`normal 400 ${font.size}px "Noto Emoji"`, "😀"));
  }
  return loads;
}

export function normalizeBinary(data) {
  if (typeof data === "string") return encoder.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError("terminal data must be a string, ArrayBuffer, or ArrayBufferView");
}
