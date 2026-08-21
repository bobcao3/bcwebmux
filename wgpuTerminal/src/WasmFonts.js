// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

export const DEFAULT_WASM_FONT_FILES = Object.freeze([
  "JetBrainsMonoNerdFontMono-Regular.ttf",
  "JetBrainsMonoNerdFontMono-Bold.ttf",
  "JetBrainsMonoNerdFontMono-Italic.ttf",
  "JetBrainsMonoNerdFontMono-BoldItalic.ttf",
]);

const fontCache = new Map();

function documentBase() {
  return globalThis.document?.baseURI ?? globalThis.location?.href ?? "http://localhost/";
}

export function resolveWasmFontUrls(wasmUrl, values) {
  const wasm = new URL(String(wasmUrl || "/terminal.wasm"), documentBase());
  if (values != null && !Array.isArray(values)) {
    throw new TypeError("wasmFontUrls must be an array");
  }
  const urls = values == null
    ? DEFAULT_WASM_FONT_FILES.map(file => `fonts/${file}`)
    : [...values];
  if (urls.length !== 4 || urls.some(value => typeof value !== "string" && !(value instanceof URL))) {
    throw new TypeError("wasmFontUrls must contain regular, bold, italic, and bold-italic URLs");
  }
  return urls.map(value => new URL(String(value), wasm).href);
}

function fetchFont(url) {
  let pending = fontCache.get(url);
  if (!pending) {
    pending = fetch(url).then(async response => {
      if (!response.ok) throw new Error(`terminal font request failed (${response.status}): ${url}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.byteLength) throw new Error(`terminal font response was empty: ${url}`);
      return bytes;
    });
    fontCache.set(url, pending);
    pending.catch(() => {
      if (fontCache.get(url) === pending) fontCache.delete(url);
    });
  }
  return pending;
}

export function loadWasmFontFaces(urls) {
  return Promise.all(urls.map(fetchFont));
}
