// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao
//
// Color emoji e2e: Canvas is the default text renderer. Colored glyphs keep a
// grayscale coverage entry in the R8 atlas plus one RGBA entry in a dedicated
// overlay texture (same slot geometry, alpha-blended on top). This test drives
// a real PTY/shell with the bundled default emoji font, asserts the overlay, the
// retained grayscale layer, and the composited frame all carry color, and
// saves screenshots for visual validation.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Cdp, freePort, terminateProcess, waitFor } from "./test-support.mjs";
import { startDaemon } from "./test-daemon.mjs";

const [serverPath, webRoot] = process.argv.slice(2);
assert.ok(serverPath && webRoot, "usage: color-emoji-e2e.mjs SERVER WEB_ROOT");
const testDir = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(
  process.env.BCWEBMUX_SCREENSHOT_DIR || path.join(testDir, "..", "zig-out", "screenshots"),
);
await mkdir(outputDir, { recursive: true });
const backends = process.env.RENDER_BACKEND ? [process.env.RENDER_BACKEND] : ["webgpu", "webgl2"];
assert.ok(backends.every((backend) => ["webgpu", "webgl2"].includes(backend)));

for (const backend of backends) await run(backend);
console.log(`Color emoji screenshots: ${outputDir}`);

async function run(backend) {
  const profile = await mkdtemp(path.join(os.tmpdir(), "bcwebmux-color-emoji-"));
  const serverPort = await freePort();
  const debugPort = await freePort();
  const pageQuery = `?gpu-test=1&backend=${backend}`;
  let server;
  let daemon;
  let chromium;
  let pageCdp;
  let browserCdp;
  let serverLog = "";
  try {
    const session = await startDaemon(serverPath, profile);
    daemon = session.child;
    server = spawn(
      serverPath,
      [
        "--config",
        "/dev/null",
        "--auth=false",
        "--session-socket",
        session.socket,
        "--web-root",
        webRoot,
        "--listen",
        `127.0.0.1:${serverPort}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, XDG_STATE_HOME: profile } },
    );
    server.stdout.on("data", (chunk) => {
      serverLog += chunk;
    });
    server.stderr.on("data", (chunk) => {
      serverLog += chunk;
    });
    await waitFor(
      async () => (await fetch(`http://127.0.0.1:${serverPort}/`).catch(() => null))?.ok,
      10000,
      () => `color emoji server did not start\n${serverLog}`,
    );
    chromium = spawn(
      process.env.CHROMIUM || "chromium",
      [
        "--headless=new",
        "--force-device-scale-factor=1",
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
        `http://127.0.0.1:${serverPort}/${pageQuery}`,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let chromiumLog = "";
    chromium.stderr.on("data", (chunk) => {
      chromiumLog += chunk;
    });
    const target = await waitFor(
      async () => {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`).catch(() => null);
        if (!response?.ok) return null;
        const targets = await response.json();
        return targets.find(
          (item) =>
            item.type === "page" &&
            item.url.startsWith(`http://127.0.0.1:${serverPort}/${pageQuery}`),
        );
      },
      15000,
      () => `Chromium failed to expose the color emoji page\n${chromiumLog}`,
    );
    const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
    browserCdp = await Cdp.connect(version.webSocketDebuggerUrl);
    pageCdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await pageCdp.call("Runtime.enable");
    await pageCdp.call("Page.enable");
    const evaluate = async (expression) => {
      const response = await pageCdp.call("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (response.exceptionDetails) {
        throw new Error(
          response.exceptionDetails.exception?.description || "browser evaluation failed",
        );
      }
      return response.result.value;
    };
    const until = (expression, message) => waitFor(() => evaluate(expression), 15000, message);
    await until(
      "window.bcwebmux?.connected && window.bcwebmux.state.textRenderer === 'canvas' && !window.bcwebmux.state.gpuError",
      "Canvas text renderer did not become active",
    );
    await evaluate(`(() => {
      const button = [...document.querySelectorAll("button")].find(
        (button) => button.textContent.trim() === "NOT NOW",
      );
      if (button) button.click();
    })()`);
    assert.ok(
      await evaluate(`window.bcwebmux.state.fontFamily?.includes('"Noto Color Emoji"')`),
      "The default font chain must include Noto Color Emoji",
    );
    assert.ok(
      await evaluate(`[...document.fonts].some(
        (face) => face.family.replaceAll('"', "") === "Noto Color Emoji" && face.status === "loaded",
      )`),
      "The browser must load the bundled Noto Color Emoji face",
    );
    // Render through the real shell/PTY so shaping, wide cells, and the glyph
    // cache all run: a color emoji row plus monochrome fallbacks and fg color.
    const payload =
      "printf '\\033[2J\\033[H\\033[?25l😀 🚀 🎉 🌍\\n❤️ 👩🏽‍💻 🇯🇵 A😀B\\n\\033[31mRED \\033[32mGREEN \\033[34mBLUE\\033[0m X\\n'\r";
    await evaluate(`window.bcwebmux.write(${JSON.stringify(payload)})`);
    let probe;
    try {
      probe = await waitFor(
        async () =>
          await evaluate(`(async () => {
          try {
            const state = window.bcwebmux.state;
            if (state.gpuError || state.textRenderer !== "canvas") return null;
            const frame = await window.bcwebmux.readPixels();
            const color = await window.bcwebmux.readColorAtlas();
            const gray = await window.bcwebmux.readGlyphAtlas();
            let overlayInk = 0;
            let overlayChroma = 0;
            for (let i = 0; i < color.data.length; i += 4) {
              const a = color.data[i + 3];
              if (a > 8) {
                overlayInk += 1;
                const spread = Math.max(color.data[i], color.data[i + 1], color.data[i + 2])
                  - Math.min(color.data[i], color.data[i + 1], color.data[i + 2]);
                if (spread > 24) overlayChroma += 1;
              }
            }
            let grayInk = 0;
            for (let i = 0; i < gray.data.length; i++) if (gray.data[i] > 8) grayInk += 1;
            let frameChroma = 0;
            let frameInk = 0;
            for (let i = 0; i < frame.data.length; i += 4) {
              const r = frame.data[i];
              const g = frame.data[i + 1];
              const b = frame.data[i + 2];
              const spread = Math.max(r, g, b) - Math.min(r, g, b);
              if (spread > 40) frameChroma += 1;
              if (r > 60 || g > 60 || b > 60) frameInk += 1;
            }
            if (overlayInk < 50 || overlayChroma < 20 || grayInk < 50 || frameChroma < 200 || frameInk < 500)
              return null;
            return {
              overlayInk,
              overlayChroma,
              grayInk,
              frameChroma,
              frameInk,
              glyphSlotsUsed: state.glyphSlotsUsed,
              gpuFrames: state.gpuFrames,
            };
          } catch { return null; }
        })()`),
        120000,
        "color emoji did not reach the overlay texture and composited frame",
      );
    } catch (error) {
      let diagnostic;
      try {
        diagnostic = await evaluate(`(async () => {
          try {
            const state = window.bcwebmux.state;
            const frame = await window.bcwebmux.readPixels();
            const color = await window.bcwebmux.readColorAtlas();
            const gray = await window.bcwebmux.readGlyphAtlas();
            let overlayInk = 0;
            for (let i = 0; i < color.data.length; i += 4) if (color.data[i + 3] > 8) overlayInk += 1;
            let grayInk = 0;
            for (let i = 0; i < gray.data.length; i++) if (gray.data[i] > 8) grayInk += 1;
            let frameInk = 0;
            for (let i = 0; i < frame.data.length; i += 4) if (frame.data[i] > 60 || frame.data[i + 1] > 60 || frame.data[i + 2] > 60) frameInk += 1;
            return { textRenderer: state.textRenderer, gpuError: state.gpuError, glyphSlotsUsed: state.glyphSlotsUsed, gpuFrames: state.gpuFrames, overlayInk, grayInk, frameInk };
          } catch (inner) { return { error: String(inner?.message || inner) }; }
        })()`);
      } catch (inner) {
        diagnostic = { error: String(inner?.message || inner) };
      }
      throw new Error(`${error.message} diagnostic=${JSON.stringify(diagnostic)}`);
    }
    assert.ok(probe.overlayInk >= 50, `overlay has no ink: ${JSON.stringify(probe)}`);
    assert.ok(probe.overlayChroma >= 20, `overlay has no color: ${JSON.stringify(probe)}`);
    assert.ok(probe.grayInk >= 50, `grayscale layer lost ink: ${JSON.stringify(probe)}`);
    assert.ok(probe.frameChroma >= 200, `frame has no color: ${JSON.stringify(probe)}`);
    const state = await evaluate("window.bcwebmux.state");
    assert.equal(state.gpuError, null);
    assert.equal(state.textRenderer, "canvas");
    assert.ok(state.gpuFrames >= 1);
    const { data } = await pageCdp.call("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const name = `color-emoji-${backend}`;
    await writeFile(path.join(outputDir, `${name}.png`), Buffer.from(data, "base64"));
    await writeFile(
      path.join(outputDir, `${name}.json`),
      JSON.stringify({ backend, renderer: "canvas", probe, state }, null, 2),
    );
    if (backend === backends[0]) {
      const migrations = [
        {
          version: 1,
          font: "jetbrains-mono",
          before: ["ui-monospace", "Noto Emoji", "Custom Mono", "monospace"],
          after: ["ui-monospace", "Noto Color Emoji", "Custom Mono", "monospace"],
        },
        {
          font: "fira-code",
          before: ["ui-monospace", "Noto Sans Symbols 2", "monospace"],
          after: ["ui-monospace", "Noto Color Emoji", "Noto Sans Symbols 2", "monospace"],
        },
        {
          version: 1,
          font: "fira-code",
          before: ["Custom Mono", "noto emoji", "Noto Color Emoji", "monospace"],
          after: ["Custom Mono", "Noto Color Emoji", "monospace"],
        },
        {
          version: 1,
          font: "jetbrains-mono",
          before: ["Custom Mono", "monospace"],
          after: ["Custom Mono", "monospace"],
        },
        {
          version: 2,
          font: "jetbrains-mono",
          before: ["Noto Emoji", "monospace"],
          after: ["Noto Emoji", "monospace"],
        },
      ];
      for (const [index, migration] of migrations.entries()) {
        const saved = {
          fontFamily: migration.font,
          fontFallbackVersion: migration.version,
          fontFallbacks: { [migration.font]: migration.before },
        };
        await evaluate(
          `localStorage.setItem("bcwebmux.settings.v1", ${JSON.stringify(JSON.stringify(saved))})`,
        );
        const url = `http://127.0.0.1:${serverPort}/${pageQuery}&font-migration=${index}`;
        await pageCdp.call("Page.navigate", { url });
        await until(
          `location.href === ${JSON.stringify(url)} && window.bcwebmux?.connected && !window.bcwebmux.state.gpuError`,
          `Font migration ${index} did not initialize`,
        );
        const actual = await evaluate(`(() => {
          const area = document.querySelector('textarea[name="fontFallbacks"]');
          const families = area.value.split("\\n");
          document.querySelector("#font-size-increase").click();
          return { families, saved: JSON.parse(localStorage.getItem("bcwebmux.settings.v1")) };
        })()`);
        assert.deepEqual(actual.families, migration.after, `Font migration ${index}`);
        assert.deepEqual(actual.saved.fontFallbacks[migration.font], migration.after);
        assert.equal(actual.saved.fontFallbackVersion, 2);
      }
    }
  } finally {
    try {
      pageCdp?.socket?.close();
    } catch {}
    try {
      browserCdp?.socket?.close();
    } catch {}
    await terminateProcess(chromium).catch(() => {});
    await terminateProcess(server).catch(() => {});
    await terminateProcess(daemon).catch(() => {});
    await rm(profile, { recursive: true, force: true });
  }
}
