// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Cdp, freePort, terminateProcess, waitFor, delay } from "./test-support.mjs";

const [serverPath, webRoot] = process.argv.slice(2);
assert.ok(serverPath && webRoot, "usage: session-layout-sync-e2e.mjs SERVER WEB_ROOT");
const port = await freePort();
const debugPort = await freePort();
const base = `http://127.0.0.1:${port}`;
const profile = await mkdtemp(path.join(os.tmpdir(), "bcwebmux-layout-sync-"));
const pages = [];
let server, daemon, chromium, browser;
let log = "";

async function evaluate(page, expression) {
  const result = await page.call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails)
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function layout(page) {
  return evaluate(
    page,
    `({ ids: [...document.querySelectorAll('#fixture-tabs .session-row')].map(row => row.dataset.sessionId), groups: document.querySelectorAll('#fixture-tabs .session-group-label').length })`,
  );
}
async function waitLayout(page, expected) {
  await waitFor(
    async () => JSON.stringify(await layout(page)) === JSON.stringify(expected),
    5000,
    `layout did not become ${JSON.stringify(expected)}`,
  );
}
async function groupName(page) {
  return evaluate(
    page,
    "document.querySelector('#fixture-tabs .session-group-label')?.textContent.trim() ?? ''",
  );
}
async function openClient(seed) {
  const { browserContextId } = await browser.call("Target.createBrowserContext");
  const { targetId } = await browser.call("Target.createTarget", {
    url: "about:blank",
    browserContextId,
  });
  const target = await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      return (await response.json()).find(
        (item) => item.id === targetId && item.webSocketDebuggerUrl,
      );
    },
    5000,
    "browser target unavailable",
  );
  const page = await Cdp.connect(target.webSocketDebuggerUrl);
  pages.push(page);
  await page.call("Runtime.enable");
  await page.call("Page.enable");
  await page.call("Network.enable");
  await page.call("Network.setBlockedURLs", { urls: ["*/client.js"] });
  await page.call("Page.navigate", { url: base + "/" });
  await waitFor(
    () => evaluate(page, "document.readyState === 'complete'"),
    5000,
    "fixture page unavailable",
  );
  await evaluate(
    page,
    `(async () => {
    const [{ SessionApi }, { SessionDrawer }] = await Promise.all([import('/SessionApi.js'), import('/SessionDrawer.js')]);
    const api = new SessionApi();
    const updateLayout = api.updateLayout.bind(api);
    api.updateLayout = async (...args) => { const result = await updateLayout(...args); window.layoutUpdated = true; return result; };
    const info = await api.info();
    const sessions = (await api.list()).sessions;
    const listeners = [];
    const controller = {
      sessions, activeSessionId: sessions[0].id,
      get(id) { return this.sessions.find(item => item.id === id) },
      switchTo(id) { this.activeSessionId = id },
      onChange(fn) { listeners.push(fn); return { dispose() {} } },
      hide(id) { this.sessions = this.sessions.filter(item => item.id !== id); listeners.forEach(fn => fn({ type: 'list' })); },
      async refresh() { this.sessions = (await api.list()).sessions; listeners.forEach(fn => fn({ type: 'list' })); },
    };
    const root = document.createElement('div');
    root.style.cssText = 'position:fixed;inset:0;z-index:1000;background:var(--color-background)';
    const drawerElement = document.createElement('aside');
    drawerElement.style.cssText = 'width:260px;height:600px;overflow:auto';
    const tabs = document.createElement('div'); tabs.id = 'fixture-tabs';
    drawerElement.append(tabs); root.append(drawerElement); document.body.append(root);
    const seed = ${JSON.stringify(seed)};
    if (seed) localStorage.setItem('bcwebmux.session-layout:v1:' + encodeURIComponent(info.serverInstance) + ':' + encodeURIComponent(info.principal), JSON.stringify(seed));
    const drawer = new SessionDrawer({
      controller,
      layoutApi: api,
      elements: {
        drawer: drawerElement,
        tabs,
        renameDialog: document.querySelector('#session-rename-dialog'),
        renameTitle: document.querySelector('#session-rename-title'),
        renameInput: document.querySelector('#session-rename-input'),
        renameForm: document.querySelector('#session-rename-dialog form'),
        renameCancel: document.querySelector('#session-rename-cancel'),
        renameSubmit: document.querySelector('#session-rename-save'),
      },
    }).init();
    drawer.setStorageScope(info); drawer.render();
    window.fixture = { controller, drawer };
  })()`,
  );
  return page;
}
async function key(page, id, key) {
  await evaluate(
    page,
    `(() => { const tab = document.querySelector('#fixture-tabs .session-row[data-session-id="${id}"] .session-tab'); tab.focus(); tab.dispatchEvent(new KeyboardEvent('keydown', {key:${JSON.stringify(key)},altKey:true,shiftKey:true,bubbles:true})); })()`,
  );
}

async function drag(page, source, target) {
  const points = await evaluate(
    page,
    `(() => {
    const a = document.querySelector('#fixture-tabs .session-row[data-session-id="${source}"] .session-tab').getBoundingClientRect();
    const b = document.querySelector('#fixture-tabs .session-row[data-session-id="${target}"]').getBoundingClientRect();
    return { x: a.left + a.width / 2, y: a.top + a.height / 2, tx: b.left + b.width / 2, ty: b.top + b.height / 2 };
  })()`,
  );
  await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: points.x, y: points.y });
  await page.call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: points.x,
    y: points.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await delay(650);
  await page.call("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: points.tx,
    y: points.ty,
    button: "left",
    buttons: 1,
  });
  await page.call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: points.tx,
    y: points.ty,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

