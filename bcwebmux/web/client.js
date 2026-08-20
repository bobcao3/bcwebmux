// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { Terminal } from "/wgpuTerminal/src/index.js";
import { BcwWebSocketAddon } from "./BcwWebSocketAddon.js";
import { initializeSettings } from "./settings.js";

const terminalElement = document.querySelector("#terminal");
const terminalViewport = document.querySelector("#terminal-viewport");
const selectionButton = document.querySelector("#selection-button");
const softkeysToggle = document.querySelector("#softkeys-toggle");
const perf = document.querySelector("#perf");
const scroll = document.querySelector("#scroll");
const spacer = document.querySelector("#spacer");
const textView = document.querySelector("#text-view");
const screen = document.querySelector("#screen");
const input = document.querySelector("#input");
const composition = document.querySelector("#composition");
const softkeys = document.querySelector("#softkeys");
const status = document.querySelector("#status");
const inputDebugPanel = document.querySelector("#input-debug");
const inputDebugLog = document.querySelector("#input-debug-log");
const inputDebugClear = document.querySelector("#input-debug-clear");
const inputDebugCopy = document.querySelector("#input-debug-copy");
const linkDialog = document.querySelector("#link-dialog");
const linkDialogUri = document.querySelector("#link-dialog-uri");
const linkDialogCancel = document.querySelector("#link-dialog-cancel");
const linkDialogOpen = document.querySelector("#link-dialog-open");
const notificationDialog = document.querySelector("#notification-dialog");
const notificationDialogLater = document.querySelector("#notification-dialog-later");
const notificationDialogEnable = document.querySelector("#notification-dialog-enable");
const notificationsEnable = document.querySelector("#notifications-enable");
const notificationsStatus = document.querySelector("#notifications-status");
const notificationPromptDismissalKey = "bcwebmux.notification-prompt-dismissed";
const coarsePointer = window.matchMedia("(hover: none) and (pointer: coarse)");
const settings = initializeSettings();
const query = new URLSearchParams(location.search);
const requestedRenderer = query.get("renderer");
const textRenderer = requestedRenderer === "kb-canvas" ? "kb-canvas" : settings.renderer;

let softkeysVisibilityOverride = null;
let softkeysVisible = false;
let pendingLinkUri = null;

function setConnectionStatus(connected, label) {
  status.classList.toggle("connected", connected);
  status.setAttribute("aria-label", label);
  status.setAttribute("title", label);
}

function showDesktopNotification(title, body) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const notification = new Notification(title || "bcwebmux", { body });
    notification.addEventListener("click", () => {
      window.focus();
      notification.close();
    });
  } catch (error) {
    console.error("desktop notification failed", error);
  }
}

function updateNotificationPermissionUi() {
  if (typeof Notification === "undefined") {
    notificationsStatus.textContent = "Unsupported";
    notificationsEnable.disabled = true;
    return;
  }
  const permission = Notification.permission;
  notificationsStatus.textContent = permission[0].toUpperCase() + permission.slice(1);
  notificationsEnable.disabled = permission !== "default";
}

function notificationPromptWasDismissed() {
  try {
    return localStorage.getItem(notificationPromptDismissalKey) === "1";
  } catch {
    return false;
  }
}

function dismissNotificationPrompt() {
  try {
    localStorage.setItem(notificationPromptDismissalKey, "1");
  } catch {}
}

function maybeShowNotificationPrompt() {
  if (typeof Notification === "undefined" || Notification.permission !== "default" ||
      notificationPromptWasDismissed() || notificationDialog.open) return;
  terminal.suspendFocus();
  notificationDialog.showModal();
}

notificationsEnable?.addEventListener("click", async () => {
  try {
    await Notification.requestPermission();
  } catch (error) {
    console.error("notification permission request failed", error);
  } finally {
    updateNotificationPermissionUi();
  }
});
notificationDialogLater?.addEventListener("click", () => {
  dismissNotificationPrompt();
  notificationDialog.close();
});
notificationDialogEnable?.addEventListener("click", async () => {
  dismissNotificationPrompt();
  try {
    await Notification.requestPermission();
  } catch (error) {
    console.error("notification permission request failed", error);
  } finally {
    updateNotificationPermissionUi();
    notificationDialog.close();
  }
});
notificationDialog?.addEventListener("close", () => terminal.resumeFocus({ focus: true }));
updateNotificationPermissionUi();

