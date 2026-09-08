// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Cdp, freePort, terminateProcess, waitFor } from "./test-support.mjs";

const [serverPath, webRoot] = process.argv.slice(2);
assert.ok(serverPath && webRoot, "usage: session-browser-resume.mjs SERVER WEB_ROOT");
const serverPort = await freePort();
const debugPort = await freePort();
const base = `http://127.0.0.1:${serverPort}`;
const profile = await mkdtemp(path.join(os.tmpdir(), "bcwebmux-session-browser-"));
const server = spawn(serverPath, ["--web-root", webRoot, "--port", String(serverPort), "--origin", base], {
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", data => { serverLog += data; });
server.stderr.on("data", data => { serverLog += data; });
let chromium;
let page;
let browser;

try {
  await waitFor(async () => (await fetch(`${base}/api/server`).catch(() => null))?.ok, 10000, "server failed to start");
  const font = await fetch(`${base}/fonts/JetBrainsMonoNerdFontMono-Regular.ttf`);
  assert.equal(font.status, 200);
  assert.match(font.headers.get("content-type") || "", /^font\/ttf(?:;|$)/);
  assert.equal(font.headers.get("cache-control"), "public, no-cache, must-revalidate");
  assert.match(font.headers.get("etag") || "", /^"[0-9a-f]{64}"$/);
  assert.ok((await font.arrayBuffer()).byteLength > 2 * 1024 * 1024);
  const dialogs = await fetch(`${base}/dialogs.css`);
  assert.equal(dialogs.status, 200);
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
  ], { stdio: ["ignore", "ignore", "pipe"] });

  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`).catch(() => null);
    if (!response?.ok) return null;
    return (await response.json()).find(item => item.type === "page" && item.url.includes("session-test=1"));
  }, 15000, "Chromium did not expose session page");
  const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
  browser = await Cdp.connect(version.webSocketDebuggerUrl);
  page = await Cdp.connect(target.webSocketDebuggerUrl);
  await page.call("Runtime.enable");
  await page.call("Page.enable");

  await waitBrowser(page, "window.bcwebmux?.connected === true", 10000, "initial attachment did not become live");
  const initial = await evaluate(page, "({ id: window.bcwebmux.activeSessionId, client: window.bcwebmux.clientInstanceId, cores: window.bcwebmux.coreCount })");
  assert.match(initial.id, /^[0-9a-f-]{36}$/);
  assert.match(initial.client, /^[0-9a-f-]{36}$/);
  assert.equal(initial.cores, 1);

  await evaluate(page, `window.bcwebmux.write("echo L3PID=$$; echo BEFORE-RELOAD; M=WHILE; N=-DETACHED; (sleep 0.4; echo $M$N)&\\n")`);
  await waitBrowser(page, `/L3PID=\\d+/.test(window.bcwebmux.sessionText())`, 5000, "pre-reload output missing");
  const beforeText = await evaluate(page, "window.bcwebmux.sessionText()");
  const pid = beforeText.match(/L3PID=(\d+)/)?.[1];
  assert.ok(pid, beforeText);

  await page.call("Page.reload", { ignoreCache: true });
  await waitBrowser(page, "window.bcwebmux?.connected === true", 10000, "reloaded attachment did not become live");
  await waitBrowser(page, `window.bcwebmux.sessionText().includes("WHILE-DETACHED")`, 5000, "detached output was not replayed");
  const resumed = await evaluate(page, `({ id: window.bcwebmux.activeSessionId, text: window.bcwebmux.sessionText(), cores: window.bcwebmux.coreCount, client: window.bcwebmux.clientInstanceId })`);
  assert.equal(resumed.id, initial.id);
  assert.equal(resumed.client, initial.client);
  assert.equal(resumed.cores, 1);
  assert.match(resumed.text, new RegExp(`L3PID=${pid}`));
  assert.equal((resumed.text.match(/WHILE-DETACHED/g) || []).length, 1, resumed.text);

  const terminate = await fetch(`${base}/api/sessions/${initial.id}/terminate`, {
    method: "POST",
    headers: { Origin: base, "Idempotency-Key": "browser-checkpoint-terminate" },
  });
  assert.equal(terminate.status, 202);
  await waitFor(async () => (await (await fetch(`${base}/api/sessions/${initial.id}`)).json()).state === "exited", 5000, "session did not exit");

  await page.call("Page.reload", { ignoreCache: true });
  await waitBrowser(page, "window.bcwebmux?.connected === true", 10000, "checkpoint attachment did not become live");
  const restored = await evaluate(page, `({ id: window.bcwebmux.activeSessionId, text: window.bcwebmux.sessionText(), cores: window.bcwebmux.coreCount, state: window.bcwebmux.state })`);
  assert.equal(restored.id, initial.id);
  assert.equal(restored.cores, 1);
  assert.match(restored.text, /BEFORE-RELOAD/);
  assert.match(restored.text, /WHILE-DETACHED/);
  assert.equal(restored.state.sessionState, "exited");
  assert.equal(restored.state.replyBytes, 0);
  const exceptions = page.events.filter(event => event.method === "Runtime.exceptionThrown");
  assert.deepEqual(exceptions, [], JSON.stringify(exceptions));
} catch (error) {
  error.message += `\nServer log:\n${serverLog}`;
  throw error;
} finally {
  page?.close();
  browser?.close();
  await terminateProcess(chromium);
  await terminateProcess(server);
  await rm(profile, { recursive: true, force: true });
}

async function evaluate(cdp, expression) {
  const response = await cdp.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || "browser evaluation failed");
  return response.result.value;
}

async function waitBrowser(cdp, expression, timeout, message) {
  return waitFor(async () => Boolean(await evaluate(cdp, expression).catch(() => false)), timeout, message);
}
