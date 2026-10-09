// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { Cdp, delay, freePort, terminateProcess, waitFor } from "./test-support.mjs";

const [serverPath, webRoot] = process.argv.slice(2);
assert.ok(serverPath && webRoot, "usage: progress-renderer-e2e.mjs SERVER WEB_ROOT");
const backends = process.env.RENDER_BACKEND ? [process.env.RENDER_BACKEND] : ["webgpu", "webgl2"];
for (const backend of backends) await run(backend);

async function run(backend) {
  const profile = await mkdtemp(path.join(os.tmpdir(), "bcwebmux-progress-"));
  const port = await freePort();
  const debugPort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let server;
  let chromium;
  let page;
  let log = "";
  const evaluate = async (expression) => {
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
  };
  const until = (expression, message) =>
    waitFor(
      async () => {
        const error = await evaluate("window.bcwebmux?.state.gpuError");
        if (error) throw new Error(error);
        return Boolean(await evaluate(expression));
      },
      12000,
      message,
    );
  try {
    const shell = path.join(profile, "shell");
    await writeFile(
      shell,
      "#!/bin/sh\nstty -echo\nexport ENV=/dev/null BASH_ENV=/dev/null PS1=''\nprintf '\\033[?25l\\033]0;Progress shaders\\007'\nexec /bin/sh -i\n",
      { mode: 0o700 },
    );
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
        `127.0.0.1:${port}`,
        "--origin",
        base,
      ],
      { stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    server.detachedGroup = true;
    server.stdout.on("data", (chunk) => {
      log += chunk;
    });
    server.stderr.on("data", (chunk) => {
      log += chunk;
    });
    await waitFor(
      async () => (await fetch(`${base}/api/server`).catch(() => null))?.ok,
      10000,
      () => `server did not start: ${log}`,
    );
    chromium = spawn(
      process.env.CHROMIUM || "chromium",
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--window-size=1024,720",
        "--enable-unsafe-webgpu",
        "--use-angle=vulkan",
        "--ignore-gpu-blocklist",
        "--enable-features=Vulkan",
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
    await page.call("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await page.call("Page.addScriptToEvaluateOnNewDocument", {
      source: `localStorage.setItem('bcwebmux.settings.v1', JSON.stringify({selected:'custom',custom:{background:'#242424'},renderer:'canvas',grainStrength:0,perfMode:'off'}));`,
    });
    await page.call("Page.navigate", {
      url: `${base}/?session-test=1&renderer=canvas&backend=${backend}`,
    });
    await until(
      "window.bcwebmux?.connected && document.title === 'Progress shaders'",
      "terminal did not connect",
    );
    assert.equal(await evaluate("window.bcwebmux.state.backend"), backend);
    await evaluate("document.querySelector('#notification-dialog-later').click()");
    await evaluate(`window.progressProbe = (${installProbe.toString()})()`);
    const report = async (sequence, predicate) => {
      const before = await evaluate("window.bcwebmux.state.gpuFrames");
      await evaluate(`window.bcwebmux.write(${JSON.stringify(`printf '${sequence}'\n`)})`);
      await until(predicate, "progress metadata did not update");
      await until(
        `window.bcwebmux.state.gpuFrames > ${before}`,
        "progress did not reach a GPU presentation",
      );
      await evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
    };
    await until("window.bcwebmux.state.gpuFrames > 0", "initial canvas did not render");
    await report(
      "\\033]7501;state=working:progress=65\\007",
      "document.querySelector('#terminal-progress').getAttribute('aria-valuenow') === '65'",
    );
    for (const { width, dpr } of [
      { width: 1024, dpr: 1 },
      { width: 1024, dpr: 2 },
      { width: 390, dpr: 1 },
      { width: 390, dpr: 2 },
    ]) {
      await page.call("Emulation.setDeviceMetricsOverride", {
        width,
        height: 720,
        deviceScaleFactor: dpr,
        mobile: false,
      });
      await until(
        `devicePixelRatio === ${dpr} && window.bcwebmux.state.gpuError === null`,
        "resize failed",
      );
      if (width < 721) await evaluate("window.bcwebmux.closeDrawer()");
      await delay(150);
      const sample = await evaluate("progressProbe.sample()");
      assertGeometry(sample);
      assert.ok(
        Math.abs(sample.activeFraction - 0.65) <= 1 / sample.barWidth,
        JSON.stringify(sample),
      );
      await assertDisplayedGeometry(page, evaluate);
      await evaluate("document.querySelector('#softkeys-toggle').click()");
      await evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      await assertDisplayedGeometry(page, evaluate);
      await evaluate("document.querySelector('#softkeys-toggle').click()");
      if (width === 1024 && dpr === 1) {
        const original = await evaluate("document.querySelector('#screen').style.cssText");
        await evaluate("document.querySelector('#screen').style.height = 'calc(100% - 1px)'");
        await assert.rejects(
          () => assertDisplayedGeometry(page, evaluate),
          /canvas must reach the viewport bottom/,
        );
        await evaluate(
          `document.querySelector('#screen').style.cssText = ${JSON.stringify(original)}`,
        );
        await evaluate(`(() => {
          const cover = document.createElement('div');
          cover.id = 'progress-test-cover';
          cover.style.cssText = 'position:absolute;left:0;right:0;bottom:0;height:1px;background:#ff0000;z-index:100';
          document.querySelector('#terminal-viewport').append(cover);
        })()`);
        await assert.rejects(
          () => assertDisplayedGeometry(page, evaluate),
          /compositor must display the final progress pixel/,
        );
        await evaluate("document.querySelector('#progress-test-cover').remove()");
      }
    }
    await page.call("Emulation.setDeviceMetricsOverride", {
      width: 1024,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await delay(150);
    const still = await evaluate("progressProbe.sample()");
    await delay(150);
    assert.equal(
      (await evaluate("progressProbe.sample()")).hash,
      still.hash,
      "reduced motion must keep the overlay static",
    );
    await page.call("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
    });
    await delay(100);
    const wave = await evaluate("progressProbe.sample()");
    await delay(250);
    const shiftedWave = await evaluate("progressProbe.sample()");
    assert.notEqual(
      wave.hash,
      shiftedWave.hash,
      "working progress must animate without more terminal output",
    );
    await report(
      "\\033]7501;state=working\\007",
      "!document.querySelector('#terminal-progress').hasAttribute('aria-valuenow')",
    );
    const left = await evaluate("progressProbe.sample()");
    await delay(1200);
    const middle = await evaluate("progressProbe.sample()");
    await delay(1200);
    const right = await evaluate("progressProbe.sample()");
    for (const sample of [left, middle, right])
      assert.ok(Math.abs(sample.activeFraction - 1 / 3) < 0.01);
    assert.ok(
      left.centroid < 0.22 &&
        middle.centroid > 0.45 &&
        middle.centroid < 0.65 &&
        right.centroid > 0.78,
      "indeterminate work must bounce across the canvas",
    );
    await page.call("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await delay(100);
    const reduced = await evaluate("progressProbe.sample()");
    assert.ok(
      Math.abs(reduced.centroid - 0.5) < 0.01,
      "reduced-motion indeterminate work must stay centered",
    );

    await report(
      "\\033]7501;state=clear\\007\\033]9;4;4;40\\007",
      "document.querySelector('#terminal-progress').getAttribute('aria-valuenow') === '40'",
    );
    const paused = await evaluate("progressProbe.sample()");
    await page.call("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
    });
    await delay(150);
    assert.equal(
      (await evaluate("progressProbe.sample()")).hash,
      paused.hash,
      "paused progress must not wave",
    );
    if (backend === "webgl2") {
      await evaluate(`(async () => {
        const canvas = document.querySelector('#screen');
        const extension = canvas.getContext('webgl2').getExtension('WEBGL_lose_context');
        const lost = new Promise(resolve => canvas.addEventListener('webglcontextlost', resolve, { once: true }));
        const restored = new Promise(resolve => canvas.addEventListener('webglcontextrestored', resolve, { once: true }));
        extension.loseContext();
        await lost;
        await new Promise(resolve => setTimeout(resolve, 100));
        extension.restoreContext();
        await restored;
      })()`);
      await waitFor(
        async () =>
          await evaluate(
            "window.bcwebmux.state.gpuError === null && window.bcwebmux.state.gpuFrames > 0",
          ),
        12000,
        "WebGL progress did not recover after context restoration",
      );
      assert.equal(
        (await evaluate("progressProbe.sample()")).hash,
        paused.hash,
        "context recovery must preserve the progress state and rebuild the shader resources",
      );
    }
    await report(
      "\\033]9;4;0\\007\\033]7501;state=done\\007",
      "document.querySelector('#terminal-progress').getAttribute('aria-valuenow') === '100'",
    );
    assert.equal((await evaluate("progressProbe.sample()")).activeFraction, 1);
    await until(
      "document.querySelector('#terminal-progress').hidden",
      "complete progress did not auto-hide",
    );
    await delay(100);
    assert.equal(
      (await evaluate("progressProbe.sample()")).changedPixels,
      0,
      "auto-hide must remove the GPU overlay",
    );
    await report(
      "\\033]7501;state=working:progress=20\\007",
      "document.querySelector('#terminal-progress').getAttribute('aria-valuenow') === '20'",
    );
    await report(
      "\\033]7501;state=clear\\007",
      "document.querySelector('#terminal-progress').hidden",
    );
    assert.equal(
      (await evaluate("progressProbe.sample()")).changedPixels,
      0,
      "clearing progress must restore every canvas pixel",
    );
    assert.equal(await evaluate("document.querySelector('#client-error').hidden"), true);
    console.log(`${backend}: progress geometry, wave, bounce, pause, resize, and auto-hide passed`);
  } finally {
    page?.close();
    await terminateProcess(chromium);
    await terminateProcess(server);
    await rm(profile, { recursive: true, force: true });
  }
}

async function assertDisplayedGeometry(page, evaluate) {
  await evaluate(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  const layout = await evaluate(`(() => {
    const canvas = document.querySelector('#screen');
    const rect = canvas.getBoundingClientRect();
    const softkeys = document.querySelector('#terminal').classList.contains('softkeys-visible');
    return {
      canvas: { left: rect.left, bottom: rect.bottom, width: rect.width, height: rect.height },
      viewportBottom: document.querySelector('#terminal-viewport').getBoundingClientRect().bottom,
      chromeTop: document.querySelector('#terminal-chrome').getBoundingClientRect().top,
      adjacentTop: document.querySelector(softkeys ? '#softkeys' : '#terminal-controls').getBoundingClientRect().top,
      width: canvas.width, height: canvas.height, dpr: devicePixelRatio
    };
  })()`);
  assert.equal(
    layout.canvas.bottom,
    layout.viewportBottom,
    "canvas must reach the viewport bottom",
  );
  assert.equal(layout.canvas.bottom, layout.chromeTop, "canvas must touch the bottom chrome");
  assert.equal(
    layout.canvas.bottom,
    layout.adjacentTop,
    "canvas must touch the adjacent controls row",
  );
  const x = Math.floor(layout.width * 0.25);
  const readExpected = () =>
    evaluate(`(async () => {
    const frame = await window.bcwebmux.readPixels();
    const i = ((frame.height - 1) * frame.width + ${x}) * 4;
    const rgb = Array.from(frame.data.slice(i, i + 3));
    if (frame.format.startsWith('bgra')) rgb.reverse();
    return rgb;
  })()`);
  let expected;
  await waitFor(
    async () => {
      expected = await readExpected();
      return expected[0] > 48;
    },
    12000,
    "resized progress did not reach the GPU output",
  );
  const capture = await page.call("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const { data, info } = await sharp(Buffer.from(capture.data, "base64"))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const screenshotX = Math.floor(
    (layout.canvas.left + ((x + 0.5) * layout.canvas.width) / layout.width) * layout.dpr,
  );
  const screenshotY = Math.ceil(layout.canvas.bottom * layout.dpr) - 1;
  const i = (screenshotY * info.width + screenshotX) * info.channels;
  const actual = Array.from(data.subarray(i, i + 3));
  assert.ok(
    actual.every((channel, index) => Math.abs(channel - expected[index]) <= 10),
    `compositor must display the final progress pixel at the chrome boundary: ${actual} versus ${expected}`,
  );
}

function assertGeometry(sample) {
  assert.equal(sample.minX, sample.cellWidth);
  assert.equal(sample.maxX, sample.width - sample.cellWidth - 1);
  assert.ok(Math.abs(sample.maxY - sample.minY + 1 - sample.lineHeight * 0.2) <= 1);
  assert.equal(
    sample.maxY,
    sample.height - 1,
    "the progress bar must touch the canvas bottom edge",
  );
  assert.equal(
    sample.outsideChanges,
    0,
    "postprocessing must preserve pixels outside the inset bar",
  );
}

function installProbe() {
  const background = [36, 36, 36];
  const read = async () => {
    const frame = await window.bcwebmux.readPixels();
    if (frame.format.startsWith("bgra")) {
      for (let i = 0; i < frame.data.length; i += 4)
        [frame.data[i], frame.data[i + 2]] = [frame.data[i + 2], frame.data[i]];
    }
    return frame;
  };
  return {
    async sample() {
      const { width, height, data } = await read();
      const { physicalCellWidth: cellWidth, physicalCellHeight: lineHeight } =
        window.bcwebmux.state;
      let minX = width,
        maxX = -1,
        minY = height,
        maxY = -1;
      let changedPixels = 0,
        outsideChanges = 0,
        active = 0,
        sumX = 0,
        hash = 2166136261;
      const h = lineHeight * 0.2;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const rgb = Array.from(data.slice(i, i + 3));
          if (rgb.every((v, channel) => v === background[channel])) continue;
          changedPixels++;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
          if (x < cellWidth || x >= width - cellWidth || y + 0.5 < height - h || y + 0.5 >= height)
            outsideChanges++;
          for (const v of rgb) hash = Math.imul(hash ^ v, 16777619) >>> 0;
          if (rgb[0] > 38) {
            active++;
            sumX += x + 0.5 - cellWidth;
          }
        }
      const barWidth = width - 2 * cellWidth;
      return {
        width,
        height,
        cellWidth,
        lineHeight,
        minX,
        maxX,
        minY,
        maxY,
        changedPixels,
        outsideChanges,
        barWidth,
        activeFraction: active / changedPixels,
        centroid: sumX / active / barWidth,
        hash,
      };
    },
  };
}