function validatedWebLink(uri) {
  try {
    const url = new URL(uri);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function showLinkConfirmation(uri) {
  pendingLinkUri = uri;
  linkDialogUri.textContent = uri;
  const url = validatedWebLink(uri);
  linkDialogOpen.disabled = !url;
  linkDialogOpen.title = url ? "" : "Only absolute HTTP or HTTPS links can be opened.";
  terminal.suspendFocus();
  linkDialog.showModal();
}

linkDialogCancel.addEventListener("click", () => linkDialog.close());
linkDialogOpen.addEventListener("click", () => {
  const url = validatedWebLink(pendingLinkUri);
  if (!url) return;
  window.open(url.href, "_blank", "noopener,noreferrer");
  linkDialog.close();
});
linkDialog.addEventListener("close", () => {
  pendingLinkUri = null;
  linkDialogUri.textContent = "";
  terminal.resumeFocus({ focus: true });
});

function softkeysAreVisible() {
  return softkeysVisibilityOverride ?? coarsePointer.matches;
}

function updateSoftkeysUi() {
  const visible = softkeysAreVisible();
  softkeysVisible = visible;
  terminalElement.classList.toggle("softkeys-visible", visible);
  softkeysToggle?.setAttribute("aria-pressed", String(visible));
  softkeysToggle?.setAttribute("aria-label", visible ? "Hide terminal soft keys" : "Show terminal soft keys");
  softkeysToggle?.setAttribute("title", visible ? "Hide terminal soft keys" : "Show terminal soft keys");
}

function updateSelectionModeUi(active = terminal?.selectionMode || false) {
  terminalElement.classList.toggle("selection-mode", active);
  selectionButton?.setAttribute("aria-pressed", String(active));
  selectionButton?.setAttribute("aria-label", active ? "Exit selection mode" : "Enter selection mode");
  selectionButton?.setAttribute("title", active ? "Resume live terminal" : "Select frozen terminal text");
}

function updateSoftModifiers(value) {
  softkeys.querySelectorAll("[data-mod]").forEach((button) => {
    button.setAttribute("aria-pressed", String((value & Number(button.dataset.mod)) !== 0));
  });
}

updateSoftkeysUi();
updateSelectionModeUi(false);
softkeysToggle?.addEventListener("pointerdown", (event) => event.preventDefault());
softkeysToggle?.addEventListener("click", () => {
  softkeysVisibilityOverride = !softkeysAreVisible();
  updateSoftkeysUi();
  if (!softkeysAreVisible()) terminal.clearSoftModifiers();
  terminal.focus();
});
selectionButton?.addEventListener("pointerdown", (event) => event.preventDefault());
selectionButton?.addEventListener("click", () => {
  if (terminal.selectionMode) terminal.exitSelectionMode();
  else terminal.enterSelectionMode();
});
coarsePointer.addEventListener("change", () => updateSoftkeysUi());
softkeys.addEventListener("pointerdown", (event) => {
  const button = event.target.closest?.("button");
  if (button) event.preventDefault();
});
softkeys.addEventListener("click", (event) => {
  if (terminal.selectionMode) return;
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.mod) {
    terminal.setSoftModifiers(terminal.softModifiers ^ Number(button.dataset.mod));
  } else {
    terminal.commitComposition();
    terminal.sendKey(button.dataset.code, button.dataset.key);
  }
  terminal.focus();
});

const terminal = new Terminal({
  wasmUrl: "/terminal.wasm",
  renderer: textRenderer,
  font: settings.font,
  theme: settings.profile,
  grainStrength: settings.grainStrength,
  terminalElement,
  elements: {
    viewport: terminalViewport,
    scroll,
    spacer,
    textView,
    input,
    screen,
    composition,
  },
  inputDebug: query.has("input-debug"),
  debugElements: {
    panel: inputDebugPanel,
    log: inputDebugLog,
    clear: inputDebugClear,
    copy: inputDebugCopy,
  },
});
const transport = new BcwWebSocketAddon();
terminal.loadAddon(transport);
terminal.onError((error) => setConnectionStatus(false, error?.message || "terminal error"));
terminal.onTitleChange((title) => { document.title = title || "bcwebmux"; });
terminal.onBell(() => {
  terminalElement.classList.add("flash");
  setTimeout(() => terminalElement.classList.remove("flash"), 80);
});
terminal.onNotification(({ title, body }) => showDesktopNotification(title, body));
terminal.onLinkActivate(({ uri }) => showLinkConfirmation(uri));
terminal.onSelectionModeChange(({ active }) => updateSelectionModeUi(active));
terminal.onSoftModifiersChange(updateSoftModifiers);
transport.onStatus((label, state) => setConnectionStatus(state.connected, label));

settings.setOnChange((profile) => terminal.setTheme(profile));
settings.setOnFontChange(async (font) => {
  try {
    await terminal.setFont(font);
  } catch (error) {
    setConnectionStatus(false, error?.message || "font error");
  }
});
settings.setOnRendererChange((renderer) => {
  try {
    terminal.setRenderer(renderer);
  } catch (error) {
    setConnectionStatus(false, error?.message || "renderer error");
    throw error;
  }
});
settings.setOnGrainChange((strength) => terminal.setGrainStrength(strength));
settings.setOnPerfChange(applyPerfMode);
settings.setLifecycle({
  onOpen: () => terminal.suspendFocus(),
  onClose: () => terminal.resumeFocus({ focus: true }),
});

function formatMs(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return value < 10 ? value.toFixed(1) : String(Math.round(value));
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "—";
  if (value < 1024) return `${Math.round(value)}B`;
  const unit = value < 1024 * 1024 ? "K" : "M";
  const amount = unit === "K" ? value / 1024 : value / (1024 * 1024);
  return `${amount.toFixed(1).replace(/\.0$/, "")}${unit}`;
}

function formatCompressionRatio(decoded, wire) {
  if (!wire) return "—";
  return `${(decoded / wire).toFixed(2)}x`;
}

function applyPerfMode(mode) {
  const normalized = ["off", "simple", "detailed"].includes(mode) ? mode : "detailed";
  perf.dataset.mode = normalized;
  perf.hidden = normalized === "off";
  updateTelemetry();
}

function combinedState() {
  const state = terminal.state;
  Object.assign(state, transport.state, {
    selectionMode: terminal.selectionMode,
    softkeysVisible,
  });
  return state;
}

function updateTelemetry() {
  const mode = perf.dataset.mode || "detailed";
  if (mode === "off") return;
  const state = combinedState();
  const atlasUsed = state.atlasGlyphs ?? 0;
  const atlasCapacity = state.atlasCapacity ?? 0;
  const atlasPercent = atlasCapacity ? Math.round(atlasUsed * 100 / atlasCapacity) : 0;
  const cacheHits = state.cacheHits ?? 0;
  const cacheMisses = state.cacheMisses ?? 0;
  const line = mode === "simple"
    ? `R: ${formatBytes(state.rxWireBytes)} · S: ${formatBytes(state.txBytes)} · WS RTT: ${formatMs(state.wsRttLatestMs)} ms · WASM: ${formatMs(state.wasmFrameMs)} ms`
    : [
      `WASM frame: ${formatMs(state.wasmFrameMs)} ms · parse: ${formatMs(state.wasmParseMs)} ms`,
      `GPU submit: ${formatMs(state.frameMs)} ms · presentation opportunity: ${formatMs(state.presentationOpportunityMs)} ms`,
      `Queue drain: ${formatMs(state.queueDrainMs)} ms`,
      `Socket → frame: ${formatMs(state.rxLatencyMs)} ms · Input → echo frame: ${formatMs(state.inputLatencyMs)} ms`,
      `WebSocket RTT latest / median / p95: ${formatMs(state.wsRttLatestMs)} / ${formatMs(state.wsRttMedianMs)} / ${formatMs(state.wsRttP95Ms)} ms`,
      `Viewport: ${state.cols} × ${state.rows} · cell: ${state.physicalCellWidth}x${state.physicalCellHeight} px · font: ${state.physicalFontSize} px · Glyph atlas: ${atlasUsed} / ${atlasCapacity} (${atlasPercent}%) · cache: ${cacheHits} hit / ${cacheMisses} miss`,
      `Network received: ${formatBytes(state.rxBytes)} decoded · wire: ${formatBytes(state.rxWireBytes)} · compression: ${formatCompressionRatio(state.rxBytes, state.rxWireBytes)} · sent: ${formatBytes(state.txBytes)}`,
    ].join("\n");
  perf.value = line;
  const description = `WASM frame ${formatMs(state.wasmFrameMs)} ms; WASM parse ${formatMs(state.wasmParseMs)} ms; presentation opportunity ${formatMs(state.presentationOpportunityMs)} ms; queue drain ${formatMs(state.queueDrainMs)} ms; Socket → frame ${formatMs(state.rxLatencyMs)} ms; Input → echo frame ${formatMs(state.inputLatencyMs)} ms; WebSocket RTT latest / median / p95 ${formatMs(state.wsRttLatestMs)} / ${formatMs(state.wsRttMedianMs)} / ${formatMs(state.wsRttP95Ms)} ms; terminal ${state.cols} by ${state.rows}; atlas ${atlasUsed} of ${atlasCapacity} (${atlasPercent}%); down ${formatBytes(state.rxBytes)} decoded, ${formatBytes(state.rxWireBytes)} wire (${formatCompressionRatio(state.rxBytes, state.rxWireBytes)}), up ${formatBytes(state.txBytes)}; CPU submit ${formatMs(state.frameMs)} ms; canvas ${screen.width} by ${screen.height} pixels`;
  perf.title = description;
  perf.setAttribute("aria-label", description);
}

setConnectionStatus(false, "connecting");
try {
  await terminal.open(terminalElement);
  transport.connect();
} catch (error) {
  setConnectionStatus(false, error?.message || "terminal error");
  throw error;
}
applyPerfMode(settings.perfMode);
updateTelemetry();
setInterval(updateTelemetry, 250);
maybeShowNotificationPrompt();

window.bcwebmux = {
  get connected() { return transport.state.connected; },
  get selectionMode() { return terminal.selectionMode; },
  enterSelectionMode() { return terminal.enterSelectionMode(); },
  exitSelectionMode() { return terminal.exitSelectionMode(); },
  get state() { return combinedState(); },
  get inputTrace() { return terminal.inputTrace; },
  selectionText() { return terminal.getSelection(); },
  copySelection() { return terminal.copySelection(); },
  write(text) { terminal.input(text); },
  paste(text) { terminal.paste(text); },
};
if (query.has("gpu-test")) {
  window.bcwebmux.readPixels = () => terminal.readPixels();
}
