// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (!message.id) return void this.events.push(message);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new Cdp(socket);
  }

  call(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close() { this.socket.close(); }
}

const [serverPath, webRoot, outputArgument] = process.argv.slice(2);
assert.ok(serverPath && webRoot, "usage: session-ui-e2e.mjs SERVER WEB_ROOT [SCREENSHOT_DIR]");
const screenshotDir = outputArgument || process.env.BCWEBMUX_SCREENSHOT_DIR || path.join(os.tmpdir(), "bcwebmux-layer4-screenshots");
const serverPort = await freePort();
const debugPort = await freePort();
const base = `http://127.0.0.1:${serverPort}`;
const profile = await mkdtemp(path.join(os.tmpdir(), "bcwebmux-session-ui-"));
let server;
let serverError;
let serverLog = "";
let chromium;
let chromiumError;
let page;
let browser;
let cleanupPromise = null;

process.once("SIGTERM", () => void cleanup().finally(() => process.exit(124)));
process.once("SIGINT", () => void cleanup().finally(() => process.exit(130)));

try {
  server = spawn(serverPath, ["--web-root", webRoot, "--port", String(serverPort), "--origin", base], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  server.detachedGroup = true;
  server.stdout.on("data", data => { serverLog += data; });
  server.stderr.on("data", data => { serverLog += data; });
  server.on("error", error => { serverError = error; });
  await mkdir(screenshotDir, { recursive: true });
  await waitFor(async () => {
    if (serverError) throw serverError;
    return (await fetch(`${base}/api/server`).catch(() => null))?.ok;
  }, 10000, "server failed to start");
  chromium = spawn(process.env.CHROMIUM || "chromium", [
    "--headless=new",
    "--window-size=1024,720",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--enable-unsafe-webgpu",
    "--use-angle=vulkan",
    "--ignore-gpu-blocklist",
    "--enable-features=Vulkan",
    "--disable-background-networking",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    `${base}/?session-test=1`,
  ], { stdio: ["ignore", "ignore", "pipe"], detached: true });
  chromium.detachedGroup = true;
  chromium.on("error", error => { chromiumError = error; });

  const target = await waitFor(async () => {
    if (chromiumError) throw chromiumError;
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`).catch(() => null);
    if (!response?.ok) return null;
    return (await response.json()).find(item => item.type === "page" && item.url.includes("session-test=1"));
  }, 15000, "Chromium did not expose session UI page");
  const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
  browser = await Cdp.connect(version.webSocketDebuggerUrl);
  page = await Cdp.connect(target.webSocketDebuggerUrl);
  await page.call("Runtime.enable");
  await page.call("Page.enable");

  await waitBrowser("window.bcwebmux?.connected === true", 12000, "initial UI attachment did not become live");
  await waitBrowser("window.bcwebmux.drawerState.open === true && window.bcwebmux.drawerState.narrow === false", 3000, "wide drawer did not default open");
  await evaluate("document.querySelector('#notification-dialog')?.open && document.querySelector('#notification-dialog-later').click()");
  await waitBrowser("!document.querySelector('#notification-dialog')?.open", 1000, "notification dialog did not close");
  const firstId = await evaluate("window.bcwebmux.activeSessionId");
  await evaluate(`window.bcwebmux.write("A=L4-; printf '\\\\033]0;ALPHA\\\\007'; echo \${A}ALPHA; (sleep 4; printf '\\\\033]0;INACTIVE-ALPHA\\\\007'; echo \${A}INACTIVE)&\\n")`);
  await waitBrowser("window.bcwebmux.sessionText().includes('L4-ALPHA')", 5000, "first session output missing");
  await screenshot("session-drawer-wide.png");

  await evaluate("document.querySelector('#session-new').click()");
  await waitBrowser(`window.bcwebmux.sessions.length === 2 && window.bcwebmux.activeSessionId !== ${JSON.stringify(firstId)} && window.bcwebmux.connected`, 10000, "new session did not activate");
  const secondId = await evaluate("window.bcwebmux.activeSessionId");
  await evaluate(`window.bcwebmux.write("B=L4-; printf '\\\\033]0;BETA\\\\007'; echo \${B}BETA\\n")`);
  await waitBrowser("window.bcwebmux.sessionText().includes('L4-BETA')", 5000, "second session output missing");
  try {
    await waitBrowser(`document.querySelector('.session-row[data-session-id="${firstId}"] .session-unread.is-unread')`, 10000, "inactive session output did not mark the session unread");
  } catch (error) {
    const diagnostic = await evaluate(`(() => {
      const row = document.querySelector('.session-row[data-session-id="${firstId}"]');
      return {
        sessions: window.bcwebmux.sessions,
        firstRow: row && { innerText: row.innerText, className: row.className },
      };
    })()`);
    diagnostic.firstMetadata = await sessionMetadata(firstId);
    error.message += `\nUnread diagnostic: ${JSON.stringify(diagnostic)}`;
    throw error;
  }
  const secondMetadata = await sessionMetadata(secondId);
  assert.equal(await evaluate("document.title"), secondMetadata.title || secondMetadata.name);
  assert.doesNotMatch(await evaluate("document.title"), /INACTIVE-ALPHA/);
  assert.match(await evaluate("window.bcwebmux.sessionText()"), /L4-BETA/);
  assert.deepEqual(await evaluate("window.bcwebmux.rendererIdentity"), { coreCount: 2, rendererCount: 1, deviceCount: 1, screenCount: 1, terminalCount: 1 });

  await evaluate(`document.querySelector('.session-row[data-session-id="${firstId}"] .session-tab').click()`);
  await waitBrowser(`window.bcwebmux.activeSessionId === ${JSON.stringify(firstId)} && window.bcwebmux.connected`, 10000, "tab did not switch to first session");
  assert.equal(await evaluate(`document.querySelector('.session-row[data-session-id="${firstId}"] .session-unread.is-unread') === null`), true);
  const firstText = await evaluate("window.bcwebmux.sessionText()");
  assert.match(firstText, /L4-ALPHA/);
  assert.doesNotMatch(firstText, /L4-BETA/);
  await evaluate("window.bcwebmux.enterSelectionMode()");
  await evaluate(`document.querySelector('.session-row[data-session-id="${secondId}"] .session-tab').click()`);
  await waitBrowser(`window.bcwebmux.activeSessionId === ${JSON.stringify(secondId)} && !window.bcwebmux.selectionMode`, 10000, "selection was not exited by session switch");
  assert.match(await evaluate("window.bcwebmux.sessionText()"), /L4-BETA/);

  await evaluate(`(() => { const row = document.querySelector('.session-row[data-session-id="${secondId}"]'); const rename = row.querySelector('.session-rename'); rename.focus(); rename.click(); const input = document.querySelector('#session-rename-input'); input.value = 'Renamed beta'; document.querySelector('#session-rename-save').click(); })()`);
  await waitBrowser(`window.bcwebmux.sessions.some(session => session.id === ${JSON.stringify(secondId)} && session.name === 'Renamed beta')`, 5000, "session rename did not complete");
  assert.equal(await evaluate(`document.activeElement === document.querySelector('.session-row[data-session-id="${secondId}"] .session-rename')`), true);
  await evaluate(`document.querySelector('.session-row[data-session-id="${firstId}"] .session-viewer').focus()`);
  await new Promise(resolve => setTimeout(resolve, 3500));
  assert.equal(await evaluate(`document.activeElement === document.querySelector('.session-row[data-session-id="${firstId}"] .session-viewer')`), true);

  const tabNavigation = await evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.session-tab')];
    const focused = () => document.activeElement?.dataset?.sessionId;
    tabs[0].focus();
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const down = focused();
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    const home = focused();
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    const up = focused();
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    const end = focused();
    const tablist = document.querySelector('[role="tablist"]');
    const workspace = document.querySelector('#workspace');
    const selected = [...document.querySelectorAll('#session-tabs > .session-row > [role="tab"][aria-selected="true"]')];
    return {
      down,
      home,
      up,
      end,
      zero: tabs.filter(tab => tab.tabIndex === 0).length,
      tablistRole: tablist?.getAttribute('role'),
      tablistOrientation: tablist?.getAttribute('aria-orientation'),
      workspaceRole: workspace?.getAttribute('role'),
      workspaceLabelledby: workspace?.getAttribute('aria-labelledby'),
      selectedId: selected[0]?.id,
      selectedCount: selected.length,
    };
  })()`);
  assert.equal(tabNavigation.down, secondId);
  assert.equal(tabNavigation.home, firstId);
  assert.equal(tabNavigation.up, secondId);
  assert.equal(tabNavigation.end, secondId);
  assert.equal(tabNavigation.zero, 1);
  assert.equal(tabNavigation.tablistRole, "tablist");
  assert.equal(tabNavigation.tablistOrientation, "vertical");
  assert.equal(tabNavigation.workspaceRole, "tabpanel");
  assert.equal(tabNavigation.workspaceLabelledby, tabNavigation.selectedId);
  assert.ok(tabNavigation.selectedId);
  assert.equal(tabNavigation.selectedCount, 1);

  const controls = await evaluate(`(() => {
    const selectors = ['#session-toggle', '#session-new', '#session-control', '.session-viewer', '.session-rename', '.session-lifecycle'];
    return {
      sizes: selectors.map(selector => { const rect = document.querySelector(selector).getBoundingClientRect(); return [rect.width, rect.height]; }),
      nested: document.querySelectorAll('button button, button a, [role=tab] button').length,
    };
  })()`);
  assert.equal(controls.nested, 0);
  for (const [width, height] of controls.sizes) assert.ok(width >= 44 && height >= 44, `undersized session control ${width}x${height}`);

  await metrics(720);
  await waitBrowser("window.bcwebmux.drawerState.narrow && !window.bcwebmux.drawerState.open", 3000, "720px drawer did not default closed");
  await new Promise(resolve => setTimeout(resolve, 400));
  const narrowMetadata = await sessionMetadata(secondId);
  const geometryBeforeNarrow = narrowMetadata.geometry;
  const narrowClosedWidth = await evaluate("document.querySelector('#workspace').getBoundingClientRect().width");
  await evaluate("document.querySelector('#session-toggle').focus(); document.querySelector('#session-toggle').click()");
  await waitBrowser("window.bcwebmux.drawerState.open", 1000, "narrow drawer did not open");
  assert.deepEqual(await evaluate(`(() => ({
    workspace: document.querySelector('#workspace').inert,
    toggle: document.querySelector('#session-toggle').inert,
    viewport: document.querySelector('#terminal-viewport').inert,
    settings: document.querySelector('#settings-button').inert,
  }))()`), { workspace: false, toggle: false, viewport: true, settings: true });
  const narrowOpenWidth = await evaluate("document.querySelector('#workspace').getBoundingClientRect().width");
  assert.equal(narrowOpenWidth, narrowClosedWidth, "narrow drawer changed terminal width");
  await screenshot("session-drawer-narrow.png");
  await new Promise(resolve => setTimeout(resolve, 400));
  const narrowOpenMetadata = await sessionMetadata(secondId);
  assert.deepEqual(narrowOpenMetadata.geometry, geometryBeforeNarrow, "narrow overlay proposed canonical resize");
  assert.equal(narrowOpenMetadata.revision, narrowMetadata.revision, "narrow overlay journaled a redundant resize");
  await evaluate("document.querySelector('#session-backdrop').click()");
  await waitBrowser("!window.bcwebmux.drawerState.open && document.activeElement?.id === 'session-toggle'", 1000, "backdrop did not close and restore focus");
  assert.deepEqual(await evaluate(`({
    viewport: document.querySelector('#terminal-viewport').inert,
    settings: document.querySelector('#settings-button').inert,
  })`), { viewport: false, settings: false });
  await evaluate("window.bcwebmux.resetDrawerPreference()");
  await metrics(719);
  assert.equal(await evaluate("window.bcwebmux.drawerState.open"), false);
  await metrics(721);
  await waitBrowser("!window.bcwebmux.drawerState.narrow && window.bcwebmux.drawerState.open", 2000, "721px drawer did not default docked open");
  const docked = await evaluate("document.querySelector('#workspace').getBoundingClientRect().left");
  assert.ok(docked >= 238, `docked drawer width was ${docked}`);

  await new Promise(resolve => setTimeout(resolve, 400));
  const openMetadata = await sessionMetadata(secondId);
  const openGeometry = openMetadata.geometry;
  await evaluate("document.querySelector('#session-toggle').click()");
  await waitBrowser("!window.bcwebmux.drawerState.open", 1000, "wide drawer did not close");
  await waitFor(async () => (await sessionGeometry(secondId)).cols > openGeometry.cols, 5000, "wide drawer close did not resize controller PTY");
  await new Promise(resolve => setTimeout(resolve, 250));
  const closedMetadata = await sessionMetadata(secondId);
  const closedGeometry = closedMetadata.geometry;
  assert.equal(closedMetadata.revision, openMetadata.revision + 1, JSON.stringify({ openMetadata, closedMetadata }));
  await evaluate("document.querySelector('#session-toggle').click()");
  await waitFor(async () => (await sessionGeometry(secondId)).cols < closedGeometry.cols, 5000, "wide drawer open did not resize controller PTY");
  await new Promise(resolve => setTimeout(resolve, 250));
  const reopenedMetadata = await sessionMetadata(secondId);
  assert.equal(reopenedMetadata.revision, closedMetadata.revision + 1, JSON.stringify({ openMetadata, closedMetadata, reopenedMetadata }));

  await evaluate("document.querySelector('#session-toggle').click()");
  await waitBrowser("!window.bcwebmux.drawerState.open", 1000, "wide drawer did not close before reload");
  assert.equal(await evaluate("window.bcwebmux.drawerState.open"), false);
  await page.call("Page.reload", { ignoreCache: true });
  await waitBrowser(`window.bcwebmux?.connected && window.bcwebmux.activeSessionId === ${JSON.stringify(secondId)}`, 12000, "last selected session was not restored");
  await waitBrowser("!window.bcwebmux.drawerState.narrow && !window.bcwebmux.drawerState.open", 2000, "wide drawer did not restore closed");
  await evaluate("document.querySelector('#session-toggle').click()");
  await waitBrowser("window.bcwebmux.drawerState.open", 1000, "restored wide drawer did not open");
  assert.equal((await evaluate("window.bcwebmux.sessions")).length, 2);

  await evaluate("window.__bcwebmuxCoreCountMax = window.bcwebmux.rendererIdentity.coreCount; window.__bcwebmuxCoreCountTimer = setInterval(() => { window.__bcwebmuxCoreCountMax = Math.max(window.__bcwebmuxCoreCountMax, window.bcwebmux.rendererIdentity.coreCount); }, 5)");
  for (const name of ["Gamma", "Delta", "Epsilon"]) {
    await evaluate(`window.bcwebmux.createSession({ name: ${JSON.stringify(name)} })`);
    await waitBrowser(`window.bcwebmux.sessions.some(session => session.name === ${JSON.stringify(name)}) && window.bcwebmux.connected`, 10000, `session ${name} did not activate`);
  }
  const sampledCoreCount = await evaluate("clearInterval(window.__bcwebmuxCoreCountTimer); window.__bcwebmuxCoreCountMax");
  assert.ok(sampledCoreCount <= 4, `sampled local core LRU exceeded its bound: ${sampledCoreCount}`);
  const lruIdentity = await evaluate("window.bcwebmux.rendererIdentity");
  assert.ok(lruIdentity.coreCount <= 4, "local core LRU exceeded its bound");
  assert.deepEqual(lruIdentity, { coreCount: lruIdentity.coreCount, rendererCount: 1, deviceCount: 1, screenCount: 1, terminalCount: 1 });
  await evaluate(`window.bcwebmux.switchSession(${JSON.stringify(firstId)})`);
  await waitBrowser(`window.bcwebmux.activeSessionId === ${JSON.stringify(firstId)} && window.bcwebmux.connected`, 10000, "cold session did not reload");
  assert.match(await evaluate("window.bcwebmux.sessionText()"), /L4-ALPHA/);

  await evaluate(`window.bcwebmux.switchSession(${JSON.stringify(secondId)})`);
  await waitBrowser(`window.bcwebmux.activeSessionId === ${JSON.stringify(secondId)} && window.bcwebmux.connected`, 10000, "lifecycle target did not activate");
  assert.match(await evaluate("window.bcwebmux.sessionText()"), /L4-BETA/);
  await evaluate(`(() => { const lifecycle = document.querySelector('.session-row[data-session-id="${secondId}"] .session-lifecycle'); lifecycle.focus(); lifecycle.click(); })()`);
  await waitBrowser("document.querySelector('#session-action-dialog').open", 1000, "termination confirmation did not open");
  await evaluate("document.querySelector('#session-action-confirm').click()");
  await waitBrowser(`window.bcwebmux.sessions.some(session => session.id === ${JSON.stringify(secondId)} && session.state === 'exited')`, 8000, "session did not exit through UI");
  await evaluate(`(() => { const lifecycle = document.querySelector('.session-row[data-session-id="${secondId}"] .session-lifecycle'); lifecycle.focus(); lifecycle.click(); })()`);
  await waitBrowser("document.querySelector('#session-action-dialog').open", 1000, "remove confirmation did not open");
  await evaluate("document.querySelector('#session-action-confirm').click()");
  try {
    await waitBrowser(`!window.bcwebmux.sessions.some(session => session.id === ${JSON.stringify(secondId)}) && window.bcwebmux.activeSessionId !== null && window.bcwebmux.activeSessionId !== ${JSON.stringify(secondId)} && window.bcwebmux.connected`, 10000, "active exited session was not removed with renderer fallback");
  } catch (error) {
    const diagnostic = await evaluate(`(() => {
      const active = document.activeElement;
      return {
        activeSessionId: window.bcwebmux.activeSessionId,
        connected: window.bcwebmux.connected,
        sessions: window.bcwebmux.sessions,
        activeElement: { className: active?.className, sessionId: active?.dataset?.sessionId },
      };
    })()`);
    error.message += `\nActive delete diagnostic: ${JSON.stringify(diagnostic)}`;
    throw error;
  }
  const actualFallbackId = await evaluate("window.bcwebmux.activeSessionId");
  assert.ok(await evaluate(`window.bcwebmux.sessions.some(session => session.id === ${JSON.stringify(actualFallbackId)})`));
  assert.equal(await evaluate(`document.activeElement === document.querySelector('.session-row[data-session-id="${actualFallbackId}"] .session-tab')`), true);

  const exceptions = page.events.filter(event => event.method === "Runtime.exceptionThrown");
  assert.deepEqual(exceptions, [], JSON.stringify(exceptions));
  console.log(JSON.stringify({ screenshots: screenshotDir, sessions: (await evaluate("window.bcwebmux.sessions")).length }));
} catch (error) {
  error.message += `\nScreenshots: ${screenshotDir}\nServer log:\n${serverLog}`;
  throw error;
} finally {
  await cleanup();
}

async function evaluate(expression) {
  const response = await page.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || "browser evaluation failed");
  return response.result.value;
}

async function waitBrowser(expression, timeout, message) {
  return waitFor(async () => Boolean(await evaluate(expression).catch(() => false)), timeout, message);
}

async function metrics(width) {
  await page.call("Emulation.setDeviceMetricsOverride", { width, height: 720, deviceScaleFactor: 1, mobile: false });
  await waitBrowser(`window.innerWidth === ${width}`, 1000, `viewport did not become ${width}px`);
}

async function sessionGeometry(id) {
  return (await sessionMetadata(id)).geometry;
}

async function sessionMetadata(id) {
  const response = await fetch(`${base}/api/sessions/${id}`);
  assert.equal(response.status, 200);
  return response.json();
}

async function screenshot(name) {
  const capture = await page.call("Page.captureScreenshot", { format: "png", fromSurface: true });
  await writeFile(path.join(screenshotDir, name), Buffer.from(capture.data, "base64"));
}

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function waitFor(check, timeout, message) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

function signalProcess(child, signal) {
  if (child.detachedGroup) {
    try {
      globalThis.process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  child.kill(signal);
}

function processGroupAlive(child) {
  if (!child?.detachedGroup || child.pid == null) return false;
  try {
    globalThis.process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateProcess(child) {
  if (!child) return;
  const leaderRunning = child.exitCode === null;
  if (leaderRunning || processGroupAlive(child)) {
    signalProcess(child, "SIGTERM");
  }
  if (leaderRunning) {
    await Promise.race([
      new Promise(resolve => child.once("exit", resolve)),
      new Promise(resolve => setTimeout(resolve, 1000)),
    ]);
  }
  if (processGroupAlive(child)) {
    signalProcess(child, "SIGKILL");
    await Promise.race([
      new Promise(resolve => child.once("exit", resolve)),
      new Promise(resolve => setTimeout(resolve, 100)),
    ]);
  } else if (!child.detachedGroup && child.exitCode === null) {
    signalProcess(child, "SIGKILL");
    await Promise.race([
      new Promise(resolve => child.once("exit", resolve)),
      new Promise(resolve => setTimeout(resolve, 1000)),
    ]);
  }
}

async function cleanup() {
  if (!cleanupPromise) {
    cleanupPromise = (async () => {
      try { page?.close(); } catch {}
      try { browser?.close(); } catch {}
      await terminateProcess(chromium);
      await terminateProcess(server);
      await rm(profile, { recursive: true, force: true });
    })();
  }
  return cleanupPromise;
}
