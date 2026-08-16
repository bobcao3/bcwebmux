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
const cursorMoveCommand = "stty raw -echo; printf '\\033[2J\\033[H\\033[2 q\\033[48;2;255;0;0m \\033[0m\\033[4G'; dd bs=1 count=3 2>/dev/null; printf '\\033[D'; sleep 1.5; stty sane\r";
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
  ]);
  const [bundledIndex, bundledClient, bundledFzstd, bundledWasm, bundledLicense] = bundledResponses;
  for (const response of bundledResponses) assert.ok(response.ok, `bundled request failed: ${response.status}`);
  assert.match(bundledIndex.headers.get("content-type") || "", /^text\/html(?:;|$)/);
  assert.match(bundledClient.headers.get("content-type") || "", /^(?:text\/javascript|application\/javascript)(?:;|$)/);
  assert.match(bundledFzstd.headers.get("content-type") || "", /^(?:text\/javascript|application\/javascript)(?:;|$)/);
  assert.match(bundledWasm.headers.get("content-type") || "", /^application\/wasm(?:;|$)/);
  assert.match(bundledLicense.headers.get("content-type") || "", /^text\/plain(?:;|$)/);
  assert.match(await bundledIndex.text(), /bcwebmux/);
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
    `http://127.0.0.1:${serverPort}/?gpu-test=1`,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let chromiumLog = "";
  chromium.stderr.on("data", data => { chromiumLog += data; });

  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`).catch(() => null);
    if (!response?.ok) return null;
    const targets = await response.json();
    return targets.find(item => item.type === "page" && item.url.startsWith(`http://127.0.0.1:${serverPort}/?gpu-test=1`));
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
    const input = document.querySelector("#input");
    if (terminal.tabIndex !== -1) throw new Error("terminal is focusable via tabIndex");
    const inputRect = input.getBoundingClientRect();
    if (!(inputRect.width > 0 && inputRect.height > 0)) throw new Error("hidden textarea has no rendered size");
    input.blur();
    const scroll = document.querySelector("#scroll");
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

    const softkeys = document.querySelector("#softkeys");
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

    const state = window.bcwebmux.state;
    return {
      keyboardPixels,
      imePixels,
      softPixels,
      mousePixels,
      specialKeysPixels,
      cursorMovePixels,
      historyPixels,
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
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || "browser evaluation failed");
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
      y: Math.max(0, viewportHeight - 60),
      width: viewportWidth,
      height: Math.min(60, viewportHeight),
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
  assert.equal(state.atlasRequiredSlots, Math.ceil(state.rows * state.cols * 1.25));
  assert.ok(state.atlasCapacity >= state.atlasRequiredSlots);
  assert.ok(state.atlasGlyphs >= 1);
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
      const inputRect = input.getBoundingClientRect();
      const screenRect = screen.getBoundingClientRect();
      const center = document.elementFromPoint(
        screenRect.left + screenRect.width / 2,
        screenRect.top + screenRect.height / 2,
      );
      const inputStyle = getComputedStyle(input);
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
        position: inputStyle.position,
        pointerEvents: inputStyle.pointerEvents,
        inputRect: rect(inputRect),
        screenRect: rect(screenRect),
        centerElementId: center?.id || null,
      };
    })()`,
    returnByValue: true,
  });
  if (mobileInputResponse.exceptionDetails) {
    throw new Error(mobileInputResponse.exceptionDetails.exception?.description || "mobile input diagnostics failed");
  }
  const mobileInput = mobileInputResponse.result.value;
  assert.equal(mobileInput.coarse, true);
  assert.equal(mobileInput.inputParentId, "scroll");
  assert.equal(mobileInput.position, "fixed");
  assert.notEqual(mobileInput.pointerEvents, "none");
  for (const edge of ["left", "top", "right", "bottom", "width", "height"]) {
    assert.ok(Math.abs(mobileInput.inputRect[edge] - mobileInput.screenRect[edge]) <= 1, `${edge} does not match ${JSON.stringify(mobileInput)}`);
  }
  assert.equal(mobileInput.centerElementId, "input");
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
