// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { Terminal } from "/wgpuTerminal/src/index.js";
import { SessionApi } from "./SessionApi.js";
import { SessionController } from "./SessionController.js";
import { SessionDrawer } from "./SessionDrawer.js";
import { SessionTransport } from "./SessionTransport.js";
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
if (query.has("gpu-test")) document.querySelector("#session-toggle").hidden = true;

let softkeysVisibilityOverride = null;
let softkeysVisible = false;
let pendingLinkUri = null;
let appReady = false;
let lastTelemetryLine = null;
let lastTelemetryDescription = null;

async function openInitialSession() {
  await terminal.open(terminalElement);
  if (query.has("gpu-test")) return openGpuTestSession();
  await sessionController.start();
  activeAttachment = sessionController.activeAttachment;
  drawer.setStorageScope(sessionController.storageScope);
  drawer.render();
  if (activeAttachment?.metadata?.state === "running") {
    for (let elapsed = 0; elapsed < 3000 && !activeAttachment.controller; elapsed += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeAttachment = sessionController.activeAttachment;
    }
    if (!activeAttachment.controller) throw new Error("session controller timeout");
  }
}

async function openGpuTestSession() {
  const connectPromise = transport.connect();
  const [info, sessionList] = await Promise.all([sessionApi.info(), sessionApi.list()]);
  await connectPromise;
  if (info?.protocol !== "bcw.sessions") throw new Error("unsupported session protocol");
  let selected = sessionList.sessions.find((session) => session.state === "running");
  if (!selected) {
    const state = terminal.state;
    const cellWidth = Number.isFinite(state.physicalCellWidth) && state.physicalCellWidth > 0
      ? Math.round(state.physicalCellWidth) : 8;
    const cellHeight = Number.isFinite(state.physicalCellHeight) && state.physicalCellHeight > 0
      ? Math.round(state.physicalCellHeight) : 16;
    selected = await sessionApi.create({
      profile: "shell",
      name: "Shell",
      geometry: {
        cols: terminal.cols,
        rows: terminal.rows,
        cellWidthPx: cellWidth,
        cellHeightPx: cellHeight,
      },
    });
  }
  activeAttachment = await transport.attach(selected, terminal.core);
  transport.setActive(activeAttachment);
  if (selected.state === "running") {
    for (let elapsed = 0; elapsed < 3000 && !activeAttachment.controller; elapsed += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!activeAttachment.controller) throw new Error("session controller timeout");
  }
}

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
  canonicalGeometry: true,
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
const sessionApi = new SessionApi();
const transport = new SessionTransport();
transport.activate(terminal);
const sessionController = new SessionController({
  terminal,
  api: sessionApi,
  transport,
  coreLimit: 4,
});
let activeAttachment = null;
const drawer = new SessionDrawer({
  controller: sessionController,
  elements: {
    drawer: document.querySelector("#session-drawer"),
    shell: document.querySelector("#app-shell"),
    tabs: document.querySelector("#session-tabs"),
    newButton: document.querySelector("#session-new"),
    toggleButton: document.querySelector("#session-toggle"),
    controlButton: document.querySelector("#session-control"),
    workspace: document.querySelector("#workspace"),
    backdrop: document.querySelector("#session-backdrop"),
    liveRegion: document.querySelector("#session-live-region"),
    renameDialog: document.querySelector("#session-rename-dialog"),
    renameInput: document.querySelector("#session-rename-input"),
    renameForm: document.querySelector("#session-rename-dialog form"),
    renameCancel: document.querySelector("#session-rename-cancel"),
    renameSubmit: document.querySelector("#session-rename-save"),
    confirmDialog: document.querySelector("#session-action-dialog"),
    confirmMessage: document.querySelector("#session-action-message"),
    confirmCancel: document.querySelector("#session-action-cancel"),
    confirmSubmit: document.querySelector("#session-action-confirm"),
  },
});
drawer.init();
if (query.has("gpu-test")) drawer.close();
sessionController.onChange(() => {
  activeAttachment = sessionController.activeAttachment;
  const count = sessionController.sessions.length;
  document.querySelector("#session-drawer-status").textContent =
    `${count} ${count === 1 ? "SESSION" : "SESSIONS"}`;
});
sessionController.onActiveChange(() => {
  activeAttachment = sessionController.activeAttachment;
});
terminal.onError((error) => setConnectionStatus(false, error?.message || "terminal error"));
terminal.onTitleChange((title) => { document.title = title || "bcwebmux"; });
terminal.onBell(() => {
  terminalElement.classList.add("flash");
  setTimeout(() => terminalElement.classList.remove("flash"), 80);
});
terminal.onNotification(({ title, body }) => showDesktopNotification(title, body));
sessionController.onTitleChange((title, metadata) => {
  document.title = title || metadata?.name || "bcwebmux";
});
sessionController.onNotification(({ title, body }, metadata, active) => {
  if (!active) showDesktopNotification(metadata?.name || metadata?.title || title || "bcwebmux", title ? `${title}: ${body}` : body);
});
sessionController.onError((error, global) => {
  if (global) setConnectionStatus(false, error?.message || "session error");
});
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
    activeSessionId: activeAttachment?.metadata?.id ?? activeAttachment?.sessionId ?? activeAttachment?.id ?? null,
    sessionState: activeAttachment?.metadata?.state ?? null,
    controller: activeAttachment?.controller ?? null,
    connected: transport.state.connected && !!activeAttachment?.live &&
      (activeAttachment?.metadata?.state !== "running" || !!activeAttachment?.controller),
  });
  return state;
}

