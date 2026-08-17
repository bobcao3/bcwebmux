// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const STORAGE_KEY = "bcwebmux.settings.v1";
const DEFAULT_PROFILE = "github-dark-high-contrast";
const COLOR_FIELDS = ["background", "foreground", "surface", "border", "accent", "muted", "success", "danger"];
export const FONT_OPTIONS = Object.freeze({
  "jetbrains-mono": { name: "JetBrains Mono Nerd Font", cssFamily: "JetBrains Mono Nerd Font", wasmId: 0 },
  "fira-code": {
    name: "Fira Code",
    cssFamily: "Fira Code",
    wasmId: 0,
    canvasOnly: true,
  },
});
export const FONT_FALLBACK_VERSION = 1;
export const DEFAULT_FONT_FALLBACKS = Object.freeze({
  "jetbrains-mono": Object.freeze([
    "ui-monospace", "Noto Emoji", "SFMono-Regular", "Cascadia Mono", "Noto Sans Mono CJK SC", "Noto Sans CJK SC",
    "Microsoft YaHei UI", "PingFang SC", "Noto Sans Symbols 2", "monospace",
  ]),
  "fira-code": Object.freeze([
    "ui-monospace", "Noto Emoji", "SFMono-Regular", "Cascadia Mono", "Noto Sans Mono CJK SC", "Noto Sans CJK SC",
    "Microsoft YaHei UI", "PingFang SC", "JetBrains Mono Nerd Font", "Noto Sans Symbols 2", "monospace",
  ]),
});

export function normalizeFontFamilies(value, fallback = DEFAULT_FONT_FALLBACKS["jetbrains-mono"]) {
  const source = Array.isArray(value) ? value : fallback;
  const families = [];
  const seen = new Set();
  for (const entry of source) {
    if (typeof entry !== "string") continue;
    let family = entry.trim();
    if (family.length >= 2
      && ((family.startsWith('"') && family.endsWith('"'))
        || (family.startsWith("'") && family.endsWith("'")))) {
      family = family.slice(1, -1).trim();
    }
    if (!family || /[\u0000-\u001f\u007f-\u009f;{}]/.test(family)) continue;
    const key = family.toLowerCase();
    if (seen.has(key) || key === "monospace") continue;
    seen.add(key);
    families.push(family);
    if (families.length === 31) break;
  }
  families.push("monospace");
  return families;
}

function migrateFontFamilies(families) {
  if (families.some(family => family.toLowerCase() === "noto emoji")) return families;
  const uiMonospaceIndex = families.findIndex(family => family.toLowerCase() === "ui-monospace");
  const symbolsIndex = families.findIndex(family => family.toLowerCase() === "noto sans symbols 2");
  const insertionIndex = uiMonospaceIndex >= 0
    ? uiMonospaceIndex + 1
    : symbolsIndex >= 0 ? symbolsIndex : families.length - 1;
  return [...families.slice(0, insertionIndex), "Noto Emoji", ...families.slice(insertionIndex)];
}

