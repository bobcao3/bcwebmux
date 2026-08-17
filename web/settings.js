// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const STORAGE_KEY = "bcwebmux.settings.v1";
const DEFAULT_PROFILE = "github-dark-high-contrast";
const COLOR_FIELDS = ["background", "foreground", "surface", "border", "accent", "muted", "success", "danger"];

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
  const fallback = { selected: DEFAULT_PROFILE, custom: { ...DEFAULT_CUSTOM, ansi: [...DEFAULT_CUSTOM.ansi] } };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!saved || typeof saved !== "object") return fallback;
    const custom = { ...DEFAULT_CUSTOM };
    for (const field of COLOR_FIELDS) custom[field] = normalizeColor(saved.custom?.[field], custom[field]);
    custom.ansi = customAnsi(custom);
    const selected = saved.selected === "custom" || BUILTIN_PROFILES[saved.selected] ? saved.selected : DEFAULT_PROFILE;
    return { selected, custom };
  } catch {
    return fallback;
  }
}

function saveSettings(settings) {
  try {
    const custom = Object.fromEntries(COLOR_FIELDS.map(field => [field, settings.custom[field]]));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ selected: settings.selected, custom }));
  } catch {
    // Storage can be unavailable in private or locked-down contexts; the active theme still works.
  }
}

function resolveProfile(settings) {
  return settings.selected === "custom" ? settings.custom : BUILTIN_PROFILES[settings.selected];
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
  const tablist = dialog.querySelector('[role="tablist"]');
  const settings = loadSettings();
  let onChange = () => {};
  let onOpen = () => {};
  let onClose = () => {};

  const activate = (id, persist = true) => {
    settings.selected = id;
    const profile = resolveProfile(settings);
    applyDocumentTheme(profile, id);
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

  const setTab = id => {
    dialog.querySelectorAll('[role="tab"]').forEach(tab => {
      const active = tab.dataset.settingsTab === id;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    dialog.querySelector("#settings-panel-profiles").hidden = id !== "profiles";
    dialog.querySelector("#settings-panel-custom").hidden = id !== "custom";
  };

  openButton.addEventListener("click", () => {
    for (const field of COLOR_FIELDS) customForm.elements[field].value = settings.custom[field];
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
    activate("custom");
  });

  applyDocumentTheme(resolveProfile(settings), settings.selected);
  return {
    get profile() { return resolveProfile(settings); },
    setOnChange(callback) { onChange = callback || (() => {}); },
    setLifecycle(callbacks = {}) {
      onOpen = typeof callbacks.onOpen === "function" ? callbacks.onOpen : () => {};
      onClose = typeof callbacks.onClose === "function" ? callbacks.onClose : () => {};
    },
  };
}
