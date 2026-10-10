// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { Cdp, delay, freePort, terminateProcess, waitFor } from "./test-support.mjs";
import { recordProgressVideos } from "./progress-video.mjs";
import { verifyUnreadBell } from "./bell-ui-support.mjs";

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
        "--force-device-scale-factor=1.5",
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
      source: `localStorage.setItem('bcwebmux.settings.v1', JSON.stringify({selected:'custom',custom:{background:'#240000'},renderer:'canvas',grainStrength:0,perfMode:'off'}));`,
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
    await verifyBellFlash(evaluate);
    await report(
      "\\033]7501;state=working:progress=65\\007",
      "document.querySelector('#terminal-progress').getAttribute('aria-valuenow') === '65'",
    );
    for (const { width, dpr } of [
      { width: 1024, dpr: 1 },
      { width: 1024, dpr: 1.25 },
      { width: 1024, dpr: 2 },
      { width: 390, dpr: 1 },
      { width: 390, dpr: 1.5 },
      { width: 390, dpr: 2 },
    ]) {
      await page.call("Emulation.setDeviceMetricsOverride", {
        width,
        height: 720,
        deviceScaleFactor: dpr,
        mobile: false,
      });
      await until(
        `Math.abs(devicePixelRatio - ${dpr}) < 0.000001 && window.bcwebmux.state.gpuError === null`,
        "resize failed",
      );
      if (width < 721) await evaluate("window.bcwebmux.closeDrawer()");
      await delay(150);
      const sample = await evaluate("progressProbe.sample()");
      assertGeometry(sample);
      assert.equal(sample.colors.length, 2, "filled and unfilled progress must each be solid");
      assert.equal(sample.blockErrors, 0);
      assert.ok(
        Math.abs(sample.activeFraction - 0.65) <= 1 / sample.barWidth,
        JSON.stringify(sample),
      );
      await page.call("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
      });
      await delay(100);
      assert.equal((await evaluate("progressProbe.sample()")).blockErrors, 0);
      await page.call("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "reduce" }],
      });
      await delay(50);
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
      `indeterminate work must bounce across the canvas: ${JSON.stringify([left.centroid, middle.centroid, right.centroid])}`,
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
    await verifyBellFlash(evaluate);
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
    const completed = await evaluate("progressProbe.sample()");
    assert.equal(completed.activeFraction, 1);
    assert.equal(completed.colors.length, 1, "completed progress must be solid with no dither");
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
    await recordProgressVideos({ page, evaluate, report, backend });
    if (backend === "webgpu") await verifyUnreadBell(page, evaluate);
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
      width: canvas.width, height: canvas.height, dpr: Math.round(devicePixelRatio * 1000000) / 1000000
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
  const screenshotX = Math.floor(
    (layout.canvas.left + ((x + 0.5) * layout.canvas.width) / layout.width) * layout.dpr,
  );
  const screenshotY = Math.ceil(layout.canvas.bottom * layout.dpr) - 1;
  const sourceX =
    (screenshotX + 0.5 - layout.canvas.left * layout.dpr) *
      (layout.width / (layout.canvas.width * layout.dpr)) -
    0.5;
  const sourceY =
    (screenshotY + 0.5 - (layout.canvas.bottom - layout.canvas.height) * layout.dpr) *
      (layout.height / (layout.canvas.height * layout.dpr)) -
    0.5;
  const readExpected = () =>
    evaluate(`(async () => {
    const frame = await window.bcwebmux.readPixels();
    const sourceX = ${sourceX};
    const sourceY = ${sourceY};
    const x0 = Math.floor(sourceX), y0 = Math.floor(sourceY);
    const tx = sourceX - x0, ty = sourceY - y0;
    const pixel = (x, y) => {
      x = Math.max(0, Math.min(frame.width - 1, x));
      y = Math.max(0, Math.min(frame.height - 1, y));
      const i = (y * frame.width + x) * 4;
      const rgb = Array.from(frame.data.slice(i, i + 3));
      if (frame.format.startsWith('bgra')) rgb.reverse();
      return rgb;
    };
    const samples = [pixel(x0, y0), pixel(x0 + 1, y0), pixel(x0, y0 + 1), pixel(x0 + 1, y0 + 1)];
    return [0, 1, 2].map(channel =>
      samples[0][channel] * (1 - tx) * (1 - ty) +
      samples[1][channel] * tx * (1 - ty) +
      samples[2][channel] * (1 - tx) * ty +
      samples[3][channel] * tx * ty
    );
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
  const i = (screenshotY * info.width + screenshotX) * info.channels;
  const actual = Array.from(data.subarray(i, i + 3));
  assert.ok(
    actual.every((channel, index) => Math.abs(channel - expected[index]) <= 10),
    `compositor must display the final progress pixel at the chrome boundary: ${actual} versus ${expected}`,
  );
}

async function verifyBellFlash(evaluate) {
  const result = await evaluate(`(async () => {
    const read = async () => {
      const frame = await window.bcwebmux.readPixels();
      if (frame.format.startsWith('bgra')) {
        for (let i = 0; i < frame.data.length; i += 4)
          [frame.data[i], frame.data[i + 2]] = [frame.data[i + 2], frame.data[i]];
      }
      return frame;
    };
    const before = await read();
    const warning = (() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d');
      context.fillStyle = getComputedStyle(document.querySelector('#terminal')).getPropertyValue('--color-warning');
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
    })();
    window.bcwebmux.write("printf '\\\\007'\\n");
    const deadline = performance.now() + 2500;
    let flash = null;
    while (performance.now() < deadline) {
      await new Promise(requestAnimationFrame);
      const frame = await read();
      const bottom = (frame.height - 1) * frame.width * 4;
      if (![0, 1, 2].every(channel => Math.abs(frame.data[bottom + channel] - warning[channel]) <= 1))
        continue;
      flash = frame;
      break;
    }
    if (!flash) return { sawWarning: false };
    const start = performance.now();
    const bottom = (flash.height - 1) * flash.width * 4;
    const channel = [0, 1, 2].reduce((best, current) =>
      Math.abs(warning[current] - before.data[bottom + current]) >
      Math.abs(warning[best] - before.data[bottom + best]) ? current : best, 0);
    const difference = warning[channel] - before.data[bottom + channel];
    const samples = [];
    while (performance.now() - start < 220) {
      await new Promise(requestAnimationFrame);
      const frame = await read();
      samples.push({
        elapsed: performance.now() - start,
        opacity: (frame.data[bottom + channel] - before.data[bottom + channel]) / difference,
      });
    }
    const after = await read();
    let fullRowWarning = true;
    for (let i = (flash.height - 1) * flash.width * 4; i < flash.data.length; i += 4)
      fullRowWarning &&= [0, 1, 2].every(channel => Math.abs(flash.data[i + channel] - warning[channel]) <= 1);
    const aboveBar = Math.floor(flash.height / 2) * flash.width * 4;
    const unchangedAbove = flash.data.slice(0, aboveBar).every((value, i) => value === before.data[i]);
    return {
      sawWarning: true, fullRowWarning, unchangedAbove, samples,
      restored: after.data.every((value, i) => value === before.data[i]),
    };
  })()`);
  assert.equal(result.sawWarning, true, "BEL must show the warning flash");
  assert.equal(result.fullRowWarning, true, "warning flash must cover the full bottom row");
  assert.equal(result.unchangedAbove, true, "warning flash must not brighten the terminal pane");
  const hold = result.samples.filter((sample) => sample.elapsed < 40);
  assert.ok(
    hold.length > 0 && hold.every((sample) => sample.opacity >= 0.98),
    "warning flash hold must retain full opacity",
  );
  assert.ok(
    result.samples.some(
      (sample) =>
        sample.elapsed >= 95 &&
        sample.elapsed <= 120 &&
        sample.opacity > 0.1 &&
        sample.opacity < 0.5,
    ),
    `warning flash inverse-square-root fade must reach mid-opacity: ${JSON.stringify(result.samples)}`,
  );
  assert.ok(
    result.samples.some(
      (sample) =>
        sample.elapsed >= 130 &&
        sample.elapsed <= 165 &&
        sample.opacity > 0 &&
        sample.opacity < 0.2,
    ),
    `warning flash inverse-square-root fade must approach zero: ${JSON.stringify(result.samples)}`,
  );
  assert.ok(
    result.samples
      .slice(1)
      .every((sample, index) => sample.opacity <= result.samples[index].opacity + 0.01),
    "warning flash fade must be nonincreasing",
  );
  assert.equal(
    result.restored,
    true,
    "warning flash restoration must restore the previous GPU output",
  );
}

function assertGeometry(sample) {
  assert.equal(sample.minX, 0, "the progress bar must touch the left canvas edge");
  assert.equal(sample.maxX, sample.width - 1, "the progress bar must touch the right canvas edge");
  const actualBarHeight = sample.maxY - sample.minY + 1;
  assert.equal(actualBarHeight % (2 * sample.blockHeight), 0);
  assert.ok(actualBarHeight >= 2 * sample.blockHeight);
  assert.ok(Math.abs(actualBarHeight - sample.lineHeight * 0.2) <= sample.blockHeight);
  assert.equal(sample.changedPixels, sample.width * actualBarHeight);
  assert.equal(
    sample.maxY,
    sample.height - 1,
    "the progress bar must touch the canvas bottom edge",
  );
  for (const [red, green, blue] of sample.colors) {
    assert.ok([0, 51, 102, 153, 204, 255].includes(red), `unexpected red level: ${red}`);
    assert.ok([0, 51, 102, 153, 204, 255].includes(green), `unexpected green level: ${green}`);
    assert.ok([0, 51, 102, 153, 204, 255].includes(blue), `unexpected blue level: ${blue}`);
  }
}

function installProbe() {
  const background = [36, 0, 0];
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
      const canvas = document.querySelector("#screen");
      const blockWidth = Math.max(1, Math.round((2 * width) / canvas.clientWidth));
      const blockHeight = Math.max(1, Math.round((2 * height) / canvas.clientHeight));
      const { physicalCellHeight: lineHeight } = window.bcwebmux.state;
      const colors = new Set();
      let minX = width,
        maxX = -1,
        minY = height,
        maxY = -1;
      let changedPixels = 0,
        active = 0,
        sumX = 0,
        hash = 2166136261;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (
            data[i] === background[0] &&
            data[i + 1] === background[1] &&
            data[i + 2] === background[2]
          )
            continue;
          const rgb = [data[i], data[i + 1], data[i + 2]];
          colors.add(rgb.join(","));
          changedPixels++;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
          for (const v of rgb) hash = Math.imul(hash ^ v, 16777619) >>> 0;
          if (rgb[2] > 0) {
            active++;
            sumX += x + 0.5;
          }
        }
      const barWidth = width;
      let blockErrors = 0;
      for (let y = minY; y < height; y++)
        for (let x = 0; x < width * 0.6; x++) {
          const i = (y * width + x) * 4;
          const blockX = x - (x % blockWidth);
          const blockY = y - ((y - minY) % blockHeight);
          const reference = (blockY * width + blockX) * 4;
          if (
            data[i] !== data[reference] ||
            data[i + 1] !== data[reference + 1] ||
            data[i + 2] !== data[reference + 2]
          )
            blockErrors++;
        }
      return {
        width,
        height,
        lineHeight,
        blockWidth,
        blockHeight,
        minX,
        maxX,
        minY,
        maxY,
        changedPixels,
        barWidth,
        blockErrors,
        colors: [...colors].map((rgb) => rgb.split(",").map(Number)),
        activeFraction: active / changedPixels,
        centroid: sumX / active / barWidth,
        hash,
      };
    },
  };
}
