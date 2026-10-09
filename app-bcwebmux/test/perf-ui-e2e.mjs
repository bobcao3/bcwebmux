// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Cdp, freePort, terminateProcess, waitFor } from "./test-support.mjs";

const [serverPath, webRoot] = process.argv.slice(2);
assert.ok(serverPath && webRoot, "usage: perf-ui-e2e.mjs SERVER WEB_ROOT");
const profile = await mkdtemp(path.join(os.tmpdir(), "bcwebmux-perf-ui-"));
const serverPort = await freePort();
const debugPort = await freePort();
const base = `http://127.0.0.1:${serverPort}`;
let server;
let chromium;
let page;
let serverLog = "";

try {
  const shell = path.join(profile, "shell");
  await writeFile(shell, "#!/bin/sh\nprintf '\\033]0;Program alpha\\007'\nexec /bin/sh -i\n", {
    mode: 0o700,
  });
  server = spawn(
    serverPath,
    [
      "--config",
      "/dev/null",
      "--auth=false",
      "--shell",
      shell,
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
  await waitFor(
    async () => (await fetch(`${base}/api/server`).catch(() => null))?.ok,
    10000,
    () => `server failed to start: ${serverLog}`,
  );
  chromium = spawn(
    process.env.CHROMIUM || "chromium",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1024,720",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore", detached: true },
  );
  chromium.detachedGroup = true;
  const target = await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`).catch(() => null);
      return response?.ok && (await response.json()).find((entry) => entry.type === "page");
    },
    15000,
    "Chromium did not expose a page",
  );
  page = await Cdp.connect(target.webSocketDebuggerUrl);
  await page.call("Page.enable");
  await page.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.setItem('bcwebmux.settings.v1', JSON.stringify({ renderer: 'canvas', perfMode: 'simple' }));`,
  });
  await page.call("Page.navigate", { url: `${base}/?session-test=1` });
  await waitBrowser(
    "window.bcwebmux?.connected && document.querySelector('#terminal-identity-primary').textContent === 'Program alpha'",
    "initial session did not become live",
  );
  await waitBrowser(
    "document.querySelector('#perf').value.includes('WS RTT:')",
    "metrics did not populate",
  );
  assert.doesNotMatch(await evaluate("document.querySelector('#perf').value"), /WASM/);
  const id = await evaluate("window.bcwebmux.activeSessionId");

  for (const width of [1024, 390]) {
    await page.call("Emulation.setDeviceMetricsOverride", {
      width,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const layout = await evaluate(`(() => {
      const perf = document.querySelector('#perf');
      const title = document.querySelector('#terminal-identity-primary').getBoundingClientRect();
      const metrics = perf.getBoundingClientRect();
      const controls = document.querySelector('#terminal-controls').getBoundingClientRect();
      return { below: metrics.top >= title.bottom, inside: metrics.top >= controls.top && metrics.bottom <= controls.bottom,
        visible: getComputedStyle(perf).visibility, animations: perf.getAnimations().length };
    })()`);
    assert.deepEqual(layout, { below: true, inside: true, visible: "visible", animations: 0 });
  }

  await evaluate(`window.bcwebmux.renameSession(${JSON.stringify(id)}, 'Named session')`);
  await waitBrowser(
    "document.querySelector('#terminal-identity-primary').textContent === 'Named session'",
    "named title did not render",
  );
  for (const [time, titleOpacity, perfOpacity] of [
    [0, 1, 0],
    [4800, 1, 0],
    [4900, 0.5, 0.5],
    [5000, 0, 1],
    [9800, 0, 1],
    [9900, 0.5, 0.5],
    [10000, 1, 0],
  ]) {
    const sample = await sampleDetail(time);
    assert.ok(Math.abs(sample.titleOpacity - titleOpacity) < 0.01, JSON.stringify(sample));
    assert.ok(Math.abs(sample.perfOpacity - perfOpacity) < 0.01, JSON.stringify(sample));
    assert.equal(sample.below, true, "alternation must remain below the title");
    if (time === 4900 || time === 9900)
      assert.notEqual(sample.transform, "matrix(1, 0, 0, 1, 0, 0)");
  }
  await sampleDetail(5000);
  await evaluate(
    `window.bcwebmux.write(${JSON.stringify("printf '\\033]0;Program beta\\007'\n")})`,
  );
  await waitBrowser(
    "document.querySelector('#terminal-identity-secondary').textContent === 'Program beta'",
    "program title did not update during the metrics phase",
  );
  assert.equal(
    await evaluate("Number(getComputedStyle(document.querySelector('#perf')).opacity)"),
    1,
    "a program title update must not restart the metrics phase",
  );

  await page.call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  for (const [time, titleOpacity] of [
    [0, 1],
    [4999, 1],
    [5000, 0],
    [9999, 0],
    [10000, 1],
  ]) {
    const sample = await sampleDetail(time);
    assert.equal(sample.titleOpacity, titleOpacity);
    assert.equal(sample.perfOpacity, 1 - titleOpacity);
    assert.equal(sample.transform, "none", "reduced motion must not slide text");
  }

  for (const mode of ["detailed", "off"]) {
    await setMode(mode);
    const presentation = await evaluate(`(() => {
      const perf = document.querySelector('#perf');
      const title = document.querySelector('#terminal-identity-secondary');
      return { hidden: perf.hidden, overlay: perf.parentElement.id === 'terminal-viewport',
        titleVisible: getComputedStyle(title).visibility, animations: title.getAnimations().length };
    })()`);
    assert.deepEqual(presentation, {
      hidden: mode === "off",
      overlay: true,
      titleVisible: "visible",
      animations: 0,
    });
    if (mode === "detailed")
      assert.match(await evaluate("document.querySelector('#perf').value"), /WASM frame:.*\n/);
  }
  await setMode("simple");
  await evaluate(`window.bcwebmux.renameSession(${JSON.stringify(id)}, '')`);
  await waitBrowser(
    "document.querySelector('#terminal-identity-primary').textContent === 'Program beta'",
    "clearing the name did not restore the program title",
  );
  assert.equal(await evaluate("document.querySelector('#perf').getAnimations().length"), 0);
  assert.equal(
    await evaluate("getComputedStyle(document.querySelector('#perf')).visibility"),
    "visible",
  );
  assert.equal(await evaluate("document.querySelector('#client-error').hidden"), true);
  console.log("performance identity UI passed");
} finally {
  page?.close();
  await terminateProcess(chromium);
  await terminateProcess(server);
  await rm(profile, { recursive: true, force: true });
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

async function waitBrowser(expression, message) {
  return waitFor(
    async () => Boolean(await evaluate(expression).catch(() => false)),
    12000,
    message,
  );
}

async function setMode(mode) {
  await evaluate(`(() => {
    const radio = document.querySelector('input[name="perfMode"][value="${mode}"]');
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
}

async function sampleDetail(time) {
  return evaluate(`(() => {
    const title = document.querySelector('#terminal-identity-secondary');
    const perf = document.querySelector('#perf');
    for (const element of [title, perf]) {
      const animations = element.getAnimations();
      if (animations.length !== 1) throw new Error('expected one alternating animation');
      animations[0].pause();
      animations[0].currentTime = ${time};
    }
    const titleStyle = getComputedStyle(title);
    const perfStyle = getComputedStyle(perf);
    const primary = document.querySelector('#terminal-identity-primary').getBoundingClientRect();
    return { titleOpacity: Number(titleStyle.opacity), perfOpacity: Number(perfStyle.opacity),
      transform: titleStyle.transform, below: perf.getBoundingClientRect().top >= primary.bottom - 4 };
  })()`);
}
