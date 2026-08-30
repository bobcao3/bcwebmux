// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        this.events.push(message);
        return;
      }
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

const [serverPath, webRoot] = process.argv.slice(2);
assert.ok(serverPath && webRoot, "usage: terminal-core-integration.mjs SERVER WEB_ROOT");
const deviceScaleFactor = Number(process.env.DEVICE_SCALE_FACTOR ?? "1.25");
assert.ok(Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0, "DEVICE_SCALE_FACTOR must be a positive number");
const backend = process.env.RENDER_BACKEND ?? "webgpu";
assert.ok(backend === "webgl2" || backend === "webgpu", "RENDER_BACKEND must be webgl2 or webgpu");
const serverPort = await freePort();
const debugPort = await freePort();
const profile = await mkdtemp(path.join(os.tmpdir(), "bcwebmux-terminal-core-integration-"));
const server = spawn(serverPath, ["--web-root", webRoot, "--port", String(serverPort)], {
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (data) => { serverLog += data; });
server.stderr.on("data", (data) => { serverLog += data; });
let chromium;
let pageCdp;
let browserCdp;

try {
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${serverPort}/terminal-core/index.html?backend=${backend}`).catch(() => null);
    return response?.ok;
  }, 10000, () => `server failed to start\n${serverLog}`);

  chromium = spawn(process.env.CHROMIUM || "chromium", [
    "--headless=new",
    `--force-device-scale-factor=${deviceScaleFactor}`,
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
    `http://127.0.0.1:${serverPort}/terminal-core/index.html?backend=${backend}`,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let chromiumLog = "";
  chromium.stderr.on("data", (data) => { chromiumLog += data; });

  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`).catch(() => null);
    if (!response?.ok) return null;
    const targets = await response.json();
    return targets.find((item) => item.type === "page" && item.url.includes(`terminal-core/index.html?backend=${backend}`));
  }, 15000, () => `Chromium failed to expose test page\n${chromiumLog}`);

  const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
  browserCdp = await Cdp.connect(version.webSocketDebuggerUrl);
  const system = await browserCdp.call("SystemInfo.getInfo");
  const gpuText = [
    ...(system.gpu?.devices || []).flatMap((device) => [device.vendorString, device.deviceString]),
    system.gpu?.auxAttributes?.glRenderer,
  ].filter(Boolean).join(" ");
  assert.ok(gpuText, "Chromium reported no GPU");
  assert.doesNotMatch(gpuText, /swiftshader|llvmpipe|software rasterizer/i);

  pageCdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await pageCdp.call("Runtime.enable");
  await pageCdp.call("Page.enable");
  const response = await pageCdp.call("Runtime.evaluate", {
    expression: "(async () => { const end = Date.now() + 10000; while (!window.terminalCoreTest && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50)); if (!window.terminalCoreTest) throw new Error(\"terminal core integration did not initialize\"); return await window.terminalCoreTest; })()",
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    const screenshot = await pageCdp.call("Page.captureScreenshot", { format: "png" }).catch(() => null);
    if (screenshot) {
      const pathName = path.join(os.tmpdir(), `terminal-core-integration-${Date.now()}.png`);
      await writeFile(pathName, Buffer.from(screenshot.data, "base64"));
      serverLog += `\nscreenshot: ${pathName}`;
    }
    throw new Error(`${response.exceptionDetails.exception?.description || "terminal core integration failed"}\n${serverLog}`);
  }
  const result = response.result.value;
  assert.equal(result.backend, backend);
  assert.ok(Math.abs(result.devicePixelRatio - deviceScaleFactor) < 0.01);
  assert.equal(result.atlas.tileWidth, result.physicalCellWidth);
  assert.equal(result.atlas.tileHeight, result.physicalCellHeight);
  assert.equal(result.atlas.textureBytes, result.atlas.capacity * result.physicalCellWidth * result.physicalCellHeight);
  assert.equal(result.coreCount, 2);
  const coreA = result.partitions.coreA;
  const coreB = result.partitions.coreB;
  assert.ok(
    coreA.base + coreA.capacity <= coreB.base ||
    coreB.base + coreB.capacity <= coreA.base,
  );
  assert.equal(result.partitions.temporary.base, result.partitions.replacement.base);
  assert.equal(result.atlas.requiredSlots, coreA.capacity + coreB.capacity);
  assert.ok(result.atlas.capacity >= result.atlas.requiredSlots);
  assert.ok(result.atlas.cacheHits > 0);
  assert.ok(result.coreSwitches >= 14);
  assert.ok(result.gpuFrames >= result.coreSwitches);
  assert.ok(result.coreBMemoryBeforeRender < 20 * 1024 * 1024, JSON.stringify(result));
  assert.ok(result.coreBMemoryAfterRender > result.coreBMemoryBeforeRender, JSON.stringify(result));
  assert.equal(result.budgetRollback, true);
  assert.ok(result.colorA[0] > result.colorA[1] * 2 && result.colorA[0] > result.colorA[2] * 2, JSON.stringify(result));
  assert.ok(result.colorB[1] > result.colorB[0] * 2 && result.colorB[2] > result.colorB[0] * 2, JSON.stringify(result.colorB));
  assert.ok(result.redPixels >= 4);
  assert.match(result.textA, /A-WROTE-WHILE-INACTIVE/);
  assert.match(result.snapshotText, /SNAPSHOT-CONTINUATION/);
  assert.match(result.primaryText, /PRIMARY SNAPSHOT READY/);
  assert.match(result.utf8Text, /😄 UTF8-CONTINUATION/);
  assert.equal(result.replies, "\x1b[0n");
  assert.equal(result.disposeReplies, 1);
  assert.equal(result.userData, "u");
  assert.equal(result.hostData, "u");
  const exceptions = pageCdp.events.filter((event) => event.method === "Runtime.exceptionThrown");
  assert.deepEqual(exceptions, [], JSON.stringify(exceptions));
} finally {
  pageCdp?.close();
  browserCdp?.close();
  await terminate(chromium);
  await terminate(server);
  await rm(profile, { recursive: true, force: true });
}

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function waitFor(check, timeout, message) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message());
}

async function terminate(process) {
  if (!process || process.exitCode !== null) return;
  process.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => process.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
  if (process.exitCode === null) process.kill("SIGKILL");
}