export function renderFontFamily(families) {
  return families.map(family => {
    const generic = family.toLowerCase();
    if (generic === "monospace" || generic === "ui-monospace") return generic;
    return `"${family.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }).join(", ");
}

const DEFAULT_SETTINGS = Object.freeze({
  fontFamily: "jetbrains-mono",
  fontSize: 15,
  ligatures: true,
  perfMode: "simple",
  renderer: "kb-stb",
});

export function isCanvasOnlyFont(fontOption) {
  return Boolean(fontOption?.canvasOnly);
}

export const BUILTIN_PROFILES = Object.freeze({
  "github-dark-high-contrast": {
    name: "GitHub Dark High Contrast",
    description: "Maximum contrast on GitHub's near-black canvas.",
    background: "#0a0c10", foreground: "#f0f3f6", surface: "#161b22", border: "#7a828e",
    accent: "#58a6ff", muted: "#9ea7b3", success: "#3fb950", danger: "#ff6a69",
    ansi: ["#0a0c10", "#ff6a69", "#56d364", "#e3b341", "#58a6ff", "#d2a8ff", "#39c5cf", "#b1bac4", "#7a828e", "#ff938a", "#6bc46d", "#f2cc60", "#79c0ff", "#d2a8ff", "#56d4dd", "#ffffff"],
  },
  "github-dark-dimmed": {
    name: "GitHub Dark Dimmed",
    description: "A softer blue-gray dark profile.",
    background: "#22272e", foreground: "#adbac7", surface: "#2d333b", border: "#636e7b",
    accent: "#539bf5", muted: "#768390", success: "#57ab5a", danger: "#e5534b",
    ansi: ["#22272e", "#e5534b", "#57ab5a", "#c69026", "#539bf5", "#b083f0", "#39c5cf", "#adbac7", "#636e7b", "#f47067", "#6bc46d", "#daaa3f", "#6cb6ff", "#dcbdfb", "#56d4dd", "#cdd9e5"],
  },
  "solarized-dark": {
    name: "Solarized Dark",
    description: "Low-glare cyan and blue with warm accents.",
    background: "#002b36", foreground: "#eee8d5", surface: "#073642", border: "#657b83",
    accent: "#2aa198", muted: "#839496", success: "#859900", danger: "#dc322f",
    ansi: ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"],
  },
  "amber-console": {
    name: "Amber Console",
    description: "A restrained monochrome phosphor profile.",
    background: "#120d05", foreground: "#ffd37a", surface: "#211708", border: "#9d6f22",
    accent: "#ffb52e", muted: "#b58a45", success: "#d5c05a", danger: "#ff7849",
    ansi: ["#120d05", "#c85d3e", "#a89b42", "#d39b32", "#bb8642", "#d17a45", "#c69b52", "#e7bd6b", "#765522", "#ff7849", "#d5c05a", "#ffb52e", "#d5a85c", "#ee9b5e", "#efc26c", "#ffe6ad"],
  },
});

const DEFAULT_CUSTOM = { ...BUILTIN_PROFILES[DEFAULT_PROFILE], name: "Custom", description: "Your saved profile." };

function normalizeColor(value, fallback) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
}

function customAnsi(custom) {
  return DEFAULT_CUSTOM.ansi.map((color, index) => index === 0 ? custom.background : index === 15 ? custom.foreground : color);
}

function loadSettings() {
  const fallback = {
    ...DEFAULT_SETTINGS,
    fontFallbackVersion: FONT_FALLBACK_VERSION,
    fontFallbacks: Object.fromEntries(Object.keys(FONT_OPTIONS).map(id => [
      id, normalizeFontFamilies(undefined, DEFAULT_FONT_FALLBACKS[id]),
    ])),
    selected: DEFAULT_PROFILE,
    custom: { ...DEFAULT_CUSTOM, ansi: [...DEFAULT_CUSTOM.ansi] },
  };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!saved || typeof saved !== "object") return fallback;
    const custom = { ...DEFAULT_CUSTOM };
    for (const field of COLOR_FIELDS) custom[field] = normalizeColor(saved.custom?.[field], custom[field]);
    custom.ansi = customAnsi(custom);
    const selected = saved.selected === "custom" || BUILTIN_PROFILES[saved.selected] ? saved.selected : DEFAULT_PROFILE;
    const fontFamily = Object.hasOwn(FONT_OPTIONS, saved.fontFamily) ? saved.fontFamily : DEFAULT_SETTINGS.fontFamily;
    const fontSize = Number.isInteger(saved.fontSize)
      ? Math.min(32, Math.max(8, saved.fontSize))
      : DEFAULT_SETTINGS.fontSize;
    const ligatures = typeof saved.ligatures === "boolean" ? saved.ligatures : DEFAULT_SETTINGS.ligatures;
    const perfMode = ["off", "simple", "detailed"].includes(saved.perfMode) ? saved.perfMode : DEFAULT_SETTINGS.perfMode;
    let renderer = ["kb-stb", "kb-canvas"].includes(saved.renderer) ? saved.renderer : DEFAULT_SETTINGS.renderer;
    if (isCanvasOnlyFont(FONT_OPTIONS[fontFamily])) renderer = "kb-canvas";
    const migrateFontFallbacks = !Object.hasOwn(saved, "fontFallbackVersion");
    const fontFallbacks = Object.fromEntries(Object.keys(FONT_OPTIONS).map(id => {
      const fallbacks = normalizeFontFamilies(saved.fontFallbacks?.[id], DEFAULT_FONT_FALLBACKS[id]);
      return [id, migrateFontFallbacks ? migrateFontFamilies(fallbacks) : fallbacks];
    }));
    return {
      fontFamily, fontSize, ligatures, perfMode, renderer, fontFallbackVersion: FONT_FALLBACK_VERSION,
      fontFallbacks, selected, custom,
    };
  } catch {
    return fallback;
  }
}

function saveSettings(settings) {
  try {
    const custom = Object.fromEntries(COLOR_FIELDS.map(field => [field, settings.custom[field]]));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      ligatures: settings.ligatures,
      fontFallbackVersion: settings.fontFallbackVersion,
      fontFallbacks: Object.fromEntries(Object.entries(settings.fontFallbacks)
        .map(([id, fallbacks]) => [id, [...fallbacks]])),
      perfMode: settings.perfMode,
      renderer: settings.renderer,
      selected: settings.selected,
      custom,
    }));
  } catch {
    // Storage can be unavailable in private or locked-down contexts; the active theme still works.
  }
}

function resolveProfile(settings) {
  return settings.selected === "custom" ? settings.custom : BUILTIN_PROFILES[settings.selected];
}

function resolveFont(settings) {
  return {
    ...FONT_OPTIONS[settings.fontFamily],
    id: settings.fontFamily,
    size: settings.fontSize,
    ligatures: settings.ligatures,
    fallbacks: [...settings.fontFallbacks[settings.fontFamily]],
  };
}

function applyDocumentFont(font) {
  const families = normalizeFontFamilies([font.cssFamily, ...font.fallbacks]);
  document.documentElement.style.setProperty("--terminal-font", renderFontFamily(families));
  document.querySelector("#terminal").style.fontSize = `${font.size}px`;
}

function applyDocumentTheme(profile, id) {
  const root = document.documentElement;
  root.dataset.colorProfile = id;
  for (const field of COLOR_FIELDS) root.style.setProperty(`--color-${field}`, profile[field]);
  root.style.colorScheme = profile.background === "#f6f8fa" ? "light" : "dark";
}

export function initializeSettings() {
  const dialog = document.querySelector("#settings-dialog");
  const openButton = document.querySelector("#settings-button");
  const closeButton = document.querySelector("#settings-close");
  const profileList = document.querySelector("#profile-list");
  const customForm = document.querySelector("#custom-profile-form");
  const customColorEditor = document.querySelector("#custom-color-editor");
  const fontSettingsForm = document.querySelector("#font-settings-form");
  const rendererStbOption = fontSettingsForm.elements.renderer.querySelector('option[value="kb-stb"]');
  const perfModeInputs = document.querySelectorAll('input[name="perfMode"]');
  const tablist = dialog.querySelector('[role="tablist"]');
  const settings = loadSettings();
  let onChange = () => {};
  let onFontChange = () => {};
  let onPerfChange = () => {};
  let onRendererChange = () => {};
  let onOpen = () => {};
  let onClose = () => {};
  const syncRendererControl = () => {
    rendererStbOption.disabled = isCanvasOnlyFont(FONT_OPTIONS[settings.fontFamily]);
  };

  const activate = (id, persist = true) => {
    settings.selected = id;
    const profile = resolveProfile(settings);
    applyDocumentTheme(profile, id);
    customColorEditor.hidden = id !== "custom";
    if (id === "custom") {
      for (const field of COLOR_FIELDS) customForm.elements[field].value = settings.custom[field];
    }
    profileList.querySelectorAll("input").forEach(input => { input.checked = input.value === id; });
    if (persist) saveSettings(settings);
    onChange(profile);
  };

  for (const [id, profile] of Object.entries(BUILTIN_PROFILES)) {
    const label = document.createElement("label");
    label.className = "profile-option";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "color-profile";
    radio.value = id;
    radio.checked = settings.selected === id;
    const copy = document.createElement("span");
    copy.className = "profile-copy";
    const title = document.createElement("strong");
    title.textContent = profile.name;
    const description = document.createElement("small");
    description.textContent = profile.description;
    copy.append(title, description);
    const swatches = document.createElement("span");
    swatches.className = "profile-swatches";
    swatches.setAttribute("aria-hidden", "true");
    for (const color of [profile.background, profile.foreground, profile.accent, profile.success, profile.danger]) {
      const swatch = document.createElement("i");
      swatch.style.background = color;
      swatches.append(swatch);
    }
    label.append(radio, copy, swatches);
    profileList.append(label);
  }
  {
    const label = document.createElement("label");
    label.className = "profile-option";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "color-profile";
    radio.value = "custom";
    radio.checked = settings.selected === "custom";
    const copy = document.createElement("span");
    copy.className = "profile-copy";
    const title = document.createElement("strong");
    title.textContent = settings.custom.name;
    const description = document.createElement("small");
    description.textContent = settings.custom.description;
    copy.append(title, description);
    const swatches = document.createElement("span");
    swatches.className = "profile-swatches";
    swatches.setAttribute("aria-hidden", "true");
    for (const color of [settings.custom.background, settings.custom.foreground, settings.custom.accent, settings.custom.success, settings.custom.danger]) {
      const swatch = document.createElement("i");
      swatch.style.background = color;
      swatches.append(swatch);
    }
    label.append(radio, copy, swatches);
    profileList.append(label);
  }

  const setTab = id => {
    dialog.querySelectorAll('[role="tab"]').forEach(tab => {
      const active = tab.dataset.settingsTab === id;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    dialog.querySelectorAll('[role="tabpanel"]').forEach(panel => {
      panel.hidden = panel.id !== `settings-panel-${id}`;
    });
  };

  openButton.addEventListener("click", () => {
    for (const field of COLOR_FIELDS) customForm.elements[field].value = settings.custom[field];
    fontSettingsForm.elements.fontFamily.value = settings.fontFamily;
    fontSettingsForm.elements.fontFallbacks.value = settings.fontFallbacks[settings.fontFamily].join("\n");
    fontSettingsForm.elements.fontSize.value = settings.fontSize;
    fontSettingsForm.elements.ligatures.checked = settings.ligatures;
    syncRendererControl();
    fontSettingsForm.elements.renderer.value = settings.renderer;
    for (const input of perfModeInputs) input.checked = input.value === settings.perfMode;
    onOpen();
    dialog.showModal();
    dialog.querySelector('[role="tab"][aria-selected="true"]').focus();
  });
  closeButton.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", event => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => {
    openButton.focus({ preventScroll: true });
    onClose();
  });
  profileList.addEventListener("change", event => {
    if (event.target.matches('input[name="color-profile"]')) activate(event.target.value);
  });
  tablist.addEventListener("click", event => {
    const tab = event.target.closest("[data-settings-tab]");
    if (tab) setTab(tab.dataset.settingsTab);
  });
  tablist.addEventListener("keydown", event => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const tabs = [...tablist.querySelectorAll('[role="tab"]')];
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const next = tabs[(tabs.indexOf(document.activeElement) + direction + tabs.length) % tabs.length];
    setTab(next.dataset.settingsTab);
    next.focus();
  });
  customForm.addEventListener("submit", event => {
    event.preventDefault();
    for (const field of COLOR_FIELDS) settings.custom[field] = normalizeColor(customForm.elements[field].value, DEFAULT_CUSTOM[field]);
    settings.custom.ansi = customAnsi(settings.custom);
    const customOption = profileList.querySelector('input[value="custom"]').closest(".profile-option");
    [settings.custom.background, settings.custom.foreground, settings.custom.accent, settings.custom.success, settings.custom.danger]
      .forEach((color, index) => { customOption.querySelectorAll(".profile-swatches i")[index].style.background = color; });
    activate("custom");
  });
  fontSettingsForm.elements.fontFamily.value = settings.fontFamily;
  fontSettingsForm.elements.fontFallbacks.value = settings.fontFallbacks[settings.fontFamily].join("\n");
  fontSettingsForm.elements.fontSize.value = settings.fontSize;
  fontSettingsForm.elements.ligatures.checked = settings.ligatures;
  fontSettingsForm.elements.renderer.value = settings.renderer;
  syncRendererControl();
  fontSettingsForm.addEventListener("change", event => {
    const requestedRenderer = ["kb-stb", "kb-canvas"].includes(fontSettingsForm.elements.renderer.value)
      ? fontSettingsForm.elements.renderer.value
      : DEFAULT_SETTINGS.renderer;
    const fontFamilyChanged = event.target === fontSettingsForm.elements.fontFamily;
    if (fontFamilyChanged) {
      settings.fontFamily = Object.hasOwn(FONT_OPTIONS, fontSettingsForm.elements.fontFamily.value)
        ? fontSettingsForm.elements.fontFamily.value
        : DEFAULT_SETTINGS.fontFamily;
      fontSettingsForm.elements.fontFallbacks.value = settings.fontFallbacks[settings.fontFamily].join("\n");
    }
    const renderer = isCanvasOnlyFont(FONT_OPTIONS[settings.fontFamily]) && requestedRenderer === "kb-stb"
      ? "kb-canvas"
      : requestedRenderer;
    syncRendererControl();
    fontSettingsForm.elements.renderer.value = renderer;
    if (renderer !== settings.renderer) {
      settings.renderer = renderer;
      saveSettings(settings);
      onRendererChange(renderer);
    }
    if (!fontFamilyChanged && event.target === fontSettingsForm.elements.renderer) return;
    settings.ligatures = fontSettingsForm.elements.ligatures.checked;
    if (event.target === fontSettingsForm.elements.fontFallbacks) {
      const activeId = settings.fontFamily;
      settings.fontFallbacks[activeId] = normalizeFontFamilies(
        fontSettingsForm.elements.fontFallbacks.value.split(/\r?\n/),
        DEFAULT_FONT_FALLBACKS[activeId],
      );
      fontSettingsForm.elements.fontFallbacks.value = settings.fontFallbacks[activeId].join("\n");
    }
    settings.fontSize = Number.isInteger(Number(fontSettingsForm.elements.fontSize.value))
      ? Math.min(32, Math.max(8, Number(fontSettingsForm.elements.fontSize.value)))
      : DEFAULT_SETTINGS.fontSize;
    const font = resolveFont(settings);
    applyDocumentFont(font);
    saveSettings(settings);
    onFontChange(font);
  });
  for (const input of perfModeInputs) {
    input.checked = input.value === settings.perfMode;
    input.addEventListener("change", () => {
      if (!input.checked) return;
      settings.perfMode = ["off", "simple", "detailed"].includes(input.value)
        ? input.value
        : DEFAULT_SETTINGS.perfMode;
      saveSettings(settings);
      onPerfChange(settings.perfMode);
    });
  }

  applyDocumentTheme(resolveProfile(settings), settings.selected);
  customColorEditor.hidden = settings.selected !== "custom";
  applyDocumentFont(resolveFont(settings));
  return {
    get profile() { return resolveProfile(settings); },
    get font() { return resolveFont(settings); },
    get perfMode() { return settings.perfMode; },
    get renderer() { return settings.renderer; },
    setOnChange(callback) { onChange = callback || (() => {}); },
    setOnFontChange(callback) { onFontChange = callback || (() => {}); },
    setOnPerfChange(callback) { onPerfChange = callback || (() => {}); },
    setOnRendererChange(callback) { onRendererChange = callback || (() => {}); },
    setLifecycle(callbacks = {}) {
      onOpen = typeof callbacks.onOpen === "function" ? callbacks.onOpen : () => {};
      onClose = typeof callbacks.onClose === "function" ? callbacks.onClose : () => {};
    },
  };
}