function updateTelemetry() {
  const mode = perf.dataset.mode || "detailed";
  if (document.hidden || mode === "off") return;
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
  if (line !== lastTelemetryLine) {
    perf.value = line;
    lastTelemetryLine = line;
  }
  const description = `WASM frame ${formatMs(state.wasmFrameMs)} ms; WASM parse ${formatMs(state.wasmParseMs)} ms; presentation opportunity ${formatMs(state.presentationOpportunityMs)} ms; queue drain ${formatMs(state.queueDrainMs)} ms; Socket → frame ${formatMs(state.rxLatencyMs)} ms; Input → echo frame ${formatMs(state.inputLatencyMs)} ms; WebSocket RTT latest / median / p95 ${formatMs(state.wsRttLatestMs)} / ${formatMs(state.wsRttMedianMs)} / ${formatMs(state.wsRttP95Ms)} ms; terminal ${state.cols} by ${state.rows}; atlas ${atlasUsed} of ${atlasCapacity} (${atlasPercent}%); down ${formatBytes(state.rxBytes)} decoded, ${formatBytes(state.rxWireBytes)} wire (${formatCompressionRatio(state.rxBytes, state.rxWireBytes)}), up ${formatBytes(state.txBytes)}; CPU submit ${formatMs(state.frameMs)} ms; canvas ${screen.width} by ${screen.height} pixels`;
  if (description !== lastTelemetryDescription) {
    perf.title = description;
    perf.setAttribute("aria-label", description);
    lastTelemetryDescription = description;
  }
}

window.bcwebmux = {
  get connected() {
    return appReady && transport.state.connected && !!activeAttachment?.live &&
      (activeAttachment?.metadata?.state !== "running" || !!activeAttachment?.controller);
  },
  get activeSessionId() {
    return activeAttachment?.metadata?.id ?? activeAttachment?.sessionId ?? activeAttachment?.id ?? null;
  },
  get attachmentState() { return activeAttachment?.state ?? null; },
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
if (query.has("session-test")) {
  Object.defineProperties(window.bcwebmux, {
    sessionText: {
      value() {
        const core = terminal.core;
        core.setSelectionRange({ row: 0, col: 0 }, { row: core.rows - 1, col: core.cols });
        try {
          return core.getSelection() || "";
        } finally {
          core.clearSelection();
        }
      },
    },
    coreCount: {
      get() { return terminal.coreCount; },
    },
    clientInstanceId: {
      get() { return transport.clientInstanceId; },
    },
    sessions: {
      get() {
        return sessionController.sessions.map((metadata) => ({ ...metadata }));
      },
    },
    drawerState: {
      get() { return drawer.state; },
    },
    createSession: {
      value(options) { return sessionController.create(options); },
    },
    switchSession: {
      value(id) { return sessionController.switchTo(id); },
    },
    renameSession: {
      value(id, name) { return sessionController.rename(id, name); },
    },
    terminateSession: {
      value(id) { return sessionController.terminate(id); },
    },
    deleteSession: {
      value(id) { return sessionController.delete(id); },
    },
    claimControl: {
      value() { return sessionController.claim(); },
    },
    refreshSessions: {
      value() { return sessionController.refresh(); },
    },
    toggleDrawer: {
      value() { return drawer.toggle(); },
    },
    openDrawer: {
      value() { return drawer.open(); },
    },
    closeDrawer: {
      value() { return drawer.close(); },
    },
    resetDrawerPreference: {
      value() { return drawer.resetPreference(); },
    },
    rendererIdentity: {
      get() {
        return {
          coreCount: terminal.coreCount,
          rendererCount: terminal._renderer ? 1 : 0,
          deviceCount: terminal._renderer?.device ? 1 : 0,
          screenCount: document.querySelectorAll("canvas#screen").length,
          terminalCount: document.querySelectorAll("#terminal").length,
        };
      },
    },
  });
}

setConnectionStatus(false, "connecting");
try {
  await openInitialSession();
} catch (error) {
  setConnectionStatus(false, error?.message || "terminal error");
  throw error;
}
applyPerfMode(settings.perfMode);
updateTelemetry();
setInterval(updateTelemetry, 250);
maybeShowNotificationPrompt();
appReady = true;
