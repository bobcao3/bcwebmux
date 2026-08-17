// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
assert.ok(serverPath && webRoot, "usage: mouse-selection-e2e.mjs SERVER WEB_ROOT");
const serverPort = await freePort();
const debugPort = await freePort();
const profile = await mkdtemp(path.join(os.tmpdir(), "bcwebmux-mouse-selection-"));
const server = spawn(serverPath, ["--web-root", webRoot, "--port", String(serverPort)], {
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", data => { serverLog += data; });
server.stderr.on("data", data => { serverLog += data; });
let chromium;
let pageCdp;
let browserCdp;

try {
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${serverPort}/`).catch(() => null);
    return response?.ok;
  }, 10000, () => `server failed to start\n${serverLog}`);

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
  pageCdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await pageCdp.call("Runtime.enable");
  await pageCdp.call("Page.enable");
  await waitFor(async () => {
    const result = await evaluate("document.readyState").catch(() => null);
    return result === "complete";
  }, 10000, () => "page failed to become ready");
  await waitFor(async () => evaluate("Boolean(window.bcwebmux?.connected)").catch(() => false), 10000, () => {
    const exceptions = pageCdp.events.filter(event => event.method === "Runtime.exceptionThrown");
    return `terminal did not connect\n${JSON.stringify(exceptions)}\n${chromiumLog}`;
  });

  const origin = `http://127.0.0.1:${serverPort}`;
  for (const name of ["clipboard-read", "clipboard-write"]) {
    await browserCdp.call("Browser.setPermission", {
      permission: { name },
      setting: "granted",
      origin,
    });
  }

  const geometry = await evaluate(`(() => {
    const scroll = document.querySelector("#scroll");
    const terminal = document.querySelector("#terminal");
    const screen = document.querySelector("#screen");
    const rect = scroll.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const style = getComputedStyle(terminal);
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
      screenRight: screenRect.right,
      cellWidth: parseFloat(style.getPropertyValue("--cell-width")),
      cellHeight: parseFloat(style.getPropertyValue("--cell-height")),
    };
  })()`);
  const point = (column, row, xFraction = 0.5, yFraction = 0.5) => ({
    x: geometry.left + (column + xFraction) * geometry.cellWidth,
    y: geometry.top + (row + yFraction) * geometry.cellHeight,
  });

  const dispatchMove = async (column, row, buttons = 0, modifiers = 0, xFraction = 0.5) => {
    const pos = point(column, row, xFraction);
    await pageCdp.call("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: pos.x,
      y: pos.y,
      button: buttons ? "left" : "none",
      buttons,
      modifiers,
    });
  };
  const dispatchPress = async (column, row, modifiers = 0, xFraction = 0.5) => {
    const pos = point(column, row, xFraction);
    await pageCdp.call("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: pos.x,
      y: pos.y,
      button: "left",
      buttons: 1,
      modifiers,
      clickCount: 1,
    });
  };
  const dispatchRelease = async (column, row, modifiers = 0, xFraction = 0.5) => {
    const pos = point(column, row, xFraction);
    await pageCdp.call("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: pos.x,
      y: pos.y,
      button: "left",
      buttons: 0,
      modifiers,
      clickCount: 1,
    });
  };

  const transcriptCommand = (mode, expected) => {
    const byteLength = Buffer.byteLength(expected.replaceAll("\\033", "\x1b"));
    return `stty -icanon -echo min 0 time 5; printf '\\033[?${mode}h\\033[?1006h\\033[2J\\033[H\\033[48;2;255;128;0m \\033[0m'; data=$(dd bs=1 count=${byteLength} 2>/dev/null); extra=$(dd bs=1 count=1 2>/dev/null); printf '\\033[?${mode}l\\033[?1006l'; if test "$data" = "$(printf '${expected}')" && test -z "$extra"; then printf '\\033[2J\\033[H\\033[48;2;0;255;0m \\033[0m'; else printf '\\033[2J\\033[H\\033[48;2;255;0;0m \\033[0m'; fi; stty sane\r`;
  };

  const runTranscript = async ({ mode, expected, input }) => {
    await dispatchMove(0, 1);
    await evaluate(`window.bcwebmux.write(${JSON.stringify(transcriptCommand(mode, expected))})`);
    await waitCellColor(0, 0, [255, 128, 0], "mouse transcript fixture did not become ready");
    await input();
    await waitCellColor(0, 0, [0, 255, 0], `mouse mode ${mode} transcript mismatch`);
  };

  await runTranscript({
    mode: 1002,
    expected: "\\033[<0;2;2M\\033[<32;3;2M\\033[<0;3;2m",
    input: async () => {
      await dispatchMove(1, 1);
      await dispatchPress(1, 1);
      await dispatchMove(2, 1, 1);
      await dispatchRelease(2, 1);
    },
  });

  await runTranscript({
    mode: 1003,
    expected: "\\033[<35;2;2M\\033[<0;2;2M\\033[<32;3;2M\\033[<0;3;2m",
    input: async () => {
      await dispatchMove(1, 1);
      await dispatchPress(1, 1);
      await dispatchMove(2, 1, 1);
      await dispatchRelease(2, 1);
    },
  });

  await runTranscript({
    mode: 1002,
    expected: "\\033[<0;2;2M\\033[<0;2;2m",
    input: async () => {
      await evaluate(`(() => {
        window.__bcwCapturedPointer = null;
        document.querySelector("#scroll").addEventListener("gotpointercapture", event => {
          window.__bcwCapturedPointer = event.pointerId;
        }, { once: true });
      })()`);
      await dispatchPress(1, 1);
      const pointerId = await waitFor(async () => evaluate("window.__bcwCapturedPointer"), 1000, () => "pointer capture was not established");
      await evaluate(`document.querySelector("#scroll").releasePointerCapture(${pointerId})`);
      await dispatchRelease(1, 1);
    },
  });

  const touch = point(1, 1);
  const dispatchTouch = async type => await evaluate(`(() => {
    document.querySelector("#scroll").dispatchEvent(new PointerEvent(${JSON.stringify(type)}, {
      bubbles: true,
      pointerId: 7,
      pointerType: "touch",
      isPrimary: true,
      clientX: ${touch.x},
      clientY: ${touch.y},
      button: ${type === "pointerdown" ? 0 : -1},
      buttons: ${type === "pointerdown" ? 1 : 0},
    }));
  })()`);
  const dispatchTouchClick = async () => await evaluate(`document.querySelector("#scroll").dispatchEvent(new MouseEvent("click", {
    bubbles: true,
    clientX: ${touch.x},
    clientY: ${touch.y},
  }))`);
  await runTranscript({
    mode: 1000,
    expected: "\\033[<0;2;2M\\033[<0;2;2m",
    input: async () => {
      await dispatchTouch("pointerdown");
      await dispatchTouch("pointerup");
      await dispatchTouchClick();
    },
  });

  const longPressScreen = "printf '\\033[?1000h\\033[2J\\033[H\\033[48;2;255;128;0m \\033[0m'\r";
  await evaluate(`window.bcwebmux.write(${JSON.stringify(longPressScreen)})`);
  await waitCellColor(0, 0, [255, 128, 0], "long-touch fixture did not render");
  await evaluate("document.querySelector('#input').blur()");
  assert.notEqual(await evaluate("document.activeElement === document.querySelector('#input')"), true, "keyboard input was active before long touch");
  const txBeforeLongTouch = await evaluate("window.bcwebmux.state.txBytes");
  await dispatchTouch("pointerdown");
  await new Promise(resolve => setTimeout(resolve, 450));
  await dispatchTouch("pointerup");
  await dispatchTouchClick();
  assert.equal(await evaluate("window.bcwebmux.state.txBytes"), txBeforeLongTouch, "long touch emitted PTY mouse reports");
  assert.notEqual(await evaluate("document.activeElement === document.querySelector('#input')"), true, "long touch refocused keyboard input");
  await evaluate(`window.bcwebmux.write(${JSON.stringify("printf '\\033[?1000l\\033[?1002l\\033[?1003l\\033[?1006l'\r")})`);

  const selectionScreen = "printf '\\033[?1000l\\033[?1002l\\033[?1003l\\033[?1006l\\033[2J\\033[H\\033[38;2;240;240;240m\\033[48;2;127;127;127mAé中Z \\033[0m\\033[10;1H'\r";
  await evaluate(`window.bcwebmux.write(${JSON.stringify(selectionScreen)})`);
  await waitCellColor(0, 0, [127, 127, 127], "selection fixture did not render");
  const txBeforeDomSelection = await evaluate("window.bcwebmux.state.txBytes");
  await evaluate(`(() => {
    const first = document.querySelector('#text-view .text-row[data-row="0"] [data-start="1"]');
    const second = document.querySelector('#text-view .text-row[data-row="0"] [data-start="2"]');
    const range = document.createRange();
    range.setStart(first.firstChild, 0);
    range.setEnd(second.firstChild, second.firstChild.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  })()`);
  await waitFor(async () => evaluate("window.bcwebmux.selectionText() === 'é中'"), 1500, () => "DOM selection text mismatch");
  assert.equal(await evaluate("window.bcwebmux.state.txBytes"), txBeforeDomSelection, "DOM selection emitted PTY bytes");
  await evaluate("window.getSelection().removeAllRanges()");
  await waitFor(async () => evaluate("window.bcwebmux.selectionText() === null"), 1500, () => "DOM selection was not cleared");
  const txBeforeSelection = await evaluate("window.bcwebmux.state.txBytes");
  await dispatchPress(1, 0, 0, 0.3);
  await dispatchMove(2, 0, 1, 0, 0.8);
  await dispatchRelease(2, 0, 0, 0.8);
  await waitFor(async () => evaluate("window.bcwebmux.selectionText() === 'é中'"), 1500, () => "direct selection text mismatch");
  assert.equal(await evaluate("window.bcwebmux.state.txBytes"), txBeforeSelection, "tracking-off selection emitted PTY bytes");
  await evaluate("navigator.clipboard.writeText('sentinel')");
  const txBeforeShortcut = await evaluate("window.bcwebmux.state.txBytes");
  await pageCdp.call("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "C",
    code: "KeyC",
    modifiers: 10,
    windowsVirtualKeyCode: 67,
  });
  await pageCdp.call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "C",
    code: "KeyC",
    modifiers: 10,
    windowsVirtualKeyCode: 67,
  });
  await waitFor(async () => evaluate("(async () => await navigator.clipboard.readText() === 'é中')()"), 1500, () => "keyboard shortcut did not copy selection");
  assert.equal(await evaluate("window.bcwebmux.state.txBytes"), txBeforeShortcut, "keyboard shortcut emitted PTY bytes");
  const selectedColors = await Promise.all([0, 1, 2, 3, 4].map(column => sampleCell(column, 0)));
  assertGray(selectedColors[0], "leading adjacent cell");
  assertDark(selectedColors[1], "selected narrow cell");
  assertDark(selectedColors[2], "selected wide lead");
  assertDark(selectedColors[3], "selected wide tail");
  assertGray(selectedColors[4], "trailing adjacent cell");

  await evaluate(`window.bcwebmux.write(${JSON.stringify(selectionScreen.replace("?1002l", "?1002h").replace("?1006l", "?1006h"))})`);
  await waitCellColor(0, 0, [127, 127, 127], "Shift selection fixture did not render");
  const txBeforeShiftSelection = await evaluate("window.bcwebmux.state.txBytes");
  await dispatchPress(1, 0, 8, 0.3);
  await dispatchMove(2, 0, 1, 0, 0.8);
  await dispatchRelease(2, 0, 0, 0.8);
  await waitFor(async () => evaluate("window.bcwebmux.selectionText() === 'é中'"), 1500, () => "Shift override selection text mismatch");
  assert.equal(await evaluate("window.bcwebmux.state.txBytes"), txBeforeShiftSelection, "Shift selection emitted PTY mouse reports");

  const tailScreen = "printf '\\033[?1002l\\033[?1006l\\033[2J\\033[H\\033[38;2;240;240;240m\\033[48;2;127;127;127mA中Z \\033[0m\\033[10;1H'\r";
  await evaluate(`window.bcwebmux.write(${JSON.stringify(tailScreen)})`);
  await waitCellColor(0, 0, [127, 127, 127], "wide-tail fixture did not render");
  await dispatchPress(2, 0, 0, 0.2);
  await dispatchMove(2, 0, 1, 0, 0.9);
  await dispatchRelease(2, 0, 0, 0.9);
  await waitFor(async () => evaluate("window.bcwebmux.selectionText() !== null"), 1500, () => "wide-tail selection was not created");
  const tailColors = await Promise.all([0, 1, 2, 3].map(column => sampleCell(column, 0)));
  assertGray(tailColors[0], "wide-tail leading adjacent cell");
  assertDark(tailColors[1], "wide-tail glyph lead");
  assertDark(tailColors[2], "wide-tail glyph tail");
  assertGray(tailColors[3], "wide-tail trailing adjacent cell");

  const invisibleScreen = "printf '\\033[2J\\033[H\\033[38;2;127;127;127m\\033[48;2;127;127;127mX\\033[38;2;255;255;255mX\\033[0m\\033[10;1H'\r";
  await evaluate(`window.bcwebmux.write(${JSON.stringify(invisibleScreen)})`);
  await waitCellColor(0, 0, [127, 127, 127], "invisible-text fixture did not render");
  await dispatchPress(0, 0, 0, 0.2);
  await dispatchMove(1, 0, 1, 0, 0.9);
  await dispatchRelease(1, 0, 0, 0.9);
  await waitFor(async () => {
    const colors = await Promise.all([sampleCell(0, 0), sampleCell(1, 0)]);
    return colors.every(color => color.every(channel => channel < 60));
  }, 1500, () => "adaptive selection background did not render");
  const brightPixels = await evaluate(`(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const image = await window.bcwebmux.readPixels();
    const canvas = document.querySelector("#screen");
    const terminal = document.querySelector("#terminal");
    const style = getComputedStyle(terminal);
    const sx = image.width / canvas.clientWidth;
    const sy = image.height / canvas.clientHeight;
    const cw = parseFloat(style.getPropertyValue("--cell-width")) * sx;
    const ch = parseFloat(style.getPropertyValue("--cell-height")) * sy;
    const count = column => {
      let total = 0;
      for (let y = 0; y < Math.floor(ch); y += 1) for (let x = Math.floor(column * cw); x < Math.floor((column + 1) * cw); x += 1) {
        const offset = (y * image.width + x) * 4;
        if (image.data[offset] > 180 && image.data[offset + 1] > 180 && image.data[offset + 2] > 180) total += 1;
      }
      return total;
    };
    return [count(0), count(1)];
  })()`);
  assert.equal(brightPixels[0], 0, "selection revealed intentionally invisible text");
  assert.ok(brightPixels[1] > 2, "selection did not preserve visible glyph contrast");

  const emptySelectionScreen = "printf '\\033[?1000l\\033[?1002l\\033[?1003l\\033[?1006l\\033[2J\\033[H\\033[1;6H\\033[48;2;255;128;0m \\033[0m\\033[10;1H'\r";
  await evaluate(`window.bcwebmux.write(${JSON.stringify(emptySelectionScreen)})`);
  await waitCellColor(5, 0, [255, 128, 0], "empty-selection fixture did not render");
  await dispatchPress(0, 0, 0, 0.3);
  await dispatchMove(1, 0, 1, 0, 0.8);
  await dispatchRelease(1, 0, 0, 0.8);
  await waitFor(async () => evaluate("window.bcwebmux.selectionText() === ''"), 1500, () => "empty selection was not created");

  const scrollbarScreen = "printf '\\033[?1003h\\033[2J\\033[H'; seq 1 100\r";
  await evaluate(`window.bcwebmux.write(${JSON.stringify(scrollbarScreen)})`);
  await waitFor(async () => evaluate(`(() => {
    const scroll = document.querySelector("#scroll");
    return scroll.scrollHeight > scroll.clientHeight &&
      scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 1;
  })()`), 3000, () => "scrollback did not reach the bottom");
  assert.ok(geometry.right > geometry.screenRight, "native scrollbar gutter was not reserved");
  const txBeforeScrollbar = await evaluate("window.bcwebmux.state.txBytes");
  const selectionBeforeScrollbar = await evaluate("window.bcwebmux.selectionText()");
  const scrollbarX = geometry.right - 2;
  const scrollbarY = geometry.top + geometry.height * 0.2;
  const scrollTopBeforeScrollbar = await evaluate("document.querySelector('#scroll').scrollTop");
  await pageCdp.call("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: scrollbarX,
    y: scrollbarY,
    button: "none",
    buttons: 0,
    modifiers: 0,
  });
  await pageCdp.call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: scrollbarX,
    y: scrollbarY,
    button: "left",
    buttons: 1,
    modifiers: 0,
    clickCount: 1,
  });
  await pageCdp.call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: scrollbarX,
    y: scrollbarY,
    button: "left",
    buttons: 0,
    modifiers: 0,
    clickCount: 1,
  });
  await waitFor(async () => evaluate(`document.querySelector("#scroll").scrollTop < ${scrollTopBeforeScrollbar}`), 1500, () => "native scrollbar track click did not scroll");
  assert.equal(await evaluate("window.bcwebmux.state.txBytes"), txBeforeScrollbar, "scrollbar click emitted mouse reports");
  assert.equal(await evaluate("window.bcwebmux.selectionText()"), selectionBeforeScrollbar, "scrollbar click changed local selection");
  const thumbMetrics = await evaluate(`(() => {
    const scroll = document.querySelector("#scroll");
    return {
      scrollTop: scroll.scrollTop,
      clientHeight: scroll.clientHeight,
      scrollHeight: scroll.scrollHeight,
      top: scroll.getBoundingClientRect().top,
    };
  })()`);
  const thumbHeight = Math.max(20, thumbMetrics.clientHeight ** 2 / thumbMetrics.scrollHeight);
  const thumbTop = thumbMetrics.top +
    thumbMetrics.scrollTop / (thumbMetrics.scrollHeight - thumbMetrics.clientHeight) *
    (thumbMetrics.clientHeight - thumbHeight);
  const thumbCenterY = thumbTop + thumbHeight / 2;
  const thumbDragY = Math.min(thumbMetrics.top + thumbMetrics.clientHeight - 1, thumbCenterY + 60);
  const txBeforeThumbDrag = await evaluate("window.bcwebmux.state.txBytes");
  const selectionBeforeThumbDrag = await evaluate("window.bcwebmux.selectionText()");
  await pageCdp.call("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: scrollbarX,
    y: thumbCenterY,
    button: "none",
    buttons: 0,
    modifiers: 0,
  });
  await pageCdp.call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: scrollbarX,
    y: thumbCenterY,
    button: "left",
    buttons: 1,
    modifiers: 0,
    clickCount: 1,
  });
  await pageCdp.call("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: scrollbarX,
    y: thumbDragY,
    button: "left",
    buttons: 1,
    modifiers: 0,
  });
  await pageCdp.call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: scrollbarX,
    y: thumbDragY,
    button: "left",
    buttons: 0,
    modifiers: 0,
    clickCount: 1,
  });
  await waitFor(async () => evaluate(`document.querySelector("#scroll").scrollTop !== ${thumbMetrics.scrollTop}`), 1500, () => "native scrollbar thumb drag did not scroll");
  assert.equal(await evaluate("window.bcwebmux.state.txBytes"), txBeforeThumbDrag, "scrollbar thumb drag emitted mouse reports");
  assert.equal(await evaluate("window.bcwebmux.selectionText()"), selectionBeforeThumbDrag, "scrollbar thumb drag changed local selection");
  await evaluate(`window.bcwebmux.write(${JSON.stringify("printf '\\033[?1003l'\r")})`);
  await pageCdp.call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const coarseHitTarget = await evaluate(`(() => {
    const element = document.elementFromPoint(${point(1, 1).x}, ${point(1, 1).y});
    const textView = document.querySelector("#text-view");
    return element === textView || textView.contains(element);
  })()`);
  assert.ok(coarseHitTarget, "coarse pointer hit target was not #text-view");
  assert.notEqual(await evaluate("getComputedStyle(document.querySelector('#text-view')).pointerEvents"), "none");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#input')).pointerEvents"), "none");

  const exceptions = pageCdp.events.filter(event => event.method === "Runtime.exceptionThrown");
  assert.deepEqual(exceptions, [], JSON.stringify(exceptions));
  console.log(JSON.stringify({ mouseSelection: "ok", selectedText: "é中", brightPixels }));

  async function evaluate(expression) {
    const response = await pageCdp.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || "browser evaluation failed");
    return response.result.value;
  }

  async function sampleCell(column, row) {
    return evaluate(`(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const image = await window.bcwebmux.readPixels();
      const canvas = document.querySelector("#screen");
      const terminal = document.querySelector("#terminal");
      const style = getComputedStyle(terminal);
      const sx = image.width / canvas.clientWidth;
      const sy = image.height / canvas.clientHeight;
      const cw = parseFloat(style.getPropertyValue("--cell-width")) * sx;
      const ch = parseFloat(style.getPropertyValue("--cell-height")) * sy;
      const x0 = Math.floor((${column} + 0.05) * cw);
      const x1 = Math.max(x0 + 1, Math.floor((${column} + 0.20) * cw));
      const y0 = Math.floor((${row} + 0.05) * ch);
      const y1 = Math.max(y0 + 1, Math.floor((${row} + 0.20) * ch));
      let r = 0, g = 0, b = 0, count = 0;
      for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
        const offset = (y * image.width + x) * 4;
        r += image.data[offset]; g += image.data[offset + 1]; b += image.data[offset + 2]; count += 1;
      }
      return [r / count, g / count, b / count];
    })()`);
  }

  async function waitCellColor(column, row, expected, message) {
    return waitFor(async () => {
      const color = await sampleCell(column, row);
      return color.every((channel, index) => Math.abs(channel - expected[index]) < 40) ? color : false;
    }, 3000, () => message);
  }
} finally {
  pageCdp?.close();
  browserCdp?.close();
  await terminate(chromium);
  await terminate(server);
  await rm(profile, { recursive: true, force: true });
}

function assertDark(color, label) {
  assert.ok(color.every(channel => channel < 60), `${label} was not selected: ${color}`);
}

function assertGray(color, label) {
  assert.ok(color.every(channel => channel > 75 && channel < 180), `${label} did not retain its background: ${color}`);
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
    await new Promise(resolve => setTimeout(resolve, 25));
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