try {
  const socket = path.join(profile, "session.sock");
  daemon = spawn(
    path.join(path.dirname(path.resolve(serverPath)), "bcwebmux-sessiond"),
    ["--socket", socket, "--shell", "/bin/sh"],
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  daemon.detachedGroup = true;
  for (const stream of [daemon.stdout, daemon.stderr])
    stream.on("data", (data) => {
      log += data;
    });
  await waitFor(
    async () => (await stat(socket).catch(() => null))?.isSocket(),
    10000,
    "daemon did not start",
  );
  server = spawn(
    path.resolve(serverPath),
    [
      "--config",
      "/dev/null",
      "--auth=false",
      "--listen",
      `127.0.0.1:${port}`,
      "--origin",
      base,
      "--session-socket",
      socket,
      "--web-root",
      path.resolve(webRoot),
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, XDG_STATE_HOME: profile },
    },
  );
  server.detachedGroup = true;
  for (const stream of [server.stdout, server.stderr])
    stream.on("data", (data) => {
      log += data;
    });
  await waitFor(
    async () => (await fetch(base + "/api/server").catch(() => null))?.ok,
    10000,
    "server did not start",
  );
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const response = await fetch(base + "/api/sessions", {
      method: "POST",
      headers: {
        Origin: base,
        "Content-Type": "application/json",
        "Idempotency-Key": `layout-${i}`,
      },
      body: JSON.stringify({ profile: "shell" }),
    });
    assert.equal(response.status, 201, await response.clone().text());
    ids.push((await response.json()).id);
  }
  chromium = spawn(
    process.env.CHROMIUM || "chromium",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore", detached: true },
  );
  chromium.detachedGroup = true;
  const version = await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => null);
      return response?.ok && response.json();
    },
    10000,
    "Chromium did not start",
  );
  browser = await Cdp.connect(version.webSocketDebuggerUrl);
  const first = await openClient([ids[2], [ids[0], ids[1]]]);
  await waitFor(
    () => evaluate(first, "window.layoutUpdated === true"),
    5000,
    "local layout was not migrated",
  );
  const second = await openClient(null);
  const initial = { ids: [ids[2], ids[0], ids[1]], groups: 1 };
  await waitLayout(first, initial);
  await waitLayout(second, initial);
  await evaluate(second, `fixture.controller.hide(${JSON.stringify(ids[0])})`);
  await waitLayout(second, { ids: [ids[2], ids[1]], groups: 0 });
  await evaluate(second, "fixture.controller.refresh()");
  await waitLayout(second, initial);
  await key(second, ids[0], "u");
  const ungrouped = { ids: [ids[2], ids[1], ids[0]], groups: 0 };
  await waitLayout(first, ungrouped);
  await waitLayout(second, ungrouped);
  await drag(first, ids[0], ids[1]);
  const grouped = { ids: [ids[2], ids[1], ids[0]], groups: 1 };
  await waitLayout(first, grouped);
  await waitLayout(second, grouped);
  await evaluate(
    first,
    `(() => {
      document.querySelector('#fixture-tabs .session-group-label').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const input = document.querySelector('#session-rename-dialog input');
      input.value = 'Work';
      document.querySelector('#session-rename-dialog form').requestSubmit();
    })()`,
  );
  for (const page of [first, second]) {
    await waitFor(
      async () => (await groupName(page)) === "Work",
      5000,
      "group name did not synchronize",
    );
  }
  // A newly opened browser context also has no local layout.
  const third = await openClient(null);
  await waitLayout(third, grouped);
  await waitFor(
    async () => (await groupName(third)) === "Work",
    5000,
    "new client did not receive the group name",
  );
  const terminate = await fetch(`${base}/api/sessions/${ids[0]}/terminate`, {
    method: "POST",
    headers: { Origin: base, "Idempotency-Key": "layout-terminate" },
  });
  assert.equal(terminate.status, 202);
  await waitFor(
    async () => {
      const response = await fetch(`${base}/api/sessions/${ids[0]}`);
      const metadata = await response.json();
      return metadata.state === "exited";
    },
    5000,
    "session did not exit",
  );
  const deleted = await fetch(`${base}/api/sessions/${ids[0]}`, {
    method: "DELETE",
    headers: { Origin: base, "Idempotency-Key": "layout-delete" },
  });
  assert.equal(deleted.status, 204);
  await Promise.all(
    [first, second, third].map((page) => evaluate(page, "fixture.controller.refresh()")),
  );
  const remaining = { ids: [ids[2], ids[1]], groups: 0 };
  await Promise.all([first, second, third].map((page) => waitLayout(page, remaining)));
  console.log("shared session layout browser test passed");
} catch (error) {
  error.message += `\nServer log:\n${log}`;
  throw error;
} finally {
  for (const page of pages) page.close();
  browser?.close();
  await terminateProcess(chromium);
  await terminateProcess(server);
  await terminateProcess(daemon);
  await rm(profile, { recursive: true, force: true });
}
