// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Cdp, freePort, localTls, terminateProcess, waitFor } from "./test-support.mjs";
import { compareScreenshot } from "./visual-compare.mjs";

const [serverPath, webRoot] = process.argv.slice(2);
assert.ok(serverPath && webRoot, "usage: visual-e2e.mjs SERVER WEB_ROOT");
const testDir = path.dirname(fileURLToPath(import.meta.url));
const goldenDir = path.join(testDir, "golden");
const outputDir = path.resolve(
  process.env.BCWEBMUX_SCREENSHOT_DIR || path.join(testDir, "..", "zig-out", "screenshots"),
);
const source = (await readFile(path.join(testDir, "snapshot-fixture.zig"), "utf8"))
  .trimEnd()
  .split("\n");
const devices = [
  { name: "desktop", width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  { name: "mobile", width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
];
const backends = process.env.RENDER_BACKEND ? [process.env.RENDER_BACKEND] : ["webgpu", "webgl2"];
assert.ok(backends.every((backend) => ["webgpu", "webgl2"].includes(backend)));
await mkdir(outputDir, { recursive: true });
await writeFile(
  path.join(outputDir, "index.html"),
  `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>bcwebmux visual tests</title>
<style>body{background:#10141a;color:#eee;font:16px system-ui;margin:24px}a{color:#7dd3fc}section{display:flex;flex-wrap:wrap;gap:20px}figure{margin:0;width:min(100%,720px)}img{max-width:100%;height:auto;border:1px solid #555}figure.mobile{width:290px}figcaption{margin:8px 0}</style>
<h1>Full-viewport terminal screenshots</h1>
<p>Click an image for native resolution. Desktop: 1440×900 @1×. Mobile: 390×844 @3× (1170×2532 pixels).
Unicode probes verify browser font fallback for CJK, combining text and emoji.</p>
${backends
  .map(
    (backend) =>
      `<h2>${backend}</h2><section>${devices
        .flatMap((device) =>
          [
            "unicode-source",
            "scroll-bottom",
            "scroll-top",
            "scroll-middle",
            "scroll-return",
            "kitty-graphics",
          ].map((label) => {
            const name = `${device.name}-${backend}-${label}`;
            return `<figure class="${device.name}"><figcaption>${device.name} · ${label} · <a href="${name}.json">state</a></figcaption><a href="${name}.png"><img loading="lazy" src="${name}.png" alt="${name}"></a></figure>`;
          }),
        )
        .join("")}</section>`,
  )
  .join("")}`,
);
const failures = [];
for (const backend of backends) for (const device of devices) await run(backend, device);
assert.deepEqual(failures, [], `Visual failures:\n${failures.join("\n")}`);
console.log(`Full-viewport screenshots: ${outputDir}`);

function numberedSource(lines, start = 0) {
  return lines
    .map(
      (line, i) =>
        `\x1b[90m${String(start + i + 1).padStart(3)} │ \x1b[${line.trim().startsWith("//") ? "32" : "37"}m${line}\x1b[0m`,
    )
    .join("\n");
}

async function run(backend, device) {
  const prefix = `${device.name}-${backend}`;
  const profile = await mkdtemp(path.join(os.tmpdir(), "bcwebmux-visual-"));
  const port = await freePort();
  const debugPort = await freePort();
  let server, chromium, page, browser;
  const tls = await localTls();
  let log = "";
  let processError;
  let sequence = 0;
  const results = {};
  const evaluate = async (expression) => {
    const response = await page.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails)
      throw new Error(
        response.exceptionDetails.exception?.description ||
          JSON.stringify(response.exceptionDetails),
      );
    return response.result.value;
  };
  const until = (expression, message) => waitFor(() => evaluate(expression), 12000, message);
  try {
    await mkdir(outputDir, { recursive: true });
    await Promise.all(
      ["png", "log"].map((extension) =>
        rm(path.join(outputDir, `${prefix}-failure.${extension}`), { force: true }),
      ),
    );
    server = spawn(
      serverPath,
      [
        "--config",
        "/dev/null",
        "--auth=false",
        "--host",
        "127.0.0.1",
        "--tls-cert",
        tls.cert,
        "--tls-key",
        tls.key,
        "--origin",
        `https://127.0.0.1:${port}`,
        "--shell",
        "/bin/sh",
        "--web-root",
        webRoot,
        "--port",
        String(port),
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GODEBUG: "http2server=0" },
        detached: true,
      },
    );
    server.detachedGroup = true;
    server.on("error", (error) => {
      processError = error;
    });
    server.stdout.on("data", (chunk) => {
      log += chunk;
    });
    server.stderr.on("data", (chunk) => {
      log += chunk;
    });
    await waitFor(
      async () => {
        if (processError) throw processError;
        return (await fetch(`https://127.0.0.1:${port}/`).catch(() => null))?.ok;
      },
      10000,
      "visual server did not start",
    );
    chromium = spawn(
      process.env.CHROMIUM || "chromium",
      [
        "--headless=new",
        `--force-device-scale-factor=${device.deviceScaleFactor}`,
        "--window-size=1440,900",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--ignore-certificate-errors",
        "--enable-unsafe-webgpu",
        "--use-angle=vulkan",
        "--ignore-gpu-blocklist",
        "--enable-features=Vulkan",
        "--disable-background-networking",
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"], detached: true },
    );
    chromium.detachedGroup = true;
    chromium.on("error", (error) => {
      processError = error;
    });
    chromium.stderr.on("data", (chunk) => {
      log += chunk;
    });
    const target = await waitFor(
      async () => {
        if (processError) throw processError;
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`).catch(() => null);
        return response?.ok && (await response.json()).find((target) => target.type === "page");
      },
      15000,
      "Chromium did not expose visual page",
    );
    const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
    browser = await Cdp.connect(version.webSocketDebuggerUrl);
    const { gpu } = await browser.call("SystemInfo.getInfo");
    assert.ok(gpu.devices?.length, "Chromium did not report a GPU");
    const gpuDescription = JSON.stringify(gpu.devices);
    assert.doesNotMatch(gpuDescription, /swiftshader|llvmpipe|software/i);
    page = await Cdp.connect(target.webSocketDebuggerUrl);
    await page.call("Runtime.enable");
    await page.call("Page.enable");
    const { name, ...metrics } = device;
    await page.call("Emulation.setDeviceMetricsOverride", metrics);
    await page.call("Emulation.setTouchEmulationEnabled", {
      enabled: device.mobile,
      maxTouchPoints: device.mobile ? 5 : 1,
    });
    await page.call("Page.addScriptToEvaluateOnNewDocument", {
      source: `(${installFontProbe.toString()})()`,
    });
    await page.call("Page.addScriptToEvaluateOnNewDocument", {
      source: `localStorage.setItem("bcwebmux.settings.v1", JSON.stringify({ renderer: 'canvas', grainStrength: 0, perfMode: ${JSON.stringify(device.mobile ? "simple" : "detailed")} }));`,
    });
    await page.call("Page.navigate", {
      url: `https://127.0.0.1:${port}/?gpu-test=1&renderer=canvas&backend=${backend}`,
    });
    await until("window.bcwebmux?.connected === true", "terminal did not connect");
    await evaluate(`(async () => {
      if (document.querySelector('#notification-dialog').open) document.querySelector('#notification-dialog-later').click();
      await document.fonts.ready;
      // Keep the real telemetry labels/layout, but normalize volatile counters and timings.
      const perf = document.querySelector('#perf');
      const descriptor = Object.getOwnPropertyDescriptor(HTMLOutputElement.prototype, 'value');
      const normalize = value => value.split('\\n').map(line => {
        if (/^(Scroll:|Rows:)/.test(line)) return line;
        if (line.startsWith('Viewport:')) return line.replace(/ · Glyph atlas:.*/, ' · Glyph atlas: 100 / 4096 (2%) · cache: 100 hit / 10 miss');
        return line.replace(/\\d+(?:\\.\\d+)?/g, '0').replace(/—/g, '0').replace(/0[BKMG]\\b/g, '0K');
      }).join('\\n');
      Object.defineProperty(perf, 'value', {
        get() { return descriptor.get.call(this); },
        set(value) { descriptor.set.call(this, normalize(value)); },
      });
      perf.value = perf.value;
    })()`);
    const state = await evaluate("window.bcwebmux.state");
    assert.equal(state.backend, backend);
    assert.equal(state.gpuFallbackAdapter, false);
    assert.doesNotMatch(JSON.stringify(state.gpuAdapter), /swiftshader|llvmpipe|software/i);
    assert.deepEqual(
      await evaluate("({width: innerWidth, height: innerHeight, dpr: devicePixelRatio})"),
      { width: device.width, height: device.height, dpr: device.deviceScaleFactor },
    );

    // Output travels through the real shell/PTY, not a browser-side renderer fixture.
    const output = async (text, reset = false) => {
      const title = `VISUAL READY ${++sequence}`;
      const payload = `${reset ? "\x1b[?1000l\x1b[?1007l\x1b[?1049l\x1b[3J\x1b[2J\x1b[H" : ""}${text}\x1b[0m\x1b[?25l\x1b]0;${title}\x07`;
      const command = `stty -echo; PS1=''; unset PROMPT_COMMAND; printf '%s' '${Buffer.from(payload).toString("base64")}' | base64 -d\r`;
      await evaluate(`window.bcwebmux.write(${JSON.stringify(command)})`);
      await until(
        `document.querySelector('#terminal-identity-primary').textContent === ${JSON.stringify(title)}`,
        "PTY fixture did not finish",
      );
    };
    const capture = async (label, goldenLabel = label) => {
      if (!device.mobile)
        await until(
          `(() => {
        const s = window.bcwebmux.state;
        return document.querySelector('#perf').value.includes('Scroll: ' + s.viewportMode + ' · ' + s.scrollOffset.toFixed(1) + '+' + s.scrollLength.toFixed(1) + '/' + s.scrollTotal.toFixed(1));
      })()`,
          "telemetry did not reflect the current viewport",
        );
      // Wait for submitted GPU work and two identical compositor frames; no fixed render sleeps.
      await evaluate(
        "(async () => { await window.bcwebmux.readPixels(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); })()",
      );
      let previous;
      const png = await waitFor(
        async () => {
          const { data } = await page.call("Page.captureScreenshot", {
            format: "png",
            fromSurface: true,
            captureBeyondViewport: false,
          });
          if (data === previous) return Buffer.from(data, "base64");
          previous = data;
          return null;
        },
        8000,
        `${label}: compositor did not settle`,
      );
      const name = `${prefix}-${label}`;
      const diagnostics = await evaluate("window.bcwebmux.state");
      assert.equal(diagnostics.gpuError, null);
      assert.ok(diagnostics.gpuFrames > 0);
      const geometry = await evaluate(`(() => {
        const canvas = document.querySelector('#screen');
        return { width: canvas.width, height: canvas.height, cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight, error: document.querySelector('#client-error').hidden ? null : document.querySelector('#client-error-message').textContent };
      })()`);
      assert.equal(geometry.error, null, `client error: ${geometry.error}`);
      assert.equal(
        geometry.width,
        Math.round(geometry.cssWidth * device.deviceScaleFactor),
        "canvas is not rendered at native DPR",
      );
      assert.equal(
        geometry.height,
        Math.round(geometry.cssHeight * device.deviceScaleFactor),
        "canvas is not rendered at native DPR",
      );
      await writeFile(
        path.join(outputDir, `${name}.json`),
        JSON.stringify({ device, backend, state: diagnostics }, null, 2),
      );
      try {
        results[label] = await compareScreenshot({
          png,
          name,
          goldenName: `${prefix}-${goldenLabel}`,
          goldenDir,
          outputDir,
          width: device.width * device.deviceScaleFactor,
          height: device.height * device.deviceScaleFactor,
          update: label === goldenLabel && process.env.UPDATE_GOLDEN === "1",
        });
      } catch (error) {
        failures.push(error.message);
      }
      return png;
    };
    const gallery = [
      "\x1b[1;36mbcwebmux · UTF-8 / source preview\x1b[0m",
      "Latin: café naïve Ångström Straße",
      "Greek: αβγ λ π Ω · Cyrillic: Привет",
      "CJK: 中文 日本語 한글 · wide: A界B",
      "Combining: e\u0301 a\u0308 n\u0303 · NFC: é ä ñ",
      "Emoji: 😀 🚀 🐱 🎉 🌍 ❤",
      "Sequences: 👩🏽‍💻 🇯🇵 ❤️ · A😀B A界B",
      "\x1b[31mred \x1b[32mgreen \x1b[34mblue \x1b[1mbold\x1b[0m \x1b[3mitalic\x1b[0m \x1b[4munderline\x1b[0m",
      "┌──────────────┐  ← ↑ → ↓",
      "│ box drawing  │  ░▒▓█",
      "└──────────────┘",
      "",
      "\x1b[1;33mtest/snapshot-fixture.zig\x1b[0m",
    ].join("\n");
    await output(`${gallery}\n${numberedSource(source.slice(0, 18))}\n`, true);
    await evaluate("(async () => { await window.bcwebmux.readPixels(); })()");
    const fontProbe = await evaluate("window.canvasFontProbe");
    for (const text of [
      "中",
      "文",
      "日",
      "本",
      "語",
      "한",
      "글",
      "e\u0301",
      "😀",
      "🚀",
      "🐱",
      "👩🏽‍💻",
      "🇯🇵",
      "❤️",
    ]) {
      const probe = fontProbe[text];
      assert.ok(probe, `${prefix}: ${text} did not reach Canvas as intact text`);
      assert.ok(probe.ink > 0, `${prefix}: ${text} rendered blank`);
      assert.equal(probe.missing, false, `${prefix}: ${text} rendered a missing-glyph box`);
      assert.match(probe.font, /JetBrains Mono Nerd Font.*Noto Emoji/);
    }
    await writeFile(
      path.join(outputDir, `${prefix}-font-probe.json`),
      JSON.stringify(fontProbe, null, 2),
    );
    await capture("unicode-source");

    await evaluate(`(() => {
      const select = document.querySelector('select[name="renderer"]');
      select.value = 'kb-stb';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await until(
      "window.bcwebmux.state.textRenderer === 'kb-stb'",
      "default text renderer was not restored",
    );
    await output(
      `\x1b[1;36mSCROLLBACK START · snapshot-fixture.zig\x1b[0m\n${numberedSource(source)}\n\x1b[1;33mSECOND PASS · snapshot-fixture.zig\x1b[0m\n${numberedSource(source)}\n\x1b[1;35mSCROLLBACK END · UTF-8: λ café\x1b[0m\n`,
      true,
    );
    await until(
      "window.bcwebmux.state.scrollTotal > window.bcwebmux.state.scrollLength + 20 && window.bcwebmux.state.scrollOffset + window.bcwebmux.state.scrollLength === window.bcwebmux.state.scrollTotal",
      "source did not fill scrollback",
    );
    const bottom = await capture("scroll-bottom");
    const scrollKey = async (key) => {
      await evaluate(`document.querySelector('#scrollbar').focus()`);
      await page.call("Input.dispatchKeyEvent", { type: "keyDown", key, code: key });
      await page.call("Input.dispatchKeyEvent", { type: "keyUp", key, code: key });
      await evaluate("document.querySelector('#scrollbar').blur()");
    };
    await scrollKey("Home");
    await until(
      "window.bcwebmux.state.scrollOffset === 0 && window.bcwebmux.state.viewportMode === 'top'",
      "Home did not reach oldest history",
    );
    const top = await capture("scroll-top");
    assert.notDeepEqual(top, bottom, "scrolling did not change the presented image");
    await scrollKey("PageDown");
    await until(
      "window.bcwebmux.state.scrollOffset > 0 && window.bcwebmux.state.scrollOffset + window.bcwebmux.state.scrollLength < window.bcwebmux.state.scrollTotal",
      "PageDown did not reach middle history",
    );
    await capture("scroll-middle");
    await scrollKey("End");
    await until(
      "window.bcwebmux.state.scrollOffset + window.bcwebmux.state.scrollLength === window.bcwebmux.state.scrollTotal",
      "End did not restore live bottom",
    );
    const returned = await capture("scroll-return", "scroll-bottom");
    assert.deepEqual(returned, bottom, "returning to bottom changed the screenshot");

    // Protocol transitions are covered by session-browser-resume; this visual
    // fixture checks a presented image using the same goldens as text.
    const pixels = Buffer.alloc(12 * 8 * 4);
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 12; x++) {
        const color =
          x < 6
            ? y < 4
              ? [240, 40, 55, 255]
              : [35, 110, 240, 255]
            : y < 4
              ? [50, 220, 95, 255]
              : [245, 70, 225, 128];
        pixels.set(color, (y * 12 + x) * 4);
      }
    await output(
      [
        "\x1b[2;1H\x1b[1;36mKitty graphics / PTY → GPU\x1b[0m",
        "\x1b[4;1HRGBA image · four colors · alpha blend",
        "\x1b[12;3H\x1b[37mtext beneath translucent pixels\x1b[0m",
        `\x1b[6;3H\x1b_Ga=T,q=2,f=32,s=12,v=8,i=71,c=20,r=12;${pixels.toString("base64")}\x1b\\`,
        "\x1b[20;1H\x1b[90mRendered by the GPU, not terminal glyphs.\x1b[0m",
      ].join(""),
      true,
    );
    await until(
      `(async () => {
      const { data, width } = await window.bcwebmux.readPixels();
      const { physicalCellWidth: cw, physicalCellHeight: ch } = window.bcwebmux.state;
      const i = (Math.floor(7 * ch) * width + Math.floor(4 * cw)) * 4;
      return data[i] > 180 && data[i + 1] < 80 && data[i + 2] < 90;
    })()`,
      "Kitty graphics scene did not reach GPU pixels",
    );
    await capture("kitty-graphics");
    const exceptions = page.events.filter((event) => event.method === "Runtime.exceptionThrown");
    assert.deepEqual(exceptions, []);
    console.log(JSON.stringify({ device: device.name, backend, results }));
  } catch (error) {
    if (page) {
      const capture = await page
        .call("Page.captureScreenshot", { format: "png" })
        .catch(() => null);
      if (capture)
        await writeFile(
          path.join(outputDir, `${prefix}-failure.png`),
          Buffer.from(capture.data, "base64"),
        );
    }
    await writeFile(path.join(outputDir, `${prefix}-failure.log`), log);
    throw new Error(`${prefix}: ${error.message}\nArtifacts: ${outputDir}`, { cause: error });
  } finally {
    await page?.close();
    await browser?.close();
    await terminateProcess(chromium);
    await terminateProcess(server);
    await rm(profile, { recursive: true, force: true });
    await tls.dispose();
  }
}

// Observe real terminal rasterization, not a separately rendered Unicode demo.
function installFontProbe() {
  const targets = new Set([
    "中",
    "文",
    "日",
    "本",
    "語",
    "한",
    "글",
    "e\u0301",
    "😀",
    "🚀",
    "🐱",
    "👩🏽‍💻",
    "🇯🇵",
    "❤️",
  ]);
  const fill = CanvasRenderingContext2D.prototype.fillText;
  const read = CanvasRenderingContext2D.prototype.getImageData;
  window.canvasFontProbe = {};
  CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
    fill.call(this, text, ...args);
    if (!targets.has(text) || this.canvas.width * this.canvas.height > 100000) return;
    const { width, height } = this.canvas;
    const alpha = (context) => {
      const rgba = read.call(context, 0, 0, width, height).data;
      return Array.from({ length: width * height }, (_, i) => rgba[i * 4 + 3]);
    };
    const pixels = alpha(this);
    const reference = document.createElement("canvas");
    reference.width = width;
    reference.height = height;
    const context = reference.getContext("2d", { willReadFrequently: true });
    for (const key of [
      "font",
      "fillStyle",
      "textAlign",
      "textBaseline",
      "direction",
      "fontKerning",
      "textRendering",
    ])
      context[key] = this[key];
    const missing = ["\u{10ffff}", "\u{10ffff}\u{10ffff}"].some((tofu) => {
      context.clearRect(0, 0, width, height);
      fill.call(context, tofu, ...args);
      return alpha(context).every((value, i) => value === pixels[i]);
    });
    window.canvasFontProbe[text] = {
      ink: pixels.filter((value) => value > 0).length,
      missing,
      font: this.font,
      width,
      height,
    };
  };
}
