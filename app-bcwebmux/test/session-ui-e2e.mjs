// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VideoGoldens } from "./video-goldens.mjs";
import { compareScreenshot } from "./visual-compare.mjs";
import { Cdp, freePort, terminateProcess, waitFor, delay } from "./test-support.mjs";

const [serverPath, webRoot, outputArgument] = process.argv.slice(2);
assert.ok(serverPath && webRoot, "usage: session-ui-e2e.mjs SERVER WEB_ROOT [SCREENSHOT_DIR]");
const screenshotDir =
  outputArgument ||
  process.env.BCWEBMUX_SCREENSHOT_DIR ||
  path.join(os.tmpdir(), "bcwebmux-layer4-screenshots");
const serverPort = await freePort();
const debugPort = await freePort();
const base = `http://127.0.0.1:${serverPort}`;
const profile = await mkdtemp(path.join(os.tmpdir(), "bcwebmux-session-ui-"));
const fixtureShell = path.join(profile, "fixture-shell");
let server;
let serverError;
let serverLog = "";
let chromium;
let chromiumError;
let page;
let browser;
let cleanupPromise = null;
const goldenCounts = new Map();
const stillGoldenDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "golden");
const videoGoldens = new VideoGoldens({
  goldenDir: path.join(path.dirname(fileURLToPath(import.meta.url)), "golden", "session-progress"),
  outputDir: screenshotDir,
  update: process.env.UPDATE_GOLDEN === "1",
});
let goldenStyleSheet;

process.once("SIGTERM", () => void cleanup().finally(() => process.exit(124)));
process.once("SIGINT", () => void cleanup().finally(() => process.exit(130)));

