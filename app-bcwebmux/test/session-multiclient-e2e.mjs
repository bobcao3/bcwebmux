// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Cdp, freePort, terminateProcess, waitFor, delay } from "./test-support.mjs";

const [serverPath, webRoot, backend = "webgl2"] = process.argv.slice(2);
assert.ok(
  serverPath && webRoot,
  "usage: session-multiclient-e2e.mjs SERVER WEB_ROOT [webgl2|webgpu]",
);
assert.ok(["webgl2", "webgpu"].includes(backend));
const port = await freePort();
const debugPort = await freePort();
const base = `http://127.0.0.1:${port}`;
const profile = await mkdtemp(path.join(os.tmpdir(), "bcwebmux-multiclient-"));
const pages = [];
let server, chromium, browser;
let logs = "";

async function evaluate(page, expression) {
  const result = await page.call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails)
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function openClient(width, height) {
  const { browserContextId } = await browser.call("Target.createBrowserContext");
  const { targetId } = await browser.call("Target.createTarget", {
    url: "about:blank",
    browserContextId,
    newWindow: true,
  });
  const target = await waitFor(
    async () => {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      return targets.find((item) => item.id === targetId && item.webSocketDebuggerUrl);
    },
    5000,
    "browser client target missing",
  );
  const page = await Cdp.connect(target.webSocketDebuggerUrl);
  pages.push(page);
  await page.call("Runtime.enable");
  await page.call("Page.enable");
  await page.call("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 500,
  });
  await page.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.setItem("bcwebmux.settings.v1", JSON.stringify({renderer: "canvas", grainStrength: 0}));`,
  });
  await page.call("Page.navigate", {
    url: `${base}/?session-test=1&renderer=canvas&backend=${backend}`,
  });
  await waitFor(
    () => evaluate(page, "window.bcwebmux?.connected === true"),
    15000,
    "client did not attach",
  );
  return page;
}

async function healthy(page, id, marker) {
  await waitFor(
    () =>
      evaluate(
        page,
        `window.bcwebmux.connected &&
    window.bcwebmux.activeSessionId === ${JSON.stringify(id)} &&
    window.bcwebmux.sessionText().includes(${JSON.stringify(marker)}) &&
    window.bcwebmux.state.gpuFrames > 0`,
      ),
    10000,
    "terminal did not render replayed session",
  );
  assert.equal(
    await evaluate(page, "document.querySelector('#client-error-message').textContent"),
    "",
  );
  assert.ok(!(await evaluate(page, "window.bcwebmux.state.gpuError")));
}

async function checkpoint(page, marker) {
  const id = await evaluate(page, "window.bcwebmux.activeSessionId");
  const before = await (await fetch(`${base}/api/sessions/${id}`)).json();
  // Cross the 2 MiB checkpoint threshold without growing scrollback or waiting
  // for the 30-second checkpoint interval. Leave post-checkpoint output to replay.
  const command = `printf '\\033[2J\\033[H${marker}\\n'; head -c 2162688 /dev/zero | tr '\\000' '\\015'; printf '\\n${marker}-TAIL\\n'\n`;
  await evaluate(page, `window.bcwebmux.write(${JSON.stringify(command)})`);
  const metadata = await waitFor(
    async () => {
      const value = await (await fetch(`${base}/api/sessions/${id}`)).json();
      return Number(value.checkpointEventSeq) > Number(before.checkpointEventSeq) && value;
    },
    10000,
    "session did not checkpoint",
  );
  await healthy(page, id, `${marker}-TAIL`);
  assert.ok(
    metadata.geometry.cols * metadata.geometry.rows > 4000,
    "checkpoint must exceed the small client's capacity",
  );
  return metadata;
}

try {
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
      "--shell",
      "/bin/sh",
      "--web-root",
      path.resolve(webRoot),
    ],
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  server.detachedGroup = true;
  for (const stream of [server.stdout, server.stderr])
    stream.on("data", (chunk) => {
      logs += chunk;
    });
  server.on("error", (error) => {
    logs += String(error);
  });
  await waitFor(
    async () => (await fetch(`${base}/api/server`).catch(() => null))?.ok,
    10000,
    () => logs,
  );
  chromium = spawn(
    process.env.CHROMIUM || "chromium",
    [
      "--headless=new",
      "--window-size=1440,900",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--enable-unsafe-webgpu",
      "--use-angle=vulkan",
      "--ignore-gpu-blocklist",
      "--enable-features=Vulkan",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  chromium.detachedGroup = true;
  chromium.stderr.on("data", (chunk) => {
    logs += chunk;
  });
  chromium.on("error", (error) => {
    logs += String(error);
  });
  const version = await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => null);
      return response?.ok && response.json();
    },
    15000,
    () => logs,
  );
  browser = await Cdp.connect(version.webSocketDebuggerUrl);
  const { gpu } = await browser.call("SystemInfo.getInfo");
  assert.ok(gpu.devices?.length);
  assert.doesNotMatch(JSON.stringify(gpu.devices), /swiftshader|llvmpipe|software/i);

  const desktop = await openClient(1300, 850);
  const a = await checkpoint(desktop, "LARGE-A");
  await evaluate(desktop, 'window.bcwebmux.createSession({name: "large second session"})');
  await waitFor(
    () =>
      evaluate(
        desktop,
        `window.bcwebmux.connected && window.bcwebmux.activeSessionId !== ${JSON.stringify(a.id)}`,
      ),
    10000,
    "second session did not activate",
  );
  const b = await checkpoint(desktop, "LARGE-B");

  // Control: a second client with enough capacity can restore the same checkpoint.
  const sameSize = await openClient(1300, 850);
  await healthy(sameSize, b.id, "LARGE-B-TAIL");
  const small = await openClient(390, 740);
  assert.notEqual(
    await evaluate(small, "window.bcwebmux.clientInstanceId"),
    await evaluate(desktop, "window.bcwebmux.clientInstanceId"),
  );
  await healthy(small, b.id, "LARGE-B-TAIL");

  // Start healthy, then restore a larger checkpoint into an inactive core during
  // a session-tab switch. This must work before the client can claim and resize.
  const created = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: {
      Origin: base,
      "Content-Type": "application/json",
      "Idempotency-Key": "small-startup",
    },
    body: JSON.stringify({
      profile: "shell",
      name: "small startup",
      geometry: { cols: 43, rows: 38 },
    }),
  });
  assert.equal(created.status, 201);
  const fresh = await created.json();
  const switcher = await openClient(390, 740);
  assert.equal(await evaluate(switcher, "window.bcwebmux.activeSessionId"), fresh.id);
  await evaluate(switcher, `window.bcwebmux.switchSession(${JSON.stringify(a.id)})`);
  await healthy(switcher, a.id, "LARGE-A-TAIL");
  await evaluate(switcher, `window.bcwebmux.switchSession(${JSON.stringify(fresh.id)})`);
  await waitFor(
    () => evaluate(switcher, "window.bcwebmux.connected"),
    5000,
    "return switch failed",
  );
  for (const [id, marker] of [
    [a.id, "LARGE-A-TAIL"],
    [b.id, "LARGE-B-TAIL"],
    [a.id, "LARGE-A-TAIL"],
  ]) {
    await evaluate(small, `window.bcwebmux.switchSession(${JSON.stringify(id)})`);
    await healthy(small, id, marker);
  }
  await delay(100);
  for (const page of pages) {
    assert.deepEqual(
      page.events.filter((event) => event.method === "Runtime.exceptionThrown"),
      [],
    );
    assert.deepEqual(
      page.events.filter(
        (event) => event.method === "Runtime.consoleAPICalled" && event.params.type === "error",
      ),
      [],
    );
  }
  console.log(`multi-client checkpoint restore and session switching passed (${backend})`);
} catch (error) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bcwebmux-multiclient-failure-"));
  await writeFile(path.join(dir, "server.log"), logs);
  for (const [index, page] of pages.entries()) {
    const screenshot = await page
      .call("Page.captureScreenshot", { format: "png" })
      .catch(() => null);
    if (screenshot)
      await writeFile(
        path.join(dir, `client-${index}.png`),
        Buffer.from(screenshot.data, "base64"),
      );
    await writeFile(path.join(dir, `client-${index}.json`), JSON.stringify(page.events, null, 2));
  }
  console.error(`Browser failure artifacts: ${dir}`);
  throw error;
} finally {
  for (const page of pages) page.disconnect();
  browser?.disconnect();
  await terminateProcess(chromium);
  await terminateProcess(server);
  await rm(profile, { recursive: true, force: true });
}
