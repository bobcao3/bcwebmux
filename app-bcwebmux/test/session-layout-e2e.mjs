// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Cdp, freePort, terminateProcess, waitFor, delay } from "./test-support.mjs";

const web = fileURLToPath(new URL("../web/", import.meta.url));
const port = await freePort();
const debugPort = await freePort();
const profile = await mkdtemp(path.join(os.tmpdir(), "bcwebmux-layout-"));
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/") {
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><style>
        #session-list { height: 600px; overflow: auto } #session-tabs { width: 240px }
        .session-row { height: 60px } .session-tab { width: 200px; height: 50px; touch-action: none }
      </style><div id="session-list"><aside id="drawer"><div id="session-tabs"></div></aside></div>
      <script type="module">
        import { SessionDrawer } from '/SessionDrawer.js';
        const listeners = [];
        const controller = {
          sessions: ['a', 'b', 'c'].map(id => ({ id, name: id, state: 'running' })),
          activeSessionId: 'a', get(id) { return this.sessions.find(item => item.id === id) },
          switchTo(id) { this.activeSessionId = id },
          onChange(fn) { listeners.push(fn); return { dispose() {} } },
          remove(id) { this.sessions = this.sessions.filter(item => item.id !== id); listeners.forEach(fn => fn({ type: 'list' })) },
        };
        const drawer = new SessionDrawer({ controller, elements: { drawer: document.querySelector('#drawer'), tabs: document.querySelector('#session-tabs') } }).init();
        drawer.setStorageScope({ serverInstance: 'server', principal: 'user' }); drawer.render();
        window.fixture = { controller, drawer };
      </script>`);
      return;
    }
    const filename = path.resolve(web, `.${url.pathname}`);
    if (!filename.startsWith(web)) throw new Error("invalid path");
    response.setHeader("content-type", "text/javascript");
    response.end(await readFile(filename));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
let browserProcess;
let page;
try {
  browserProcess = spawn(
    process.env.CHROMIUM || "chromium",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      `http://127.0.0.1:${port}/`,
    ],
    { stdio: "ignore", detached: true },
  );
  browserProcess.detachedGroup = true;
  const target = await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`).catch(() => null);
      return response?.ok && (await response.json()).find((item) => item.type === "page");
    },
    10000,
    "browser did not start",
  );
  page = await Cdp.connect(target.webSocketDebuggerUrl);
  await page.call("Runtime.enable");
  await page.call("Page.enable");
  async function evaluate(expression) {
    const result = await page.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description);
    return result.result.value;
  }
  async function ready() {
    await waitFor(() => evaluate("Boolean(window.fixture)"), 5000, "fixture did not load");
  }
  async function layout() {
    return evaluate(
      `({ ids: [...document.querySelectorAll('.session-row')].map(row => row.dataset.sessionId), groups: document.querySelectorAll('.session-group-label').length })`,
    );
  }
  async function drag(source, targetId, fraction, touch = false) {
    const points = await evaluate(`(() => {
      const a = document.querySelector('.session-row[data-session-id="${source}"] .session-tab').getBoundingClientRect();
      const b = document.querySelector('.session-row[data-session-id="${targetId}"]').getBoundingClientRect();
      return { x: a.left + a.width / 2, y: a.top + a.height / 2, tx: b.left + b.width / 2, ty: b.top + b.height * ${fraction} };
    })()`);
    if (touch) {
      await page.call("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: points.x, y: points.y }],
      });
      await delay(650);
      await page.call("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: points.tx, y: points.ty }],
      });
      await page.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
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
  }
  await ready();
  await drag("c", "a", 0.1);
  assert.deepEqual(await layout(), { ids: ["c", "a", "b"], groups: 0 });
  assert.equal(await evaluate("fixture.controller.activeSessionId"), "a");
  await drag("a", "c", 0.5);
  assert.deepEqual(await layout(), { ids: ["c", "a", "b"], groups: 1 });
  await page.call("Page.reload", { ignoreCache: true });
  await ready();
  assert.deepEqual(await layout(), { ids: ["c", "a", "b"], groups: 1 });
  await drag("a", "b", 0.5, true);
  assert.deepEqual(await layout(), { ids: ["c", "b", "a"], groups: 1 });
  await evaluate("fixture.controller.remove('a')");
  await waitFor(async () => (await layout()).ids.length === 2, 2000, "session was not removed");
  assert.deepEqual(await layout(), { ids: ["c", "b"], groups: 0 });
  await page.call("Page.reload", { ignoreCache: true });
  await ready();
  assert.deepEqual(await layout(), { ids: ["c", "b", "a"], groups: 0 });
  await drag("b", "c", 0.5);
  await drag("a", "b", 0.5);
  await drag("a", "c", 0.1);
  assert.deepEqual(await layout(), { ids: ["a", "c", "b"], groups: 1 });
  await evaluate(`(() => {
    const tab = document.querySelector('.session-row[data-session-id="c"] .session-tab');
    tab.focus();
    tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'u', altKey: true, shiftKey: true, bubbles: true }));
  })()`);
  assert.deepEqual(await layout(), { ids: ["a", "b", "c"], groups: 1 });
  assert.equal(await evaluate("document.activeElement.dataset.sessionId"), "c");
  await evaluate(
    `fixture.drawer.setStorageScope({ serverInstance: 'server', principal: 'other' }).render()`,
  );
  assert.deepEqual(await layout(), { ids: ["a", "b", "c"], groups: 0 });
  await evaluate(
    `fixture.drawer.setStorageScope({ serverInstance: 'server', principal: 'user' }).render()`,
  );
  assert.deepEqual(await layout(), { ids: ["a", "b", "c"], groups: 1 });
  console.log("session layout browser test passed");
} finally {
  page?.close();
  await terminateProcess(browserProcess);
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