try {
  await writeFile(
    fixtureShell,
    "#!/bin/sh\nexport ENV=/dev/null BASH_ENV=/dev/null PS1='$ '\nprintf '\\033]0;Progress demo\\007'\nexec /bin/sh -i\n",
    { mode: 0o700 },
  );
  server = spawn(
    serverPath,
    [
      "--config",
      "/dev/null",
      "--auth=false",
      "--shell",
      fixtureShell,
      "--web-root",
      webRoot,
      "--listen",
      `127.0.0.1:${serverPort}`,
      "--origin",
      base,
    ],
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  server.detachedGroup = true;
  server.stdout.on("data", (data) => {
    serverLog += data;
  });
  server.stderr.on("data", (data) => {
    serverLog += data;
  });
  server.on("error", (error) => {
    serverError = error;
  });
  await mkdir(screenshotDir, { recursive: true });
  await waitFor(
    async () => {
      if (serverError) throw serverError;
      return (await fetch(`${base}/api/server`).catch(() => null))?.ok;
    },
    10000,
    "server failed to start",
  );
  chromium = spawn(
    process.env.CHROMIUM || "chromium",
    [
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
    ],
    { stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  chromium.detachedGroup = true;
  chromium.on("error", (error) => {
    chromiumError = error;
  });

  const target = await waitFor(
    async () => {
      if (chromiumError) throw chromiumError;
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`).catch(() => null);
      if (!response?.ok) return null;
      return (await response.json()).find(
        (item) => item.type === "page" && item.url.includes("session-test=1"),
      );
    },
    15000,
    "Chromium did not expose session UI page",
  );
  const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
  browser = await Cdp.connect(version.webSocketDebuggerUrl);
  page = await Cdp.connect(target.webSocketDebuggerUrl);
  await page.call("Runtime.enable");
  await page.call("Page.enable");

  await waitBrowser(
    "window.bcwebmux?.connected === true",
    12000,
    "initial UI attachment did not become live",
  );
  await waitBrowser(
    "window.bcwebmux.drawerState.open === true && window.bcwebmux.drawerState.narrow === false",
    3000,
    "wide drawer did not default open",
  );
  await evaluate(
    "document.querySelector('#notification-dialog')?.open && document.querySelector('#notification-dialog-later').click()",
  );
  await waitBrowser(
    "!document.querySelector('#notification-dialog')?.open",
    1000,
    "notification dialog did not close",
  );
  const firstId = await evaluate("window.bcwebmux.activeSessionId");
  const peerIds = await seedStatusPeers();
  await evaluate(`window.bcwebmux.switchSession(${JSON.stringify(firstId)})`);
  await waitBrowser(
    `window.bcwebmux.activeSessionId === ${JSON.stringify(firstId)} && window.bcwebmux.connected`,
    10000,
    "the progress demo session did not reactivate",
  );
  await verifyLegacyProgress(firstId);
  await verifyProgramStatus(firstId);
  await removeStatusPeers(peerIds, firstId);
  await evaluate(
    `window.bcwebmux.write("A=L4-; printf '\\\\033]0;ALPHA\\\\007'; echo \${A}ALPHA; (sleep 4; printf '\\\\033]0;INACTIVE-ALPHA\\\\007'; printf '\\\\033]7501;state=blocked:kind=permission:progress=40\\\\007\\\\033]9;4;1;73\\\\007'; echo \${A}INACTIVE)&\\n")`,
  );
  await waitBrowser(
    "window.bcwebmux.sessionText().includes('L4-ALPHA')",
    5000,
    "first session output missing",
  );
  assert.equal((await sessionMetadata(firstId)).name, "");
  await waitBrowser(
    `(() => { const session = window.bcwebmux.sessions.find(session => session.id === ${JSON.stringify(firstId)}); const title = session?.title?.trim(); const row = document.querySelector('.session-row[data-session-id="${firstId}"]'); return Boolean(title) && row?.querySelector('.session-name')?.textContent.trim() === title && document.querySelector('#terminal-identity-primary')?.textContent.trim() === title && document.querySelector('#terminal-identity-secondary')?.hidden === true; })()`,
    5000,
    "ALPHA identity was not rendered",
  );
  await screenshot("session-drawer-wide.png");

  await evaluate("document.querySelector('#session-new').click()");
  await waitBrowser(
    `window.bcwebmux.sessions.length === 2 && window.bcwebmux.activeSessionId !== ${JSON.stringify(firstId)} && window.bcwebmux.connected`,
    10000,
    "new session did not activate",
  );
  const secondId = await evaluate("window.bcwebmux.activeSessionId");
  await evaluate(
    `window.bcwebmux.write("B=L4-; printf '\\\\033]0;BETA\\\\007'; echo \${B}BETA\\n")`,
  );
  await waitBrowser(
    "window.bcwebmux.sessionText().includes('L4-BETA')",
    5000,
    "second session output missing",
  );
  assert.equal((await sessionMetadata(secondId)).name, "");
  await waitBrowser(
    `(() => { const session = window.bcwebmux.sessions.find(session => session.id === ${JSON.stringify(secondId)}); const title = session?.title?.trim(); const row = document.querySelector('.session-row[data-session-id="${secondId}"]'); return Boolean(title) && row?.querySelector('.session-name')?.textContent.trim() === title && document.querySelector('#terminal-identity-primary')?.textContent.trim() === title && document.querySelector('#terminal-identity-secondary')?.hidden === true; })()`,
    5000,
    "BETA identity was not rendered",
  );
  try {
    await waitBrowser(
      `document.querySelector('.session-row[data-session-id="${firstId}"].is-unread .session-tab')?.getAttribute('aria-label').endsWith('unread activity')`,
      10000,
      "inactive session output did not mark the session unread",
    );
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
  await waitBrowser(
    `window.bcwebmux.sessions.find(session => session.id === ${JSON.stringify(firstId)})?.programStatus?.state === 'blocked' && document.querySelector('.session-row[data-session-id="${firstId}"] .session-detail')?.textContent.includes('approval required')`,
    5000,
    "inactive card did not receive the server's program status",
  );
  await verifyStatusAnimation(firstId, "blocked", "inactive-blocked-motion");
  await verifyProgressPresentation(firstId, 40);
  assert.deepEqual((await sessionMetadata(firstId)).progressReport, { state: "set", progress: 73 });
  assert.equal(
    await evaluate("document.querySelector('#terminal-progress').hidden"),
    true,
    "inactive progress must not appear on another session's bottom bar",
  );
  await screenshot("session-drawer-program-status.png");
  assert.equal(await evaluate("document.title"), secondMetadata.title || secondMetadata.name);
  assert.doesNotMatch(await evaluate("document.title"), /INACTIVE-ALPHA/);
  assert.match(await evaluate("window.bcwebmux.sessionText()"), /L4-BETA/);
  assert.deepEqual(await evaluate("window.bcwebmux.rendererIdentity"), {
    coreCount: 2,
    rendererCount: 1,
    deviceCount: 1,
    screenCount: 1,
    terminalCount: 1,
  });

  await evaluate(
    `document.querySelector('.session-row[data-session-id="${firstId}"] .session-tab').click()`,
  );
  await waitBrowser(
    `window.bcwebmux.activeSessionId === ${JSON.stringify(firstId)} && window.bcwebmux.connected`,
    10000,
    "tab did not switch to first session",
  );
  assert.equal(
    await evaluate(
      `!document.querySelector('.session-row[data-session-id="${firstId}"] .session-tab')?.getAttribute('aria-label').endsWith('unread activity')`,
    ),
    true,
  );
  const firstText = await evaluate("window.bcwebmux.sessionText()");
  assert.match(firstText, /L4-ALPHA/);
  assert.doesNotMatch(firstText, /L4-BETA/);
  await verifyProgressPresentation(firstId, 40);
  await evaluate(
    `window.bcwebmux.write(${JSON.stringify("printf '\\033]7501;state=clear\\007'\n")})`,
  );
  await waitBrowser(
    `window.bcwebmux.sessions.find(session => session.id === ${JSON.stringify(firstId)})?.programStatus === null && document.querySelector('.session-row[data-session-id="${firstId}"] .session-detail')?.textContent === 'working · 73%'`,
    5000,
    "clearing OSC 7501 must reveal the retained OSC 9;4 report",
  );
  await verifyProgressPresentation(firstId, 73);
  await evaluate(
    `window.bcwebmux.write(${JSON.stringify("printf '\\033]7501;state=blocked:kind=permission:progress=40\\007\\033]9;4;0\\007'\n")})`,
  );
  await waitFor(
    async () => (await sessionMetadata(firstId)).progressReport === null,
    5000,
    "OSC 9;4 removal must clear its report independently",
  );
  await verifyProgressPresentation(firstId, 40);
  await evaluate(
    `window.bcwebmux.write(${JSON.stringify("(sleep 1; printf '\\033]9;4;1;73\\007'; echo background-ready)&\n")})`,
  );
  await evaluate("window.bcwebmux.enterSelectionMode()");
  await evaluate(
    `document.querySelector('.session-row[data-session-id="${secondId}"] .session-tab').click()`,
  );
  await waitBrowser(
    `window.bcwebmux.activeSessionId === ${JSON.stringify(secondId)} && !window.bcwebmux.selectionMode`,
    10000,
    "selection was not exited by session switch",
  );
  assert.match(await evaluate("window.bcwebmux.sessionText()"), /L4-BETA/);

  await waitBrowser(
    `window.bcwebmux.sessions.find(session => session.id === ${JSON.stringify(firstId)})?.unread && window.bcwebmux.sessions.find(session => session.id === ${JSON.stringify(firstId)})?.progressReport?.progress === 73`,
    5000,
    "background progress must mark the inactive session unread",
  );
  await evaluate(
    `(() => { const tab = document.querySelector('.session-row[data-session-id="${secondId}"] .session-tab'); tab.focus(); tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true })); document.querySelector('.session-context-rename').click(); const input = document.querySelector('#session-rename-input'); input.value = 'Renamed beta'; document.querySelector('#session-rename-save').click(); })()`,
  );
  await waitBrowser(
    `window.bcwebmux.sessions.some(session => session.id === ${JSON.stringify(secondId)} && session.name === 'Renamed beta')`,
    5000,
    "session rename did not complete",
  );
  await waitBrowser(
    `(() => { const session = window.bcwebmux.sessions.find(session => session.id === window.bcwebmux.activeSessionId); const title = session?.title?.trim(); const row = document.querySelector('.session-row[data-session-id="${secondId}"]'); return Boolean(title) && row?.querySelector('.session-name')?.textContent.trim() === 'Renamed beta' && document.querySelector('#terminal-identity-primary')?.textContent.trim() === 'Renamed beta' && document.querySelector('#terminal-identity-secondary')?.hidden === false && document.querySelector('#terminal-identity-secondary')?.textContent.trim() === title; })()`,
    5000,
    "renamed identity was not rendered",
  );
  assert.equal(
    await evaluate(
      `document.activeElement === document.querySelector('.session-row[data-session-id="${secondId}"] .session-tab')`,
    ),
    true,
  );
  await evaluate(
    `document.querySelector('.session-row[data-session-id="${firstId}"] .session-tab').focus()`,
  );
  await delay(3500);
  assert.equal(
    await evaluate(
      `document.activeElement === document.querySelector('.session-row[data-session-id="${firstId}"] .session-tab')`,
    ),
    true,
  );

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

  await evaluate(
    `(() => { const tab = document.querySelector('.session-row[data-session-id="${secondId}"] .session-tab'); const rect = tab.getBoundingClientRect(); tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 41, pointerType: 'touch', button: 0, buttons: 1, isPrimary: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 })); })()`,
  );
  await delay(650);
  await waitBrowser(
    `(() => { const menu = document.querySelector('#session-context-menu'); const tab = document.querySelector('.session-row[data-session-id="${secondId}"] .session-tab'); return Boolean(menu && !menu.hidden && menu.getClientRects().length && getComputedStyle(menu).visibility !== 'hidden' && getComputedStyle(menu).display !== 'none' && tab?.getAttribute('aria-expanded') === 'true' && [...menu.querySelectorAll('[role="menuitem"]')].some(item => item.textContent.trim().toUpperCase() === 'RENAME')); })()`,
    2000,
    "long press did not open session context menu",
  );
  await evaluate(
    `(() => { const tab = document.querySelector('.session-row[data-session-id="${secondId}"] .session-tab'); const rect = tab.getBoundingClientRect(); tab.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 41, pointerType: 'touch', button: 0, buttons: 0, isPrimary: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 })); })()`,
  );
  await stillGolden("session-context-menu");
  await evaluate("document.querySelector('.session-context-rename').click()");
  await waitBrowser(
    "document.querySelector('#session-rename-dialog').open",
    1000,
    "context rename dialog did not open",
  );
  await stillGolden("session-rename-dialog");
  await evaluate("document.querySelector('#session-rename-cancel').click()");
  await waitBrowser(
    "!document.querySelector('#session-rename-dialog').open",
    1000,
    "context rename dialog did not close",
  );

  await metrics(720);
  await waitBrowser(
    "window.bcwebmux.drawerState.narrow && !window.bcwebmux.drawerState.open",
    3000,
    "720px drawer did not default closed",
  );
  await delay(400);
  const narrowMetadata = await sessionMetadata(secondId);
  const geometryBeforeNarrow = narrowMetadata.geometry;
  const narrowClosedWidth = await evaluate(
    "document.querySelector('#workspace').getBoundingClientRect().width",
  );
  await evaluate(
    "document.querySelector('#session-toggle').focus(); document.querySelector('#session-toggle').click()",
  );
  await waitBrowser("window.bcwebmux.drawerState.open", 1000, "narrow drawer did not open");
  assert.deepEqual(
    await evaluate(`(() => ({
    workspace: document.querySelector('#workspace').inert,
    toggle: document.querySelector('#session-toggle').inert,
    viewport: document.querySelector('#terminal-viewport').inert,
    settings: document.querySelector('#settings-button').inert,
  }))()`),
    { workspace: false, toggle: false, viewport: true, settings: true },
  );
  const narrowOpenWidth = await evaluate(
    "document.querySelector('#workspace').getBoundingClientRect().width",
  );
  assert.equal(narrowOpenWidth, narrowClosedWidth, "narrow drawer changed terminal width");
  await screenshot("session-drawer-narrow.png");
  await delay(400);
  const narrowOpenMetadata = await sessionMetadata(secondId);
  assert.deepEqual(
    narrowOpenMetadata.geometry,
    geometryBeforeNarrow,
    "narrow overlay proposed canonical resize",
  );
  assert.equal(
    narrowOpenMetadata.revision,
    narrowMetadata.revision,
    "narrow overlay journaled a redundant resize",
  );
  await evaluate(`window.bcwebmux.write(${JSON.stringify("printf '\\033]9;4;1;65\\007'\n")})`);
  await waitFor(
    async () => (await sessionMetadata(secondId)).progressReport?.progress === 65,
    5000,
    "mobile progress report missing",
  );
  await verifyProgressPresentation(secondId, 65);
  await evaluate(`window.bcwebmux.write(${JSON.stringify("printf '\\033]9;4;0\\007'\n")})`);
  await waitFor(
    async () => (await sessionMetadata(secondId)).progressReport === null,
    5000,
    "mobile progress removal missing",
  );
  await evaluate("document.querySelector('#session-backdrop').click()");
  await waitBrowser(
    "!window.bcwebmux.drawerState.open && document.activeElement?.id === 'session-toggle'",
    1000,
    "backdrop did not close and restore focus",
  );
  assert.deepEqual(
    await evaluate(`({
    viewport: document.querySelector('#terminal-viewport').inert,
    settings: document.querySelector('#settings-button').inert,
  })`),
    { viewport: false, settings: false },
  );
  await evaluate("window.bcwebmux.resetDrawerPreference()");
  await metrics(719);
  assert.equal(await evaluate("window.bcwebmux.drawerState.open"), false);
  await metrics(721);
  await waitBrowser(
    "!window.bcwebmux.drawerState.narrow && window.bcwebmux.drawerState.open",
    2000,
    "721px drawer did not default docked open",
  );
  const docked = await evaluate(
    "document.querySelector('#workspace').getBoundingClientRect().left",
  );
  assert.ok(docked >= 238, `docked drawer width was ${docked}`);

  await delay(400);
  const openMetadata = await sessionMetadata(secondId);
  const openGeometry = openMetadata.geometry;
  await evaluate("document.querySelector('#session-toggle').click()");
  await waitBrowser("!window.bcwebmux.drawerState.open", 1000, "wide drawer did not close");
  await waitFor(
    async () => (await sessionGeometry(secondId)).cols > openGeometry.cols,
    5000,
    "wide drawer close did not resize controller PTY",
  );
  await delay(250);
  const closedMetadata = await sessionMetadata(secondId);
  const closedGeometry = closedMetadata.geometry;
  assert.equal(
    closedMetadata.revision,
    openMetadata.revision + 1,
    JSON.stringify({ openMetadata, closedMetadata }),
  );
  await evaluate("document.querySelector('#session-toggle').click()");
  await waitFor(
    async () => (await sessionGeometry(secondId)).cols < closedGeometry.cols,
    5000,
    "wide drawer open did not resize controller PTY",
  );
  await delay(250);
  const reopenedMetadata = await sessionMetadata(secondId);
  assert.equal(
    reopenedMetadata.revision,
    closedMetadata.revision + 1,
    JSON.stringify({ openMetadata, closedMetadata, reopenedMetadata }),
  );

  await evaluate("document.querySelector('#session-toggle').click()");
  await waitBrowser(
    "!window.bcwebmux.drawerState.open",
    1000,
    "wide drawer did not close before reload",
  );
  assert.equal(await evaluate("window.bcwebmux.drawerState.open"), false);
  goldenStyleSheet = null;
  await page.call("Page.reload", { ignoreCache: true });
  await waitBrowser(
    `window.bcwebmux?.connected && window.bcwebmux.activeSessionId === ${JSON.stringify(secondId)}`,
    12000,
    "last selected session was not restored",
  );
  await waitBrowser(
    "!window.bcwebmux.drawerState.narrow && !window.bcwebmux.drawerState.open",
    2000,
    "wide drawer did not restore closed",
  );
  await evaluate("document.querySelector('#session-toggle').click()");
  await waitBrowser("window.bcwebmux.drawerState.open", 1000, "restored wide drawer did not open");
  assert.equal((await evaluate("window.bcwebmux.sessions")).length, 2);
  await waitBrowser(
    `document.querySelector('.session-row[data-session-id="${firstId}"] .session-detail')?.textContent.includes('approval required')`,
    5000,
    "reloaded browser did not hydrate the inactive session's program status",
  );
  await waitBrowser(
    `window.bcwebmux.sessions.find(session => session.id === ${JSON.stringify(firstId)})?.progressReport?.progress === 73`,
    5000,
    "reloaded browser did not hydrate inactive OSC 9;4 progress",
  );
  await verifyProgressPresentation(firstId, 40);

  await evaluate(
    "window.__bcwebmuxCoreCountMax = window.bcwebmux.rendererIdentity.coreCount; window.__bcwebmuxCoreCountTimer = setInterval(() => { window.__bcwebmuxCoreCountMax = Math.max(window.__bcwebmuxCoreCountMax, window.bcwebmux.rendererIdentity.coreCount); }, 5)",
  );
  for (const name of ["Gamma", "Delta", "Epsilon"]) {
    await evaluate(`window.bcwebmux.createSession({ name: ${JSON.stringify(name)} })`);
    await waitBrowser(
      `window.bcwebmux.sessions.some(session => session.name === ${JSON.stringify(name)}) && window.bcwebmux.connected`,
      10000,
      `session ${name} did not activate`,
    );
    if (name === "Gamma") await stillGolden("session-drawer");
  }
  const sampledCoreCount = await evaluate(
    "clearInterval(window.__bcwebmuxCoreCountTimer); window.__bcwebmuxCoreCountMax",
  );
  assert.ok(
    sampledCoreCount <= 4,
    `sampled local core LRU exceeded its bound: ${sampledCoreCount}`,
  );
  const lruIdentity = await evaluate("window.bcwebmux.rendererIdentity");
  assert.ok(lruIdentity.coreCount <= 4, "local core LRU exceeded its bound");
  assert.deepEqual(lruIdentity, {
    coreCount: lruIdentity.coreCount,
    rendererCount: 1,
    deviceCount: 1,
    screenCount: 1,
    terminalCount: 1,
  });
  await evaluate(`window.bcwebmux.switchSession(${JSON.stringify(firstId)})`);
  await waitBrowser(
    `window.bcwebmux.activeSessionId === ${JSON.stringify(firstId)} && window.bcwebmux.connected`,
    10000,
    "cold session did not reload",
  );
  assert.match(await evaluate("window.bcwebmux.sessionText()"), /L4-ALPHA/);

  await evaluate(`window.bcwebmux.switchSession(${JSON.stringify(secondId)})`);
  await waitBrowser(
    `window.bcwebmux.activeSessionId === ${JSON.stringify(secondId)} && window.bcwebmux.connected`,
    10000,
    "lifecycle target did not activate",
  );
  assert.match(await evaluate("window.bcwebmux.sessionText()"), /L4-BETA/);
  await evaluate(
    `window.bcwebmux.write("printf '\\\\033]7501;state=clear\\\\007\\\\033]7501;state=working:id=live\\\\007\\\\033]7501;state=done:id=result\\\\007\\\\033]9;4;1;30\\\\007'\\n")`,
  );
  await waitFor(
    async () => {
      const metadata = await sessionMetadata(secondId);
      return (
        metadata.programStatus?.state === "working" && metadata.progressReport?.progress === 30
      );
    },
    5000,
    "session did not report working before termination",
  );
  await evaluate(
    `(() => { const lifecycle = document.querySelector('.session-row[data-session-id="${secondId}"] .session-lifecycle'); lifecycle.focus(); lifecycle.click(); })()`,
  );
  await waitBrowser(
    "document.querySelector('#session-action-dialog').open",
    1000,
    "termination confirmation did not open",
  );
  await evaluate("document.querySelector('#session-action-confirm').click()");
  await waitBrowser(
    `window.bcwebmux.sessions.some(session => session.id === ${JSON.stringify(secondId)} && session.state === 'exited')`,
    8000,
    "session did not exit through UI",
  );
  assert.equal(
    (await sessionMetadata(secondId)).programStatus?.state,
    "done",
    "exit must remove live work and retain completed results",
  );
  assert.equal(
    (await sessionMetadata(secondId)).progressReport,
    null,
    "exit must clear OSC 9;4 progress",
  );
  await waitBrowser(
    `document.querySelector('.session-row[data-session-id="${secondId}"] .session-detail')?.textContent.split(' · ').slice(0, 2).join(' · ') === 'exited · done'`,
    5000,
    "exited cards must retain the lifecycle label alongside the completed program status",
  );
  await evaluate("document.querySelector('.session-row.is-active .session-tab').focus()");
  await stillGolden("session-exited-card", ".session-row.is-active");
  await stillGolden("session-exited-bar", "#terminal-chrome");
  await evaluate(
    `(() => { const lifecycle = document.querySelector('.session-row[data-session-id="${secondId}"] .session-lifecycle'); lifecycle.focus(); lifecycle.click(); })()`,
  );
  await waitBrowser(
    "document.querySelector('#session-action-dialog').open",
    1000,
    "remove confirmation did not open",
  );
  await evaluate("document.querySelector('#session-action-confirm').click()");
  try {
    await waitBrowser(
      `!window.bcwebmux.sessions.some(session => session.id === ${JSON.stringify(secondId)}) && window.bcwebmux.activeSessionId !== null && window.bcwebmux.activeSessionId !== ${JSON.stringify(secondId)} && window.bcwebmux.connected`,
      10000,
      "active exited session was not removed with renderer fallback",
    );
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
  assert.ok(
    await evaluate(
      `window.bcwebmux.sessions.some(session => session.id === ${JSON.stringify(actualFallbackId)})`,
    ),
  );
  assert.equal(
    await evaluate(
      `document.activeElement === document.querySelector('.session-row[data-session-id="${actualFallbackId}"] .session-tab')`,
    ),
    true,
  );

  await videoGoldens.finish();
  await verifyStatusNotifications(actualFallbackId);
  const exceptions = page.events.filter((event) => event.method === "Runtime.exceptionThrown");
  assert.deepEqual(exceptions, [], JSON.stringify(exceptions));
  console.log(
    JSON.stringify({
      screenshots: screenshotDir,
      sessions: (await evaluate("window.bcwebmux.sessions")).length,
    }),
  );
} catch (error) {
  error.message += `\nScreenshots: ${screenshotDir}\nServer log:\n${serverLog}`;
  throw error;
} finally {
  await cleanup();
}

function goldenName(name) {
  const count = (goldenCounts.get(name) ?? 0) + 1;
  goldenCounts.set(name, count);
  return `${name}-${count}`;
}

async function capturePng(selector) {
  await evaluate("document.fonts.ready");
  if (!goldenStyleSheet) {
    await page.call("DOM.enable");
    await page.call("CSS.enable");
    const { frameTree } = await page.call("Page.getFrameTree");
    goldenStyleSheet = (await page.call("CSS.createStyleSheet", { frameId: frameTree.frame.id }))
      .styleSheetId;
  }
  // Terminal output and telemetry are volatile; cards, dialogs, and bars are not.
  await page.call("CSS.setStyleSheetText", {
    styleSheetId: goldenStyleSheet,
    text: "#surface, #screen, #input, #composition, #perf { visibility: hidden !important; }",
  });
  await evaluate(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  try {
    const clip = selector
      ? await evaluate(`(() => {
      const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height), scale: 1 };
    })()`)
      : null;
    const { width, height } =
      clip ?? (await evaluate("({ width: innerWidth, height: innerHeight })"));
    const { data } = await page.call("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      ...(clip ? { clip } : {}),
    });
    return { png: Buffer.from(data, "base64"), width, height };
  } finally {
    await page.call("CSS.setStyleSheetText", { styleSheetId: goldenStyleSheet, text: "" });
  }
}

// An animation group is recorded as its own video, one video per group.
async function motionGolden(group, name, selector = null) {
  const { png, width, height } = await capturePng(selector);
  await videoGoldens.add({ png, name: goldenName(name), width, height, group });
}

async function stillGolden(name, selector = null) {
  const { png, width, height } = await capturePng(selector);
  const golden = goldenName(name);
  await compareScreenshot({
    png,
    name: golden,
    goldenName: golden,
    goldenDir: stillGoldenDir,
    outputDir: screenshotDir,
    width,
    height,
    update: process.env.UPDATE_GOLDEN === "1",
  });
}

async function verifyProgressPresentation(id, progress) {
  const active = await evaluate(`window.bcwebmux.activeSessionId === ${JSON.stringify(id)}`);
  await waitBrowser(
    `(() => { const s = window.bcwebmux.sessions.find(s => s.id === ${JSON.stringify(id)}); return (s?.programStatus?.progress ?? s?.progressReport?.progress) === ${progress}; })()`,
    5000,
    "progress metadata did not reach the browser",
  );
  await evaluate(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  if (active)
    assert.equal(
      await evaluate("document.querySelector('#terminal-progress').getAttribute('aria-valuenow')"),
      String(progress),
      "accessible progress must match the report",
    );
  const state = await evaluate(
    `(() => { const s = window.bcwebmux.sessions.find(s => s.id === ${JSON.stringify(id)}); return s.programStatus?.state ?? s.progressReport.state; })()`,
  );
  await stillGolden(
    `session-progress-${active ? "active" : "inactive"}-${state}-${progress}-${await evaluate("innerWidth")}`,
  );
}

async function verifyLegacyProgress(id) {
  await page.call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  const report = async (body, expected) => {
    await evaluate(`window.bcwebmux.write(${JSON.stringify(`printf '\\033]9;4;${body}\\007'\n`)})`);
    await waitFor(
      async () =>
        JSON.stringify((await sessionMetadata(id)).progressReport) === JSON.stringify(expected),
      5000,
      `OSC 9;4 report did not reach session metadata: ${body}`,
    );
    await waitBrowser(
      `JSON.stringify(window.bcwebmux.sessions.find(session => session.id === ${JSON.stringify(id)})?.progressReport) === ${JSON.stringify(JSON.stringify(expected))}`,
      5000,
      "OSC 9;4 report did not reach the UI",
    );
  };
  await stillGolden("session-progress-absent");
  for (const progress of [0, 25, 73, 100]) {
    await report(`1;${progress}`, { state: "set", progress });
    await verifyProgressPresentation(id, progress);
    if (progress === 73) await screenshot("session-progress-osc9.png");
  }
  await report("2;35", { state: "error", progress: 35 });
  await verifyProgressPresentation(id, 35);
  await report("4;60", { state: "pause", progress: 60 });
  await verifyProgressPresentation(id, 60);
  await evaluate("document.querySelector('#softkeys-toggle').click()");
  await stillGolden("session-progress-softkeys");
  await evaluate("document.querySelector('#softkeys-toggle').click()");
  await page.call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
  });
  assert.equal(
    await evaluate(
      `document.querySelector('.session-row[data-session-id="${id}"]').getAnimations().length`,
    ),
    0,
    "paused progress must not animate",
  );
  await report("3", { state: "indeterminate", progress: null });
  assert.equal(
    await evaluate("document.querySelector('#terminal-progress').getAttribute('aria-valuenow')"),
    null,
    "indeterminate progress must not claim a percentage",
  );
  await page.call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await stillGolden("session-progress-indeterminate-reduced");
  await report("0", null);
  await stillGolden("session-progress-removed");
  await report("1;200", { state: "set", progress: 100 });
  await report("9;20", { state: "set", progress: 100 });
  await evaluate(`window.bcwebmux.write(${JSON.stringify("printf '\\033]133;A\\007'\n")})`);
  await waitFor(
    async () => (await sessionMetadata(id)).progressReport === null,
    5000,
    "prompt must clear OSC 9;4 progress",
  );
  await report("1;42", { state: "set", progress: 42 });
  await evaluate(`window.bcwebmux.write(${JSON.stringify("printf '\\033c'\n")})`);
  await waitFor(
    async () => (await sessionMetadata(id)).progressReport === null,
    5000,
    "reset must clear OSC 9;4 progress",
  );
  await waitBrowser(
    "document.querySelector('#terminal-progress').hidden",
    5000,
    "reset must hide bottom progress",
  );
  await stillGolden("session-progress-reset");
}

async function verifyStatusAnimation(id, state, group) {
  await page.call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
  });
  const motion = await evaluate(`(() => {
    const row = document.querySelector('.session-row[data-session-id="${id}"]');
    const animations = row.getAnimations();
    window.__statusMotionRow = row;
    if (animations.length !== 1) return { count: animations.length };
    const animation = animations[0];
    const running = animation.playState === 'running';
    const repeating = animation.effect.getComputedTiming().iterations === Infinity;
    animation.pause();
    const duration = animation.effect.getComputedTiming().duration;
    animation.currentTime = duration * 0.75;
    return { count: animations.length, running, repeating, time: animation.currentTime };
  })()`);
  assert.equal(motion.count, 1, `${state} must animate the card background`);
  assert.equal(motion.running, true, `${state} motion must start automatically`);
  assert.equal(motion.repeating, true, `${state} motion must repeat while the status remains`);
  for (const phase of state === "working"
    ? Array.from({ length: 12 }, (_, index) => index / 12)
    : Array.from({ length: 8 }, (_, index) => index / 8)) {
    await evaluate(`(() => {
      for (const animation of document.getAnimations()) {
        if (animation.effect.getComputedTiming().iterations !== Infinity) continue;
        animation.pause();
        animation.currentTime = animation.effect.getComputedTiming().duration * ${phase};
      }
    })()`);
    await motionGolden(group, `${state}-motion-${phase}`);
  }
  if (await evaluate(`window.bcwebmux.activeSessionId === ${JSON.stringify(id)}`)) {
    const original = await evaluate(
      `window.bcwebmux.sessions.find(session => session.id === ${JSON.stringify(id)}).programStatus`,
    );
    const field = state === "working" ? "progress" : "kind";
    const value = state === "working" ? 50 : "question";
    await evaluate(
      `window.bcwebmux.write(${JSON.stringify(`printf '\\033]7501;state=${state}:${field}=${value}\\007'\n`)})`,
    );
    await waitBrowser(
      `document.querySelector('.session-row[data-session-id="${id}"]') !== window.__statusMotionRow && window.bcwebmux.sessions.find(session => session.id === ${JSON.stringify(id)})?.programStatus?.${field} === ${JSON.stringify(value)}`,
      5000,
      "status update did not refresh the card",
    );
    assert.ok(
      (await evaluate(
        `document.querySelector('.session-row[data-session-id="${id}"]').getAnimations()[0].currentTime`,
      )) >= motion.time,
      "metadata refresh must preserve the status animation's phase",
    );
    const restored = `state=${state}${original.kind ? `:kind=${original.kind}` : ""}${original.progress !== null ? `:progress=${original.progress}` : ""}`;
    await evaluate(
      `window.bcwebmux.write(${JSON.stringify(`printf '\\033]7501;${restored}\\007'\n`)})`,
    );
    await waitBrowser(
      `JSON.stringify(window.bcwebmux.sessions.find(session => session.id === ${JSON.stringify(id)})?.programStatus) === ${JSON.stringify(JSON.stringify(original))}`,
      5000,
      "original program status was not restored",
    );
  }
  await page.call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  assert.equal(
    await evaluate(
      `document.querySelector('.session-row[data-session-id="${id}"]').getAnimations().length`,
    ),
    0,
    "reduced motion must disable status animations",
  );
}

async function verifyStatusNotifications(id) {
  const originalName = (await sessionMetadata(id)).name;
  await evaluate(`(() => {
    window.__notificationTest = {
      originalNotification: window.Notification,
      hiddenDescriptor: Object.getOwnPropertyDescriptor(document, 'hidden'),
      focusDescriptor: Object.getOwnPropertyDescriptor(document, 'hasFocus'),
      permission: 'granted', hidden: false, focused: true, sent: [],
    };
    const test = window.__notificationTest;
    window.Notification = class extends EventTarget {
      static get permission() { return test.permission; }
      constructor(title, options) { super(); test.sent.push({ title, body: options.body }); }
      close() {}
    };
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => test.hidden });
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => test.focused });
  })()`);
  const report = async (body, state, progress = null) => {
    const before = (await sessionMetadata(id)).eventSeq;
    await writeActiveOsc(`7501;${body}`);
    await waitFor(
      async () => {
        const value = await sessionMetadata(id);
        return BigInt(value.eventSeq) > BigInt(before) &&
          (value.programStatus?.state ?? null) === state &&
          (value.programStatus?.progress ?? null) === progress
          ? value
          : null;
      },
      5000,
      `notification report did not arrive: ${body}`,
    );
    await evaluate("window.bcwebmux.refreshSessions()");
    await waitBrowser(
      `(() => { const status = window.bcwebmux.sessions.find(s => s.id === ${JSON.stringify(id)}).programStatus; return (status?.state ?? null) === ${JSON.stringify(state)} && (status?.progress ?? null) === ${JSON.stringify(progress)}; })()`,
      5000,
      "notification report did not reach the browser",
    );
  };
  const sent = () => evaluate("window.__notificationTest.sent");
  try {
    await report("state=clear", null);
    await report("state=working", "working");
    await report("state=blocked:kind=permission", "blocked");
    assert.deepEqual(await sent(), [], "focused terminals must not notify");
    await evaluate("window.__notificationTest.focused = false");
    await evaluate("window.bcwebmux.refreshSessions()");
    assert.deepEqual(await sent(), [], "losing focus must not replay a transition");
    await report("state=error", "error");
    await report("state=done", "done");
    await report("state=done", "done");
    await evaluate(
      "window.bcwebmux.renameSession(window.bcwebmux.activeSessionId, 'Notify terminal')",
    );
    assert.deepEqual(
      (await sent()).map((n) => n.body),
      ["error", "done"],
      "state transitions must notify once, even when progress or names change",
    );
    await evaluate(
      "window.__notificationTest.hidden = true; window.__notificationTest.focused = true",
    );
    await report("state=working", "working");
    await report("state=blocked:kind=question", "blocked");
    assert.deepEqual((await sent()).at(-1), {
      title: "Notify terminal",
      body: "blocked · answer required",
    });
    await report("state=blocked:kind=auth:progress=40", "blocked", 40);
    for (const permission of ["default", "denied"]) {
      await evaluate(`window.__notificationTest.permission = ${JSON.stringify(permission)}`);
      await report("state=working", "working");
      await report("state=error", "error");
    }
    await evaluate("window.__notificationTest.permission = 'granted'");
    await evaluate("window.bcwebmux.refreshSessions()");
    assert.equal(
      (await sent()).length,
      3,
      "permission changes must not replay suppressed transitions",
    );
    await report("state=clear", null);
  } finally {
    await evaluate(`(() => {
      const test = window.__notificationTest;
      window.Notification = test.originalNotification;
      for (const [name, descriptor] of [['hidden', test.hiddenDescriptor], ['hasFocus', test.focusDescriptor]]) {
        if (descriptor) Object.defineProperty(document, name, descriptor);
        else delete document[name];
      }
      delete window.__notificationTest;
    })()`);
    await evaluate(
      `window.bcwebmux.renameSession(${JSON.stringify(id)}, ${JSON.stringify(originalName)})`,
    );
  }
}

async function verifyProgramStatus(id) {
  await page.call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  const report = async (body, expected) => {
    await evaluate(
      `window.bcwebmux.write(${JSON.stringify(`printf '\\033]7501;${body}\\007'\n`)})`,
    );
    await waitFor(
      async () => {
        const metadata = await sessionMetadata(id);
        return JSON.stringify(metadata.programStatus) === JSON.stringify(expected);
      },
      5000,
      `OSC 7501 report did not reach session metadata: ${body}`,
    );
    await waitBrowser(
      `(() => {
      const session = window.bcwebmux.sessions.find(session => session.id === ${JSON.stringify(id)});
      const row = document.querySelector('.session-row[data-session-id="${id}"]');
      return JSON.stringify(session?.programStatus) === ${JSON.stringify(JSON.stringify(expected))} &&
        ${expected ? `row?.querySelector('.session-detail')?.textContent.includes(${JSON.stringify(expected.state)})` : `!row?.hasAttribute('data-program-status') && row?.querySelector('.session-detail')?.hidden`};
    })()`,
      5000,
      "program status did not reach the card",
    );
  };
  for (const state of ["idle", "working", "done", "blocked", "error"]) {
    const expected = {
      state,
      kind: state === "blocked" ? "permission" : null,
      progress: state === "working" ? 0 : null,
    };
    await report(
      `state=${state}${state === "blocked" ? ":kind=permission" : ""}${state === "working" ? ":progress=0" : ""}`,
      expected,
    );
    if (state === "working" || state === "blocked")
      await verifyStatusAnimation(id, state, `${state}-motion`);
    await stillGolden(`session-progress-osc7501-${state}-reduced`);
  }
  await report("state=working:id=build:progress=25", {
    state: "error",
    kind: null,
    progress: null,
  });
  await report("state=clear", null);
  await report("state=working:id=build:progress=25", {
    state: "working",
    kind: null,
    progress: 25,
  });
  await verifyProgressPresentation(id, 25);
  await screenshot("session-progress-osc7501.png");
  await report("state=blocked:id=build/test:kind=auth", {
    state: "blocked",
    kind: "auth",
    progress: null,
  });
  await report("state=clear:id=build", null);
  await report("state=done", { state: "done", kind: null, progress: null });
  await report("state=clear:id=bad//id", { state: "done", kind: null, progress: null });
  await report("state=unknown", { state: "done", kind: null, progress: null });
  await report("state=working:id=temporary", { state: "working", kind: null, progress: null });
  await evaluate(`window.bcwebmux.write(${JSON.stringify("printf '\\033]133;A\\007'\n")})`);
  await waitFor(
    async () => (await sessionMetadata(id)).programStatus?.state === "done",
    5000,
    "prompt must discard live work but retain results",
  );
  await report("state=idle", { state: "idle", kind: null, progress: null });
  await evaluate(`window.bcwebmux.write(${JSON.stringify("printf '\\033c'\n")})`);
  await waitFor(
    async () => (await sessionMetadata(id)).programStatus === null,
    5000,
    "full reset must clear program status",
  );
  await waitBrowser(
    `!document.querySelector('.session-row[data-session-id="${id}"]')?.hasAttribute('data-program-status')`,
    5000,
    "reset must remove the card tint",
  );
}

async function writeActiveOsc(code) {
  await evaluate(`window.bcwebmux.write(${JSON.stringify(`printf '\\033]${code}\\007'\n`)})`);
}

// seedStatusPeers fills the drawer with sessions already in distinct states so
// the progress scenarios on the selected session are recorded alongside them.
async function seedStatusPeers() {
  const peers = [
    ["Tests", "7501;state=done", (metadata) => metadata.programStatus?.state === "done"],
    [
      "Build",
      "7501;state=working:progress=42",
      (metadata) => metadata.programStatus?.state === "working",
    ],
    ["Lint", "7501;state=idle", (metadata) => metadata.programStatus?.state === "idle"],
    [
      "Deploy",
      "7501;state=blocked:kind=permission",
      (metadata) => metadata.programStatus?.state === "blocked",
    ],
    ["Docs", "7501;state=error", (metadata) => metadata.programStatus?.state === "error"],
  ];
  const ids = [];
  for (const [name, code, reached] of peers) {
    await evaluate(`window.bcwebmux.createSession({ name: ${JSON.stringify(name)} })`);
    await waitBrowser(
      `window.bcwebmux.sessions.some(session => session.name === ${JSON.stringify(name)}) && window.bcwebmux.connected`,
      10000,
      `peer session ${name} did not activate`,
    );
    const id = await evaluate(
      `window.bcwebmux.sessions.find(session => session.name === ${JSON.stringify(name)})?.id`,
    );
    await evaluate(`window.bcwebmux.switchSession(${JSON.stringify(id)})`);
    await waitBrowser(
      `window.bcwebmux.activeSessionId === ${JSON.stringify(id)} && window.bcwebmux.connected`,
      10000,
      `peer session ${name} did not become active`,
    );
    await writeActiveOsc(code);
    await waitFor(
      async () => reached(await sessionMetadata(id)),
      5000,
      `peer session ${name} did not report its status`,
    );
    ids.push(id);
  }
  return ids;
}

async function removeStatusPeers(ids, keepId) {
  for (const id of ids) {
    await evaluate(`window.bcwebmux.terminateSession(${JSON.stringify(id)})`);
    await waitFor(
      async () => (await sessionMetadata(id)).state === "exited",
      8000,
      `peer session ${id} did not exit`,
    );
    await evaluate(`window.bcwebmux.deleteSession(${JSON.stringify(id)})`);
  }
  await waitBrowser(
    `window.bcwebmux.sessions.length === 1 && window.bcwebmux.activeSessionId === ${JSON.stringify(keepId)}`,
    10000,
    "peer sessions were not removed",
  );
}

async function evaluate(expression) {
  const response = await page.call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails)
    throw new Error(
      response.exceptionDetails.exception?.description || "browser evaluation failed",
    );
  return response.result.value;
}

async function waitBrowser(expression, timeout, message) {
  return waitFor(
    async () => Boolean(await evaluate(expression).catch(() => false)),
    timeout,
    message,
  );
}

async function metrics(width) {
  await page.call("Emulation.setDeviceMetricsOverride", {
    width,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
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

async function cleanup() {
  if (!cleanupPromise) {
    cleanupPromise = (async () => {
      try {
        page?.close();
      } catch {}
      try {
        browser?.close();
      } catch {}
      await videoGoldens.dispose();
      await terminateProcess(chromium);
      await terminateProcess(server);
      await rm(profile, { recursive: true, force: true });
    })();
  }
  return cleanupPromise;
}
