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
      response.end(`<!doctype html><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/session.css">
      <div id="app-shell"><aside id="session-drawer"><div id="session-list"><div id="session-tabs"></div></div></aside>
      <main id="workspace"><div id="terminal-identity"><span id="terminal-identity-primary">Active session</span></div></main></div>
      <script type="module">
        import { SessionDrawer } from '/SessionDrawer.js';
        const listeners = [];
        const controller = {
          sessions: ['a', 'b', 'c'].map(id => ({ id, name: id, state: 'running' })),
          activeSessionId: 'a', get(id) { return this.sessions.find(item => item.id === id) },
          switchTo(id) { this.activeSessionId = id },
          rename(id, name) { this.get(id).name = name; listeners.forEach(fn => fn({ type: 'renamed' })) },
          onChange(fn) { listeners.push(fn); return { dispose() {} } },
          remove(id) { this.sessions = this.sessions.filter(item => item.id !== id); listeners.forEach(fn => fn({ type: 'list' })) },
        };
        const drawer = new SessionDrawer({ controller, elements: { drawer: document.querySelector('#session-drawer'), tabs: document.querySelector('#session-tabs'), title: document.querySelector('#terminal-identity') } }).init();
        drawer.setStorageScope({ serverInstance: 'server', principal: 'user' }); drawer.render();
        window.fixture = { controller, drawer };
      </script>`);
      return;
    }
    const filename = path.resolve(web, `.${url.pathname}`);
    if (!filename.startsWith(web)) throw new Error("invalid path");
    response.setHeader("content-type", filename.endsWith(".css") ? "text/css" : "text/javascript");
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
      await page.call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
      assert.equal(await evaluate("matchMedia('(pointer: coarse)').matches"), true);
      await page.call("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: points.x, y: points.y }],
      });
      assert.equal(await evaluate("Boolean(document.querySelector('.is-drag-preview'))"), false);
      await delay(650);
      assert.equal(
        await evaluate("document.querySelector('#session-context-menu').hidden"),
        false,
        "touch hold still opens context actions",
      );
      await page.call("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: points.tx, y: points.ty }],
      });
      assert.equal(await evaluate("Boolean(document.querySelector('.is-drag-preview'))"), true);
      await page.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.call("Emulation.setTouchEmulationEnabled", { enabled: false });
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
      await page.call("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: points.tx,
        y: points.ty,
        button: "left",
        buttons: 1,
      });
      const lifted = await evaluate(`(() => {
        const preview = document.querySelector('.is-drag-preview');
        const row = document.querySelector('#session-tabs .session-row[data-session-id="${source}"]');
        const hit = document.elementFromPoint(${points.tx}, ${points.ty});
        return {
          floating: preview && !document.querySelector('#session-drawer').contains(preview) && getComputedStyle(preview).position === 'fixed',
          sourceHidden: getComputedStyle(row).opacity === '0',
          dropTarget: hit?.closest('.session-row')?.dataset.sessionId,
          hiddenFromAT: preview?.getAttribute('aria-hidden') === 'true' && preview.inert,
          reducedMotion: !matchMedia('(prefers-reduced-motion: reduce)').matches || preview?.getAnimations().length === 0,
        };
      })()`);
      assert.deepEqual(lifted, {
        floating: true,
        sourceHidden: true,
        dropTarget: targetId,
        hiddenFromAT: true,
        reducedMotion: true,
      });
      await page.call("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: points.tx + 15,
        y: points.ty,
        button: "left",
        buttons: 1,
      });
      await waitFor(
        () =>
          evaluate(`(() => {
        const preview = document.querySelector('.is-drag-preview');
        const row = document.querySelector('#session-tabs .session-row[data-session-id="${source}"]');
        const rect = preview.getBoundingClientRect();
        const origin = row.getBoundingClientRect();
        return Math.abs(rect.left - (origin.left + ${points.tx + 15 - points.x})) < 1 && Math.abs(rect.top - (origin.top + ${points.ty - points.y})) < 1;
      })()`),
        1000,
        "floating session did not follow the pointer",
      );
      await page.call("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: points.tx + 15,
        y: points.ty,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
    }
    assert.equal(
      await evaluate(
        "Boolean(document.querySelector('.is-drag-preview, .is-dragging, [data-drop-position]'))",
      ),
      false,
      "drop cleans up the floating card and target markers",
    );
  }
  async function doubleClick(selector) {
    const point = await evaluate(`(() => {
      const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    for (const clickCount of [1, 2]) {
      await page.call("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...point,
        button: "left",
        buttons: 1,
        clickCount,
      });
      await page.call("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...point,
        button: "left",
        buttons: 0,
        clickCount,
      });
    }
  }
  await ready();
  await doubleClick('.session-row[data-session-id="b"] .session-name');
  assert.equal(
    await evaluate("document.querySelector('#session-rename-dialog').open"),
    true,
    "double-clicking a session title opens rename",
  );
  await evaluate(`(() => {
    document.querySelector('#session-rename-dialog input').value = 'Renamed session';
    document.querySelector('#session-rename-dialog button[type="submit"]').click();
  })()`);
  assert.equal(await evaluate("fixture.controller.get('b').name"), "Renamed session");
  assert.equal(await evaluate("document.querySelector('#session-rename-dialog').open"), false);
  await doubleClick("#terminal-identity-primary");
  assert.equal(
    await evaluate("document.querySelector('#session-rename-dialog').dataset.sessionId"),
    "b",
  );
  assert.equal(await evaluate("document.querySelector('#session-rename-dialog').open"), true);
  await evaluate("document.querySelector('#session-rename-dialog button[type=button]').click()");
  await evaluate("fixture.controller.activeSessionId = 'a'");
  await drag("c", "a", 0.1);
  assert.deepEqual(await layout(), { ids: ["c", "a", "b"], groups: 0 });
  assert.equal(await evaluate("fixture.controller.activeSessionId"), "a");
  await drag("a", "c", 0.5);
  assert.deepEqual(await layout(), { ids: ["c", "a", "b"], groups: 1 });
  await doubleClick(".session-group-label");
  assert.equal(
    await evaluate("document.querySelector('#session-rename-dialog').open"),
    true,
    "double-clicking a group label opens rename",
  );
  assert.equal(
    await evaluate("document.querySelector('#session-rename-dialog h2').textContent.trim()"),
    "[ RENAME GROUP ]",
  );
  await evaluate("document.querySelector('#session-rename-dialog input').value = 'Work'");
  await page.call("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await page.call("Input.dispatchKeyEvent", {
    type: "char",
    key: "Enter",
    code: "Enter",
    text: "\r",
    unmodifiedText: "\r",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await page.call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  assert.equal(
    await evaluate("document.querySelector('.session-group-label').textContent.trim()"),
    "Work",
  );
  assert.deepEqual(
    await evaluate(
      `JSON.parse(localStorage.getItem(Object.keys(localStorage).find(key => key.startsWith('bcwebmux.session-layout:'))) ?? "[]")`,
    ),
    [{ name: "Work", members: ["c", "a"] }, "b"],
  );
  await page.call("Page.reload", { ignoreCache: true });
  await ready();
  assert.deepEqual(await layout(), { ids: ["c", "a", "b"], groups: 1 });
  assert.equal(
    await evaluate("document.querySelector('.session-group-label').textContent.trim()"),
    "Work",
  );
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
  await page.call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await page.call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await drag("c", "a", 0.1);
  assert.deepEqual(await layout(), { ids: ["c", "a", "b"], groups: 1 });
  await evaluate(`(() => {
    for (let index = 0; index < 20; index++) fixture.controller.sessions.push({ id: 'extra-' + index, name: 'Extra ' + index, state: 'running' });
    fixture.drawer.render();
  })()`);
  const beforeScroll = await layout();
  const touchPoint = await evaluate(`(() => {
    const rect = document.querySelector('.session-row[data-session-id="b"] .session-tab').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await page.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touchPoint] });
  await page.call("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: touchPoint.x, y: touchPoint.y - 45 }],
  });
  await delay(650);
  assert.equal(
    await evaluate("document.querySelector('#session-list').scrollTop > 0"),
    true,
    "moving before the hold scrolls the list",
  );
  assert.equal(await evaluate("Boolean(document.querySelector('.is-drag-preview'))"), false);
  assert.equal(await evaluate("document.querySelector('#session-context-menu').hidden"), true);
  await page.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  assert.deepEqual(await layout(), beforeScroll);
  await page.call("Emulation.setTouchEmulationEnabled", { enabled: false });
  await evaluate("document.querySelector('#session-list').scrollTop = 0");
  const origin = await evaluate(`(() => {
    const rect = document.querySelector('#session-tabs .session-tab').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  for (const cleanup of ["escape", "remove", "dispose"]) {
    await page.call("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...origin,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await page.call("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 400,
      y: 200,
      button: "left",
      buttons: 1,
    });
    assert.equal(
      await evaluate("Boolean(document.querySelector('.is-drag-preview'))"),
      true,
      "drag follows outside the drawer",
    );
    if (cleanup === "escape") {
      await page.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
      await page.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
    } else if (cleanup === "remove") {
      await evaluate(
        "fixture.controller.remove(document.querySelector('#session-tabs .session-row').dataset.sessionId)",
      );
    } else {
      await evaluate("fixture.drawer.dispose()");
    }
    assert.equal(
      await evaluate(
        "Boolean(document.querySelector('.is-drag-preview, .is-dragging, .is-session-dragging, [data-drop-position]'))",
      ),
      false,
      cleanup + " cleans up drag state",
    );
    await page.call("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: 400,
      y: 200,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    if (cleanup === "escape") assert.deepEqual(await layout(), beforeScroll);
  }
  console.log("session layout browser test passed");
} finally {
  page?.close();
  await terminateProcess(browserProcess);
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
