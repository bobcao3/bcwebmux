// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    socket.addEventListener("message", event => {
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

  close() {
    this.socket.close();
  }
}

const [serverPath, webRoot] = process.argv.slice(2);
assert.ok(serverPath && webRoot, "usage: gpu-e2e.mjs SERVER WEB_ROOT");
const serverPort = await freePort();
const debugPort = await freePort();
const rendererQuery = process.env.TEXT_RENDERER === "kb-canvas" ? "&renderer=kb-canvas" : "";
const profile = await mkdtemp(path.join(os.tmpdir(), "bcwebmux-gpu-e2e-"));
const server = spawn(serverPath, ["--web-root", webRoot, "--port", String(serverPort)], {
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", data => { serverLog += data; });
server.stderr.on("data", data => { serverLog += data; });
let chromium;
let bundledServer;
let pageCdp;
let browserCdp;

const rgbCommand = "printf '\\033[2J\\033[H\\033[48;2;255;0;0m \\033[48;2;0;255;0m \\033[48;2;0;0;255m \\033[0mX\\n'";
const imePattern = "test \"$c\" = OK && printf '\\033[2J\\033[H\\033[48;2;255;255;0m \\033[0m中\\n'";
const softCommand = "stty -icanon -echo -isig min 2 time 0; printf '\\033[2J\\033[H\\033[48;2;64;64;64m \\033[0m'; dd of=/dev/null bs=2 count=1 2>/dev/null; stty sane; printf '\\033[2J\\033[H\\033[48;2;255;0;255m \\033[0mS\\n'\r";
const mouseCommand = "stty -icanon -echo min 6 time 0; printf '\\033[?1000h\\033[2J\\033[H\\033[48;2;255;128;0m \\033[0m'; dd of=/dev/null bs=6 count=1 2>/dev/null; stty sane; printf '\\033[?1000l\\033[2J\\033[H\\033[48;2;0;255;255m \\033[0mM\\n'\r";
const specialKeysCommand = "stty raw -echo; printf '\\033[2J\\033[H\\033[48;2;64;64;64m \\033[0m'; keys=$(dd bs=1 count=26 2>/dev/null); stty sane; test \"$keys\" = \"$(printf '\\033[A\\033[B\\033[D\\033[C\\033[H\\033[F\\033[5~\\033[6~')\" && printf '\\033[2J\\033[H\\033[48;2;0;255;0m \\033[0m'\r";
const cursorMoveCommand = "stty raw -echo; printf '\\033[2J\\033[H\\033[2 q\\033[48;2;255;0;0m \\033[0m\\033[4G'; dd of=/dev/null bs=1 count=3 2>/dev/null; printf '\\033[D'; sleep 1; stty sane\r";
const historyCommand = "stty -ixon; printf '\\033[3J\\033[2J\\033[H\\033[48;2;255;0;255m \\033[0mHISTORY\\n'; seq 1 40\r";

try {
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${serverPort}/`).catch(() => null);
    return response?.ok;
  }, 10000, () => `server failed to start\n${serverLog}`);

  const stylePath = path.join(webRoot, "style.css");
  const originalStyle = await readFile(stylePath, "utf8");
  const marker = `bcwebmux-hot-reload-${Date.now()}-${Math.random()}`;
  try {
    await writeFile(stylePath, `${originalStyle}\n/* ${marker} */\n`);
    const response = await fetch(`http://127.0.0.1:${serverPort}/style.css?hot-reload=1`);
    assert.ok(response.ok, `overlay style request failed: ${response.status}`);
    assert.match(await response.text(), new RegExp(marker));
  } finally {
    await writeFile(stylePath, originalStyle);
  }

  const bundledPort = await freePort();
  let bundledLog = "";
  bundledServer = spawn(serverPath, ["--port", String(bundledPort)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  bundledServer.stdout.on("data", data => { bundledLog += data; });
  bundledServer.stderr.on("data", data => { bundledLog += data; });
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${bundledPort}/`).catch(() => null);
    return response?.ok;
  }, 10000, () => `bundled server failed to start\n${bundledLog}`);
  const bundledResponses = await Promise.all([
    fetch(`http://127.0.0.1:${bundledPort}/`),
    fetch(`http://127.0.0.1:${bundledPort}/client.js`),
    fetch(`http://127.0.0.1:${bundledPort}/fzstd.js`),
    fetch(`http://127.0.0.1:${bundledPort}/terminal.wasm`),
    fetch(`http://127.0.0.1:${bundledPort}/fonts/OFL.txt`),
    fetch(`http://127.0.0.1:${bundledPort}/fonts/NotoEmoji-Regular.woff2`),
  ]);
  const [
    bundledIndex,
    bundledClient,
    bundledFzstd,
    bundledWasm,
    bundledLicense,
    bundledEmojiFont,
  ] = bundledResponses;
  for (const response of bundledResponses) assert.ok(response.ok, `bundled request failed: ${response.status}`);
  assert.match(bundledIndex.headers.get("content-type") || "", /^text\/html(?:;|$)/);
  assert.match(bundledClient.headers.get("content-type") || "", /^(?:text\/javascript|application\/javascript)(?:;|$)/);
  assert.match(bundledFzstd.headers.get("content-type") || "", /^(?:text\/javascript|application\/javascript)(?:;|$)/);
  assert.match(bundledWasm.headers.get("content-type") || "", /^application\/wasm(?:;|$)/);
  assert.match(bundledLicense.headers.get("content-type") || "", /^text\/plain(?:;|$)/);
  assert.match(bundledEmojiFont.headers.get("content-type") || "", /^font\/woff2(?:;|$)/);
  const bundledCsp = bundledIndex.headers.get("content-security-policy") || "";
  const cspDirective = name => bundledCsp.match(new RegExp(`(?:^|;)\\s*${name}\\s+([^;]+)`))?.[1].trim();
  assert.equal(cspDirective("style-src"), "'self' https://fonts.googleapis.com");
  assert.equal(cspDirective("font-src"), "'self' https://fonts.gstatic.com");
  assert.doesNotMatch(bundledCsp, /(?:^|;)\s*(?:style-src|font-src)\s+[^;]*https:(?:\s|;|$)/);
  const bundledIndexText = await bundledIndex.text();
  assert.match(bundledIndexText, /bcwebmux/);
  assert.match(bundledIndexText, /https:\/\/fonts\.googleapis\.com\/css2\?family=Fira\+Code:wght@400;700/);
  assert.equal(await bundledClient.text(), await readFile(path.join(webRoot, "client.js"), "utf8"));
  assert.equal(await bundledFzstd.text(), await readFile(path.join("node_modules", "fzstd", "esm", "index.mjs"), "utf8"));
  assert.deepEqual(
    Buffer.from(await bundledWasm.arrayBuffer()),
    await readFile(path.join(webRoot, "terminal.wasm")),
  );
  await terminate(bundledServer);
  bundledServer = null;

  chromium = spawn(process.env.CHROMIUM || "chromium", [
    "--headless=new",
    "--force-device-scale-factor=1.25",
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
    `http://127.0.0.1:${serverPort}/?gpu-test=1${rendererQuery}`,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let chromiumLog = "";
  chromium.stderr.on("data", data => { chromiumLog += data; });

  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`).catch(() => null);
    if (!response?.ok) return null;
    const targets = await response.json();
    return targets.find(item => item.type === "page" && item.url.startsWith(`http://127.0.0.1:${serverPort}/?gpu-test=1${rendererQuery}`));
  }, 15000, () => `Chromium failed to expose the page\n${chromiumLog}`);

  const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
  browserCdp = await Cdp.connect(version.webSocketDebuggerUrl);
  const system = await browserCdp.call("SystemInfo.getInfo");
  const gpuDeviceText = [
    ...(system.gpu?.devices || []).flatMap(device => [device.vendorString, device.deviceString]),
    system.gpu?.auxAttributes?.glRenderer,
    system.gpu?.auxAttributes?.glVendor,
  ].filter(Boolean).join(" ");
  assert.ok(gpuDeviceText, "Chromium did not report a GPU device");
  assert.doesNotMatch(gpuDeviceText, /swiftshader|llvmpipe|software rasterizer/i, gpuDeviceText);

  pageCdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await pageCdp.call("Runtime.enable");
  await pageCdp.call("Page.enable");
  await waitFor(async () => {
    const response = await pageCdp.call("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }).catch(() => null);
    return response?.result?.value === "complete";
  }, 10000, () => "page failed to become ready");

  const expression = `(async () => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const started = performance.now();
    let readbacks = 0;
    const deadline = ms => Date.now() + ms;
    let until = deadline(5000);
    while (!window.bcwebmux?.connected && Date.now() < until) await sleep(20);
    if (!window.bcwebmux?.connected) throw new Error("terminal did not connect");
    if ("screenText" in window.bcwebmux || "hasColoredText" in window.bcwebmux || "colorsForText" in window.bcwebmux) {
      throw new Error("fake CPU renderer inspection API is still present");
    }

    const canvas = document.querySelector("#screen");
    const terminal = document.querySelector("#terminal");
    const viewport = document.querySelector("#terminal-viewport");
    const input = document.querySelector("#input");
    const chrome = document.querySelector("#terminal-chrome");
    const settingsDialog = document.querySelector("#settings-dialog");
    const settingsButton = document.querySelector("#settings-button");
    const selectionButton = document.querySelector("#selection-button");
    const softkeysToggle = document.querySelector("#softkeys-toggle");
    const settingsClose = document.querySelector("#settings-close");
    const scroll = document.querySelector("#scroll");
    const softkeys = document.querySelector("#softkeys");
    const controls = document.querySelector("#terminal-controls");
    const status = document.querySelector("#status");
    if (!viewport.contains(scroll)) throw new Error("viewport does not contain scroll");
    if (!viewport.contains(canvas)) throw new Error("viewport does not contain canvas");
    if (!viewport.contains(input)) throw new Error("viewport does not contain input");
    if (!chrome.contains(softkeys)) throw new Error("chrome does not contain softkeys");
    if (!chrome.contains(controls)) throw new Error("chrome does not contain terminal controls");
    if (!chrome.contains(status)) throw new Error("chrome does not contain status");
    if (!chrome.contains(settingsButton)) throw new Error("chrome does not contain settings button");
    if (!controls.contains(selectionButton)) throw new Error("terminal controls do not contain selection button");
    if (!controls.contains(softkeysToggle)) throw new Error("terminal controls do not contain softkeys toggle");
    if (selectionButton.nextElementSibling !== softkeysToggle) throw new Error("softkeys toggle does not directly follow selection button");
    if (!softkeysToggle.querySelector("svg")) throw new Error("softkeys toggle has no SVG");
    if (softkeysToggle.textContent.trim() !== "") throw new Error("softkeys toggle contains text");
    if (getComputedStyle(selectionButton).display !== "none") throw new Error("selection button is visible on desktop");
    if (getComputedStyle(softkeysToggle).display === "none") throw new Error("softkeys toggle is hidden on desktop");
    if (window.bcwebmux.enterSelectionMode() !== false) throw new Error("desktop enterSelectionMode did not return false");
    if (window.bcwebmux.selectionMode !== false) throw new Error("desktop selection mode was enabled");
    if (window.bcwebmux.state.softkeysVisible !== false) throw new Error("softkeys are visible before toggling");
    if (softkeysToggle.getAttribute("aria-pressed") !== "false") throw new Error("softkeys toggle is pressed before toggling");
    if (!/^Show\\b/.test(softkeysToggle.getAttribute("aria-label") || "")) throw new Error("softkeys toggle does not have a Show label");
    if (getComputedStyle(softkeys).display !== "none") throw new Error("softkeys are displayed before toggling");
    if (document.querySelector("#text-view").childElementCount !== 0) throw new Error("desktop text view has children");
    if (viewport.contains(chrome)) throw new Error("viewport contains chrome");
    if (viewport.contains(softkeys)) throw new Error("viewport contains softkeys");
    if (terminal.contains(settingsDialog)) throw new Error("terminal contains settings dialog");
    const tolerance = 1;
    let chromeRect = chrome.getBoundingClientRect();
    let softkeysRect = softkeys.getBoundingClientRect();
    let controlsRect = controls.getBoundingClientRect();
    if (Math.abs(controlsRect.top - chromeRect.top) > tolerance) throw new Error("controls do not start at chrome top before softkeys are enabled");
    if (Math.abs(controlsRect.bottom - chromeRect.bottom) > tolerance) throw new Error("controls do not end at chrome bottom before softkeys are enabled");
    const toggleRect = softkeysToggle.getBoundingClientRect();
    if (Math.abs(toggleRect.left - controlsRect.left) > 8) throw new Error("softkeys toggle is not left-aligned on desktop");
    softkeysToggle.click();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (window.bcwebmux.state.softkeysVisible !== true) throw new Error("softkeys did not become visible");
    if (softkeysToggle.getAttribute("aria-pressed") !== "true") throw new Error("softkeys toggle is not pressed");
    if (!/^Hide\\b/.test(softkeysToggle.getAttribute("aria-label") || "")) throw new Error("softkeys toggle does not have a Hide label");
    if (getComputedStyle(softkeys).display === "none") throw new Error("softkeys are still hidden after toggling");
    chromeRect = chrome.getBoundingClientRect();
    softkeysRect = softkeys.getBoundingClientRect();
    controlsRect = controls.getBoundingClientRect();
    if (Math.abs(softkeysRect.top - chromeRect.top) > tolerance) throw new Error("softkeys do not start at chrome top");
    if (Math.abs(controlsRect.top - softkeysRect.bottom) > tolerance) throw new Error("terminal controls do not start at softkeys bottom");
    if (Math.abs(controlsRect.bottom - chromeRect.bottom) > tolerance) throw new Error("terminal controls do not end at chrome bottom");
    for (const [name, element] of [["status", status], ["settings button", settingsButton]]) {
      const rect = element.getBoundingClientRect();
      const centerX = (rect.left + rect.right) / 2;
      const centerY = (rect.top + rect.bottom) / 2;
      if (
        centerX < controlsRect.left - tolerance ||
        centerX > controlsRect.right + tolerance ||
        centerY < controlsRect.top - tolerance ||
        centerY > controlsRect.bottom + tolerance ||
        centerY < softkeysRect.bottom - tolerance
      ) {
        throw new Error(name + " center is not within the controls row");
      }
    }
    const capture = async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const image = await window.bcwebmux.readPixels();
      const style = getComputedStyle(terminal);
      const bgra = image.format?.toLowerCase().startsWith("bgra");
      const redOffset = bgra ? 2 : 0;
      const blueOffset = bgra ? 0 : 2;
      const sx = image.width / canvas.clientWidth;
      const sy = image.height / canvas.clientHeight;
      const cellWidth = parseFloat(style.getPropertyValue("--cell-width")) * sx;
      const cellHeight = parseFloat(style.getPropertyValue("--cell-height")) * sy;
      readbacks += 1;
      const average = (cellX, cellY) => {
        const x0 = Math.max(0, Math.floor((cellX + 0.3) * cellWidth));
        const x1 = Math.min(image.width, Math.ceil((cellX + 0.7) * cellWidth));
        const y0 = Math.max(0, Math.floor((cellY + 0.3) * cellHeight));
        const y1 = Math.min(image.height, Math.ceil((cellY + 0.7) * cellHeight));
        let r = 0, g = 0, b = 0, count = 0;
        for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
          const offset = (y * image.width + x) * 4;
          r += image.data[offset + redOffset]; g += image.data[offset + 1]; b += image.data[offset + blueOffset]; count += 1;
        }
        return [r / count, g / count, b / count];
      };
      const lit = (cellX, cellY, width = 1) => {
        const x0 = Math.max(0, Math.floor(cellX * cellWidth));
        const x1 = Math.min(image.width, Math.ceil((cellX + width) * cellWidth));
        const y0 = Math.max(0, Math.floor(cellY * cellHeight));
        const y1 = Math.min(image.height, Math.ceil((cellY + 1) * cellHeight));
        let count = 0;
        for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
          const offset = (y * image.width + x) * 4;
          if (image.data[offset] > 120 && image.data[offset + 1] > 120 && image.data[offset + 2] > 120) count += 1;
        }
        return count;
      };
      return { red: average(0, 0), green: average(1, 0), blue: average(2, 0), glyph: lit(3, 0), first: average(0, 0), third: average(2, 0), fourth: average(3, 0), wideGlyph: lit(1, 0, 2) };
    };
    const near = (value, expected) => Math.abs(value - expected) < 35;
    const isRgbPattern = probe => near(probe.red[0], 255) && near(probe.red[1], 0) && near(probe.red[2], 0) &&
      near(probe.green[0], 0) && near(probe.green[1], 255) && near(probe.green[2], 0) &&
      near(probe.blue[0], 0) && near(probe.blue[1], 0) && near(probe.blue[2], 255) && probe.glyph > 2;
    const waitPixels = async (predicate, label) => {
      const end = deadline(2500);
      let probe;
      while (Date.now() < end) {
        probe = await capture();
        if (predicate(probe)) return probe;
        await sleep(15);
      }
      throw new Error(label + ": " + JSON.stringify(probe) + " " + JSON.stringify({ elapsed: performance.now() - started, state: window.bcwebmux.state }));
    };
    const keyCode = character => {
      if (/^[A-Za-z]$/.test(character)) return "Key" + character.toUpperCase();
      if (/^[0-9]$/.test(character)) return "Digit" + character;
      return ({ " ": "Space", "'": "Quote", "\\\\": "Backslash", "[": "BracketLeft", "]": "BracketRight", ";": "Semicolon" })[character] || "Unidentified";
    };
    if (terminal.tabIndex !== -1) throw new Error("terminal is focusable via tabIndex");
    const inputRect = input.getBoundingClientRect();
    if (!(inputRect.width > 0 && inputRect.height > 0)) throw new Error("hidden textarea has no rendered size");
    input.blur();
    for (const type of ["pointerdown", "pointerup"]) {
      scroll.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "touch", pointerId: 1 }));
    }
    if (document.activeElement === input) throw new Error("touch pointerdown/up prematurely focused input");
    scroll.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    if (document.activeElement !== input) throw new Error("completed tap did not focus input");
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (document.activeElement !== input) throw new Error("completed tap did not keep input focused");
    input.blur();
    window.dispatchEvent(new Event("focus"));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (document.activeElement !== input) throw new Error("desktop focus was not restored");
    settingsButton.click();
    if (settingsDialog.open !== true) throw new Error("settings dialog did not open");
    if (document.activeElement === input) throw new Error("settings dialog did not move focus");
    const tabs = Object.fromEntries(["COLOR", "FONT", "PERF"].map(label => [
      label,
      [...settingsDialog.querySelectorAll("button")].find(button => button.textContent.trim() === label),
    ]));
    if (Object.values(tabs).some(tab => !tab)) throw new Error("settings tabs are missing");
    const panels = Object.fromEntries(Object.entries(tabs).map(([label, tab]) => [
      label,
      document.getElementById(tab.getAttribute("aria-controls") || ""),
    ]));
    if (Object.values(panels).some(panel => !panel)) throw new Error("settings panels are missing");
    const grainStrength = panels.COLOR.querySelector("#grain-strength");
    const grainStrengthValue = panels.COLOR.querySelector("#grain-strength-value");
    if (!grainStrength || !grainStrengthValue) throw new Error("grain strength controls are missing");
    if (grainStrength.value !== "4") throw new Error("grain strength default is not 4");
    if (window.bcwebmux.state.grainStrength !== 4) throw new Error("renderer grain strength default is not 4");
    grainStrength.value = "12";
    grainStrength.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (grainStrengthValue.textContent !== "12 / 255") throw new Error("grain strength output did not update");
    if (window.bcwebmux.state.grainStrength !== 12) throw new Error("renderer grain strength did not update");
    grainStrength.dispatchEvent(new Event("change", { bubbles: true }));
    grainStrength.value = "4";
    grainStrength.dispatchEvent(new Event("input", { bubbles: true }));
    grainStrength.dispatchEvent(new Event("change", { bubbles: true }));
    const rendererSelect = panels.FONT.querySelector("select");
    if (!rendererSelect) throw new Error("renderer select is missing");
    const rendererValues = [...rendererSelect.options].map(option => option.value);
    if (JSON.stringify(rendererValues) !== JSON.stringify(["kb-stb", "kb-canvas"])) {
      throw new Error("renderer select options are invalid: " + JSON.stringify(rendererValues));
    }
    const fontFamilySelect = panels.FONT.querySelector('select[name="fontFamily"]');
    if (!fontFamilySelect) throw new Error("font family select is missing");
    const firaOption = [...fontFamilySelect.options].find(option => option.value === "fira-code");
    const stbOption = [...rendererSelect.options].find(option => option.value === "kb-stb");
    if (!firaOption || !stbOption) throw new Error("font family or kb-stb option is missing");
    if (!/Canvas only/i.test(firaOption.textContent)) throw new Error("Fira Code option is not marked Canvas only");
    const firaFacesLoaded = () => [400, 700].every(weight =>
      [...document.fonts].some(face =>
        face.family === "Fira Code" &&
        face.style === "normal" &&
        face.weight === String(weight) &&
        face.status === "loaded",
      ),
    );
    const firaReloads = window.bcwebmux.state.fontReloads;
    fontFamilySelect.value = "fira-code";
    fontFamilySelect.dispatchEvent(new Event("change", { bubbles: true }));
    until = deadline(5000);
    while (
      Date.now() < until &&
      (
        window.bcwebmux.state.textRenderer !== "kb-canvas" ||
        !firaFacesLoaded() ||
        window.bcwebmux.state.fontReloads <= firaReloads
      )
    ) await sleep(20);
    if (window.bcwebmux.state.textRenderer !== "kb-canvas") throw new Error("Fira Code did not select canvas renderer");
    if (!firaFacesLoaded()) throw new Error("Fira Code normal 400 and 700 faces did not load");
    if (rendererSelect.value !== "kb-canvas") throw new Error("Fira Code did not select kb-canvas");
    if (!stbOption.disabled) throw new Error("kb-stb was not disabled for Fira Code");
    if (window.bcwebmux.state.fontReloads <= firaReloads) throw new Error("Fira Code font reload was not observed");
    if (!window.bcwebmux.state.fontFamily.includes("Fira Code")) throw new Error("Fira Code font family was not applied");
    const jetbrainsReloads = window.bcwebmux.state.fontReloads;
    fontFamilySelect.value = "jetbrains-mono";
    fontFamilySelect.dispatchEvent(new Event("change", { bubbles: true }));
    if (stbOption.disabled) throw new Error("kb-stb did not re-enable for JetBrains Mono");
    rendererSelect.value = "kb-stb";
    rendererSelect.dispatchEvent(new Event("change", { bubbles: true }));
    until = deadline(2500);
    while (
      (
        window.bcwebmux.state.textRenderer !== "kb-stb" ||
        window.bcwebmux.state.fontReloads <= jetbrainsReloads
      ) &&
      Date.now() < until
    ) await sleep(20);
    if (window.bcwebmux.state.textRenderer !== "kb-stb") throw new Error("kb-stb renderer was not restored");
    if (window.bcwebmux.state.fontReloads <= jetbrainsReloads) throw new Error("JetBrains Mono font reload was not observed");
    if (!window.bcwebmux.state.fontFamily.includes("JetBrains Mono Nerd Font")) {
      throw new Error("JetBrains Mono Nerd Font was not applied");
    }
    const fontFallbacks = panels.FONT.querySelector('textarea[name="fontFallbacks"]');
    if (!fontFallbacks) throw new Error("font fallbacks textarea is missing");
    const fallbackFamilies = fontFallbacks.value.split(/\\r?\\n/).map(family => family.trim());
    if (fallbackFamilies[0]?.toLowerCase() !== "ui-monospace" || fallbackFamilies.at(-1)?.toLowerCase() !== "monospace") {
      throw new Error("font fallbacks must start with ui-monospace and end with monospace");
    }
    if (new Set(fallbackFamilies.map(family => family.toLowerCase())).size !== fallbackFamilies.length) {
      throw new Error("font fallbacks contain duplicate family names");
    }
    const notoEmojiIndex = fallbackFamilies.indexOf("Noto Emoji");
    const notoSymbolsIndex = fallbackFamilies.indexOf("Noto Sans Symbols 2");
    if (notoEmojiIndex !== 1 || notoSymbolsIndex < 0 || notoEmojiIndex >= notoSymbolsIndex) {
      throw new Error("font fallbacks must place Noto Emoji immediately after ui-monospace and before Noto Sans Symbols 2");
    }
    if (!document.fonts.check('15px "Noto Emoji"', "😀")) {
      throw new Error("Noto Emoji font was not loaded");
    }
    const emojiCanvas = document.createElement("canvas");
    emojiCanvas.width = 64;
    emojiCanvas.height = 64;
    const emojiContext = emojiCanvas.getContext("2d");
    if (!emojiContext) throw new Error("emoji rasterization context is unavailable");
    emojiContext.font = 'normal 400 32px "Noto Emoji"';
    emojiContext.fillStyle = "#fff";
    emojiContext.fillText("\u{1FAE0}", 0, 32);
    const emojiPixels = emojiContext.getImageData(0, 0, emojiCanvas.width, emojiCanvas.height).data;
    if (!emojiPixels.some((value, index) => index % 4 === 3 && value !== 0)) throw new Error("Noto Emoji did not rasterize");
    const perfOutput = document.querySelector("#perf");
    if (!perfOutput) throw new Error("performance output is missing");
    const simple = settingsDialog.querySelector('input[type="radio"][value="simple"]');
    const detailed = settingsDialog.querySelector('input[type="radio"][value="detailed"]');
    if (!simple || !detailed) throw new Error("performance mode radios are missing");
    tabs.PERF.click();
    simple.click();
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (perfOutput.dataset.mode !== "simple") throw new Error("performance mode did not become simple");
    if (getComputedStyle(perfOutput).display === "none" || getComputedStyle(perfOutput).visibility === "hidden") {
      throw new Error("performance panel is not visible");
    }
    if (perfOutput.value.includes("\\n")) throw new Error("simple performance output contains a newline");
    detailed.click();
    if (perfOutput.dataset.mode !== "detailed") throw new Error("performance mode did not become detailed");
    tabs.COLOR.click();
    settingsClose.click();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (settingsDialog.open !== false) throw new Error("settings dialog did not close");
    if (document.activeElement !== settingsButton) throw new Error("settings close did not restore focus");
    scroll.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    if (document.activeElement !== input) throw new Error("completed tap did not focus input");
    for (const character of ${JSON.stringify(rgbCommand)}) {
      const code = keyCode(character);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: character, code, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { key: character, code, bubbles: true }));
    }
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "", keyCode: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "", keyCode: 13, bubbles: true }));
    const keyboardPixels = await waitPixels(isRgbPattern, "keyboard-to-GPU pattern did not render");

    const compose = text => {
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      input.value = text;
      input.dispatchEvent(new CompositionEvent("compositionupdate", { data: text, bubbles: true }));
      input.dispatchEvent(new InputEvent("input", { data: text, inputType: "insertCompositionText", isComposing: true, bubbles: true }));
      input.dispatchEvent(new CompositionEvent("compositionend", { data: text, bubbles: true }));
    };
    compose("c=OX");
    await sleep(5);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", code: "", keyCode: 8, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Backspace", code: "", keyCode: 8, bubbles: true }));
    input.dispatchEvent(new InputEvent("beforeinput", { data: "K", inputType: "insertText", bubbles: true, cancelable: true }));
    input.value += "K";
    input.dispatchEvent(new InputEvent("input", { data: "K", inputType: "insertText", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "", keyCode: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "", keyCode: 13, bubbles: true }));
    compose(${JSON.stringify(imePattern)});
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "", keyCode: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "", keyCode: 13, bubbles: true }));
    const imePixels = await waitPixels(probe => near(probe.first[0], 255) && near(probe.first[1], 255) && near(probe.first[2], 0) && probe.wideGlyph > 4, "IME-to-GPU pattern did not render");

    window.bcwebmux.write(${JSON.stringify(softCommand)});
    await waitPixels(probe => near(probe.first[0], 64) && near(probe.first[1], 64) && near(probe.first[2], 64), "softkey readiness pattern did not render");
    softkeys.querySelector('[data-code="Escape"]').click();
    softkeys.querySelector('[data-code="Tab"]').click();
    const softPixels = await waitPixels(probe => near(probe.first[0], 255) && near(probe.first[1], 0) && near(probe.first[2], 255), "softkey-to-GPU pattern did not render");

    window.bcwebmux.write(${JSON.stringify(mouseCommand)});
    await waitPixels(probe => near(probe.first[0], 255) && near(probe.first[1], 128) && near(probe.first[2], 0), "mouse readiness pattern did not render");
    document.querySelector("#scroll").dispatchEvent(new WheelEvent("wheel", { deltaY: -100, clientX: 10, clientY: 10, bubbles: true, cancelable: true }));
    const mousePixels = await waitPixels(probe => near(probe.first[0], 0) && near(probe.first[1], 255) && near(probe.first[2], 255), "mouse-to-GPU pattern did not render");

    window.bcwebmux.write(${JSON.stringify(specialKeysCommand)});
    await waitPixels(probe => near(probe.first[0], 64) && near(probe.first[1], 64) && near(probe.first[2], 64), "special-key readiness pattern did not render");
    for (const keyCode of [38, 40, 37, 39, 36, 35, 33, 34]) {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Unidentified", code: "", keyCode, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { key: "Unidentified", code: "", keyCode, bubbles: true }));
    }
    const specialKeysPixels = await waitPixels(probe => near(probe.first[0], 0) && near(probe.first[1], 255) && near(probe.first[2], 0), "special keys did not produce the expected GPU success pattern");

    const bright = color => color.every(channel => channel > 70);
    window.bcwebmux.write(${JSON.stringify(cursorMoveCommand)});
    await waitPixels(probe =>
      near(probe.first[0], 255) && near(probe.first[1], 0) && near(probe.first[2], 0) &&
      bright(probe.fourth),
      "cursor readiness pattern did not render",
    );
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", code: "ArrowLeft", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowLeft", code: "ArrowLeft", bubbles: true }));
    const cursorMovePixels = await waitPixels(probe =>
      bright(probe.third) && probe.fourth.every(channel => channel < 70),
      "cursor-only move did not render",
    );

    window.bcwebmux.write(${JSON.stringify(historyCommand)});
    until = deadline(2500);
    while (scroll.scrollHeight <= scroll.clientHeight && Date.now() < until) await sleep(15);
    if (scroll.scrollHeight <= scroll.clientHeight) throw new Error("PTY output did not create scrollback");
    if (Math.abs(scroll.scrollTop - (scroll.scrollHeight - scroll.clientHeight)) > 1) {
      throw new Error("scrollback did not follow output: top=" + scroll.scrollTop + " bottom=" + (scroll.scrollHeight - scroll.clientHeight));
    }
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event("scroll"));
    const historyPixels = await waitPixels(probe => near(probe.first[0], 255) && near(probe.first[1], 0) && near(probe.first[2], 255), "scrollback GPU pattern did not render");
    await sleep(260);
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    input.value = "prediction";
    input.dispatchEvent(new CompositionEvent("compositionupdate", { data: "prediction", bubbles: true }));
    const modifierKeyStartBytes = window.bcwebmux.state.txBytes;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", code: "ControlLeft", ctrlKey: true, bubbles: true }));
    if (input.value !== "") throw new Error("Control keydown did not clear predictive composition");
    if (input.inputMode !== "none") throw new Error("Control keydown did not disable input mode");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "b", code: "KeyB", keyCode: 229, ctrlKey: true, isComposing: true, bubbles: true }));
    const beforeinputAccepted = input.dispatchEvent(new InputEvent("beforeinput", {
      data: "b",
      inputType: "insertCompositionText",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    }));
    if (beforeinputAccepted) throw new Error("Ctrl+B composition beforeinput was not prevented");
    input.value = "b";
    input.dispatchEvent(new InputEvent("input", { data: "b", inputType: "insertCompositionText", isComposing: true, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "b", code: "KeyB", ctrlKey: true, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Control", code: "ControlLeft", bubbles: true }));
    input.dispatchEvent(new CompositionEvent("compositionend", { data: "prediction", bubbles: true }));
    await sleep(5);
    if (input.inputMode !== "text") throw new Error("stale compositionend did not restore text input mode");
    if (input.value !== "") throw new Error("stale compositionend did not clear input");
    const modifierKeyBytes = window.bcwebmux.state.txBytes - modifierKeyStartBytes;
    if (modifierKeyBytes !== 1) throw new Error("Ctrl+B sent an unexpected number of bytes: " + modifierKeyBytes);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft", shiftKey: true, bubbles: true }));
    if (input.inputMode !== "text") throw new Error("Shift keydown changed input mode");
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", code: "ShiftLeft", bubbles: true }));

    const state = window.bcwebmux.state;
    return {
      keyboardPixels,
      imePixels,
      softPixels,
      mousePixels,
      specialKeysPixels,
      cursorMovePixels,
      historyPixels,
      modifierKeyBytes,
      readbacks,
      elapsed: performance.now() - started,
      nativeViewport: {
        width: canvas.width,
        height: canvas.height,
        clientWidth: canvas.clientWidth,
        clientHeight: canvas.clientHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      state,
    };
  })()`;

  const response = await pageCdp.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) {
    const runtimeExceptions = pageCdp.events.filter(event => event.method === "Runtime.exceptionThrown");
    throw new Error(`${response.exceptionDetails.exception?.description || "browser evaluation failed"}\nRuntime exceptions: ${JSON.stringify(runtimeExceptions)}`);
  }
  const value = response.result.value;
  const screenshot = await pageCdp.call("Page.captureScreenshot", { format: "png" });
  const viewportResponse = await pageCdp.call("Runtime.evaluate", {
    expression: "({ width: window.innerWidth, height: window.innerHeight })",
    returnByValue: true,
  });
  const { width: viewportWidth, height: viewportHeight } = viewportResponse.result.value;
  const clips = {
    terminal: {
      x: 0,
      y: 0,
      width: Math.min(320, viewportWidth),
      height: Math.min(160, viewportHeight),
      scale: 1,
    },
    telemetry: {
      x: Math.max(0, viewportWidth - 320),
      y: 0,
      width: Math.min(320, viewportWidth),
      height: Math.min(80, viewportHeight),
      scale: 1,
    },
    bottomBar: {
      x: 0,
      y: Math.max(0, viewportHeight - 104),
      width: viewportWidth,
      height: Math.min(104, viewportHeight),
      scale: 1,
    },
  };
  const visualScreenshots = {};
  for (const [name, clip] of Object.entries(clips)) {
    visualScreenshots[name] = await pageCdp.call("Page.captureScreenshot", { format: "png", clip });
  }
  const goldenPath = path.join("test", "golden");
  if (process.env.UPDATE_GOLDEN === "1") {
    await mkdir(goldenPath, { recursive: true });
    for (const [name, captured] of Object.entries(visualScreenshots)) {
      const buffer = Buffer.from(captured.data, "base64");
      await sharp(buffer).webp({ lossless: true }).toFile(path.join(goldenPath, `${name}.webp`));
    }
  }
  const visualPsnr = {};
  for (const [name, captured] of Object.entries(visualScreenshots)) {
    let expected;
    try {
      expected = await readFile(path.join(goldenPath, `${name}.webp`));
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error(`missing ${name} golden; run UPDATE_GOLDEN=1 zig build e2e`);
      }
      throw error;
    }
    const actualPng = await compareImagePsnr(Buffer.from(captured.data, "base64"), expected);
    visualPsnr[name] = actualPng.psnr;
  }
  assert.ok(visualPsnr.terminal >= 35, `terminal PSNR was ${visualPsnr.terminal} dB`);
  assert.ok(visualPsnr.telemetry >= 18, `telemetry PSNR was ${visualPsnr.telemetry} dB`);
  assert.ok(visualPsnr.bottomBar >= 32, `bottomBar PSNR was ${visualPsnr.bottomBar} dB`);
  const presentedResponse = await pageCdp.call("Runtime.evaluate", {
    expression: `(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(screenshot.data)}), character => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const width = bitmap.width;
      const height = bitmap.height;
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = context.getImageData(0, 0, width, height).data;
      const terminal = document.querySelector("#terminal");
      const style = getComputedStyle(terminal);
      const scale = width / window.innerWidth;
      const cellWidth = parseFloat(style.getPropertyValue("--cell-width")) * scale;
      const cellHeight = parseFloat(style.getPropertyValue("--cell-height")) * scale;
      const x0 = Math.floor(0.3 * cellWidth);
      const x1 = Math.ceil(0.7 * cellWidth);
      const y0 = Math.floor(0.3 * cellHeight);
      const y1 = Math.ceil(0.7 * cellHeight);
      let r = 0, g = 0, b = 0, count = 0;
      for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
        const offset = (y * width + x) * 4;
        r += pixels[offset];
        g += pixels[offset + 1];
        b += pixels[offset + 2];
        count += 1;
      }
      return [r / count, g / count, b / count];
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (presentedResponse.exceptionDetails) throw new Error(presentedResponse.exceptionDetails.exception?.description || "compositor screenshot evaluation failed");
  const presentedPixel = presentedResponse.result.value;
  assert.ok(
    Math.abs(presentedPixel[0] - 255) < 35 &&
    Math.abs(presentedPixel[1]) < 35 &&
    Math.abs(presentedPixel[2] - 255) < 35,
    `presented screenshot cell was not magenta: ${presentedPixel}`,
  );
  const state = value.state;
  const { nativeViewport } = value;
  assert.ok(nativeViewport.devicePixelRatio > 1);
  assert.ok(nativeViewport.width > nativeViewport.clientWidth);
  assert.ok(nativeViewport.height > nativeViewport.clientHeight);
  assert.equal(nativeViewport.width, Math.round(nativeViewport.clientWidth * nativeViewport.devicePixelRatio));
  assert.equal(nativeViewport.height, Math.round(nativeViewport.clientHeight * nativeViewport.devicePixelRatio));
  assert.equal(state.viewportWidth, nativeViewport.width);
  assert.equal(state.viewportHeight, nativeViewport.height);
  for (const name of ["physicalCellWidth", "physicalCellHeight", "physicalFontSize"]) {
    assert.ok(Number.isInteger(state[name]) && state[name] > 0, `${name} is invalid`);
  }
  assert.ok(state.cols * state.physicalCellWidth <= state.viewportWidth);
  assert.ok(state.rows * state.physicalCellHeight <= state.viewportHeight);
  assert.ok(Math.abs(state.pixelScaleX - nativeViewport.width / nativeViewport.clientWidth) <= 0.01);
  assert.ok(Math.abs(state.pixelScaleY - nativeViewport.height / nativeViewport.clientHeight) <= 0.01);
  assert.ok(Number.isFinite(state.rxWireBytes) && state.rxWireBytes > 0);
  assert.ok(Number.isFinite(state.rxBytes) && state.rxBytes > 0);
  for (const name of ["wasmParseMs", "wasmFrameMs", "rxLatencyMs", "inputLatencyMs", "frameMs", "gpuFrameMs", "queueDrainMs", "presentationOpportunityMs", "wsRttLatestMs", "wsRttMedianMs", "wsRttP95Ms"]) {
    assert.equal(typeof state[name], "number");
    assert.ok(Number.isFinite(state[name]) && state[name] >= 0, `${name} is invalid`);
  }
  assert.ok(state.wsRttMedianMs <= state.wsRttP95Ms, "WebSocket RTT median exceeds p95");
  assert.equal(state.connected, true);
  assert.equal(state.backend, "webgpu");
  assert.equal(state.gpuError, null);
  assert.equal(state.gpuFallbackAdapter, false);
  assert.doesNotMatch(JSON.stringify(state.gpuAdapter), /swiftshader|llvmpipe|software/i);
  assert.ok(Object.values(state.gpuAdapter).some(Boolean), "WebGPU adapter identity is empty");
  assert.ok(state.gpuFrames >= 5);
  assert.ok(state.bundleExecutions >= 5);
  assert.ok(state.rasterPasses >= 5);
  assert.equal(state.atlasFormat, "r8unorm");
  assert.ok(Number.isInteger(state.atlasRequiredSlots) && state.atlasRequiredSlots >= 256);
  assert.ok(state.atlasRequiredSlots >= state.atlasGlyphs);
  assert.ok(state.atlasCapacity >= state.atlasRequiredSlots);
  assert.ok(state.atlasGlyphs >= 1);
  if (["kb-stb", "kb-canvas"].includes(state.textRenderer)) {
    assert.ok(state.cacheHits > 0);
    assert.ok(state.cacheMisses >= 0);
    assert.ok(state.atlasGlyphs <= state.atlasRequiredSlots);
  }
  assert.ok(value.readbacks >= 5);
  assert.ok(value.elapsed < 3000, `GPU E2E took ${value.elapsed}ms`);
  await pageCdp.call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await pageCdp.call("Runtime.evaluate", {
    expression: "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    awaitPromise: true,
  });
  const mobileInputResponse = await pageCdp.call("Runtime.evaluate", {
    expression: `(() => {
      const input = document.querySelector("#input");
      const screen = document.querySelector("#screen");
      const viewport = document.querySelector("#terminal-viewport");
      const chrome = document.querySelector("#terminal-chrome");
      const textView = document.querySelector("#text-view");
      const selectionButton = document.querySelector("#selection-button");
      const spacer = document.querySelector("#spacer");
      const inputRect = input.getBoundingClientRect();
      const screenRect = screen.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      const textViewRect = textView.getBoundingClientRect();
      const center = document.elementFromPoint(
        screenRect.left + screenRect.width / 2,
        screenRect.top + screenRect.height / 2,
      );
      const inputStyle = getComputedStyle(input);
      const textViewStyle = getComputedStyle(textView);
      const rect = element => ({
        left: element.left,
        top: element.top,
        right: element.right,
        bottom: element.bottom,
        width: element.width,
        height: element.height,
      });
      return {
        coarse: matchMedia("(pointer: coarse)").matches,
        inputParentId: input.parentElement?.id || null,
        viewportParentId: viewport.parentElement?.id || null,
        chromeParentId: chrome.parentElement?.id || null,
        textViewParentId: textView.parentElement?.id || null,
        spacerParentId: spacer.parentElement?.id || null,
        position: inputStyle.position,
        pointerEvents: inputStyle.pointerEvents,
        selectionButtonDisplay: getComputedStyle(selectionButton).display,
        textViewPointerEvents: textViewStyle.pointerEvents,
        textViewChildCount: textView.childElementCount,
        inputRect: rect(inputRect),
        screenRect: rect(screenRect),
        viewportRect: rect(viewportRect),
        textViewRect: rect(textViewRect),
        centerTextViewId: center?.closest("#text-view")?.id || null,
        centerElementClass: center?.className || null,
      };
    })()`,
    returnByValue: true,
  });
  if (mobileInputResponse.exceptionDetails) {
    throw new Error(mobileInputResponse.exceptionDetails.exception?.description || "mobile input diagnostics failed");
  }
  const mobileInput = mobileInputResponse.result.value;
  assert.equal(mobileInput.coarse, true);
  assert.equal(mobileInput.inputParentId, "terminal-viewport");
  assert.equal(mobileInput.viewportParentId, "terminal");
  assert.equal(mobileInput.chromeParentId, "terminal");
  assert.equal(mobileInput.position, "absolute");
  assert.equal(mobileInput.pointerEvents, "none");
  assert.notEqual(mobileInput.selectionButtonDisplay, "none");
  assert.equal(mobileInput.textViewPointerEvents, "none");
  assert.equal(mobileInput.textViewChildCount, 0);
  assert.equal(mobileInput.textViewParentId, "spacer");
  assert.equal(mobileInput.spacerParentId, "scroll");
  for (const edge of ["left", "top", "right", "bottom", "width", "height"]) {
    assert.ok(Math.abs(mobileInput.inputRect[edge] - mobileInput.screenRect[edge]) <= 1, `${edge} does not match screen ${JSON.stringify(mobileInput)}`);
  }
  for (const edge of ["left", "top", "bottom"]) {
    assert.ok(Math.abs(mobileInput.inputRect[edge] - mobileInput.viewportRect[edge]) <= 1, `${edge} does not match viewport ${JSON.stringify(mobileInput)}`);
  }
  assert.equal(mobileInput.centerTextViewId, null);
  const exceptions = pageCdp.events.filter(event => event.method === "Runtime.exceptionThrown");
  assert.deepEqual(exceptions, [], JSON.stringify(exceptions));
  console.log(JSON.stringify({ ...value, presentedPixel, visualPsnr, gpuDevice: gpuDeviceText, mobileInput }));
} finally {
  pageCdp?.close();
  browserCdp?.close();
  await terminate(bundledServer);
  await terminate(chromium);
  await terminate(server);
  await rm(profile, { recursive: true, force: true });
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
  throw new Error(message());
}

async function terminate(process) {
  if (!process || process.exitCode !== null) return;
  process.kill("SIGTERM");
  await Promise.race([
    new Promise(resolve => process.once("exit", resolve)),
    new Promise(resolve => setTimeout(resolve, 1000)),
  ]);
  if (process.exitCode === null) process.kill("SIGKILL");
}

async function compareImagePsnr(actualBuffer, expectedBuffer) {
  const [actual, expected] = await Promise.all([
    sharp(actualBuffer).toColorspace("srgb").removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(expectedBuffer).toColorspace("srgb").removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  assert.equal(actual.info.width, expected.info.width);
  assert.equal(actual.info.height, expected.info.height);
  assert.equal(actual.info.channels, expected.info.channels);
  let error = 0;
  for (let index = 0; index < actual.data.length; index += actual.info.channels) {
    for (let channel = 0; channel < 3; channel += 1) {
      const difference = actual.data[index + channel] - expected.data[index + channel];
      error += difference * difference;
    }
  }
  const mse = error / (actual.info.width * actual.info.height * 3);
  return { width: actual.info.width, height: actual.info.height, psnr: mse === 0 ? 99 : 10 * Math.log10(255 ** 2 / mse) };
}
