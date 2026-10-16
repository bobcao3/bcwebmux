// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Cdp, freePort, terminateProcess, waitFor } from "./test-support.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const profile = await mkdtemp(path.join(os.tmpdir(), "bcwebmux-adaptive-atlas-"));
const backends = process.env.RENDER_BACKEND ? [process.env.RENDER_BACKEND] : ["webgpu", "webgl2"];
const angle = process.env.ANGLE_BACKEND ?? "vulkan";
assert.ok(backends.every((backend) => ["webgpu", "webgl2"].includes(backend)));
const server = createServer(async (request, response) => {
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  response.setHeader("Cache-Control", "no-store");
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    if (pathname === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end(
        "<!doctype html><title>Adaptive glyph atlas GPU verification</title><body></body>",
      );
      return;
    }
    const filename = path.resolve(root, `.${pathname}`);
    if (!filename.startsWith(root)) throw new Error("invalid path");
    response.setHeader(
      "Content-Type",
      filename.endsWith(".js")
        ? "text/javascript"
        : filename.endsWith(".wasm")
          ? "application/wasm"
          : "text/plain",
    );
    response.end(await readFile(filename));
  } catch {
    response.writeHead(404).end();
  }
});
let chromium;
let pageCdp;
let browserCdp;
let chromiumLog = "";
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}/`;
  const debugPort = await freePort();
  chromium = spawn(
    process.env.CHROMIUM || "chromium",
    [
      "--headless=new",
      "--force-device-scale-factor=1",
      "--window-size=640,480",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--enable-unsafe-webgpu",
      `--use-angle=${angle}`,
      "--ignore-gpu-blocklist",
      "--enable-unsafe-swiftshader",
      angle === "vulkan" ? "--enable-features=Vulkan" : "--disable-features=Vulkan",
      "--disable-background-networking",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      origin,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  chromium.stderr.on("data", (chunk) => {
    chromiumLog += chunk;
  });
  const target = await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`).catch(() => null);
      return (
        response?.ok &&
        (await response.json()).find((entry) => entry.type === "page" && entry.url === origin)
      );
    },
    15000,
    () => `Chromium did not expose the atlas page\n${chromiumLog}`,
  );
  const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
  browserCdp = await Cdp.connect(version.webSocketDebuggerUrl);
  pageCdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await pageCdp.call("Runtime.enable");
  await waitFor(
    async () => {
      const result = await pageCdp
        .call("Runtime.evaluate", {
          expression: "document.readyState",
          returnByValue: true,
        })
        .catch(() => null);
      return result?.result?.value === "complete";
    },
    10000,
    "atlas page did not finish loading",
  );
  for (const backend of backends) {
    const result = await pageCdp.call(
      "Runtime.evaluate",
      {
        expression: `(${verifyAtlas.toString()})(${JSON.stringify(backend)})`,
        awaitPromise: true,
        returnByValue: true,
      },
      120000,
    );
    assert.ok(
      !result.exceptionDetails,
      `${backend}: ${result.exceptionDetails?.exception?.description || JSON.stringify(result.exceptionDetails)}\n${chromiumLog}`,
    );
    console.log(JSON.stringify(result.result.value));
  }
} finally {
  if (browserCdp) await browserCdp.call("Browser.close").catch(() => {});
  await pageCdp?.close().catch(() => {});
  await browserCdp?.close().catch(() => {});
  await terminateProcess(chromium);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}

async function verifyAtlas(backend) {
  const base = "/wgpuTerminal/src/browser/render/";
  const { registerTerminal, resizeTerminalPartition, releaseTerminal, selectTerminal } =
    await import(`${base}GlyphAtlasRuntime.js`);
  const { GpuTerminal } = await import(`${base}webgpu/GpuTerminal.js`);
  const { WebGlTerminal } = await import(`${base}webgl/WebGlTerminal.js`);
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const equal = (actual, expected, message) =>
    check(actual === expected, `${message}: ${actual} != ${expected}`);
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  const Renderer = backend === "webgpu" ? GpuTerminal : WebGlTerminal;
  const renderer = await Renderer.create(
    canvas,
    { width: 520, height: 380 },
    "canvas",
    16 * 1024 * 1024,
  );
  const errors = [];
  const captureError = (event) => errors.push(event.error.message);
  renderer.device?.addEventListener("uncapturederror", captureError);
  try {
    renderer.glyphAtlasMaxDimension = 1024;
    renderer.setPhysicalCellMetrics(13, 19, 15, 80);
    const owner = {};
    registerTerminal(renderer, owner, 1600, 80);
    await renderer.initialize(1600);
    selectTerminal(renderer, owner);
    renderer.cols = 1;
    renderer.rows = 1;
    renderer.drawnCellCount = 1;
    if (renderer.indirectData) {
      renderer.indirectData[1] = 1;
      renderer.indirectDirty = true;
    }
    renderer.setGrainStrength(0);
    renderer.background = 0;
    const styles = new Uint32Array([0xffffff, 0, 0]);
    renderer.uploadStyles(0, styles, new Uint8Array(styles.buffer));
    const gray = (slot, value) =>
      renderer.uploadBitmap(slot, 1, new Uint8Array(13 * 19).fill(value), 0, 13);
    const rgba = (count, color) => {
      const pixels = new Uint8Array(count * 13 * 19 * 4);
      for (let i = 0; i < pixels.length; i += 4) pixels.set(color, i);
      return pixels;
    };
    const color = (slot, count, value) => {
      while (count > 0) {
        const chunk = Math.min(count, 78 - (slot % 78));
        renderer.uploadColorBitmap(slot, chunk, rgba(chunk, value), 0, chunk * 13 * 4);
        slot += chunk;
        count -= chunk;
      }
    };
    const snapshots = async (grayRows, colorRows) => {
      const coverage = await renderer.readGlyphAtlas();
      const overlay = await renderer.readColorAtlas();
      for (const [snapshot, rows, channels] of [
        [coverage, grayRows, 1],
        [overlay, colorRows, 4],
      ]) {
        equal(snapshot.width, 1024, "physical page width");
        equal(snapshot.columns, 78, "complete tile columns");
        equal(snapshot.rows, rows, "independent physical tile rows");
        equal(snapshot.height, rows * 19, "physical texture height");
        equal(snapshot.data.length, 1024 * rows * 19 * channels, "readback byte length");
        for (let y = 0; y < snapshot.height; y++) {
          for (let x = 1014 * channels; x < 1024 * channels; x++)
            equal(
              snapshot.data[y * 1024 * channels + x],
              0,
              "right-edge padding remains untouched",
            );
        }
      }
      return [coverage, overlay];
    };
    const tile = (snapshot, slot, expected) => {
      const channels = expected.length;
      const x = (slot % 78) * 13;
      const y = Math.floor(slot / 78) * 19;
      for (let row = 0; row < 19; row++)
        for (let column = 0; column < 13; column++) {
          const offset = ((y + row) * 1024 + x + column) * channels;
          for (let c = 0; c < channels; c++)
            equal(
              snapshot.data[offset + c],
              expected[c],
              `tile ${slot} pixel ${column},${row} channel ${c}`,
            );
        }
    };
    const frame = async (slot, expected) => {
      renderer.uploadCells(0, 1, new Uint32Array([slot + 1, 0x20000]), new Uint32Array([0]));
      if (renderer.device) {
        renderer.uniformU32.set([
          1,
          1,
          13,
          19,
          canvas.width,
          canvas.height,
          0,
          0xffffff,
          0xffff,
          0xffff,
          0,
          1,
          78,
          0,
          13,
          19,
          1,
        ]);
        renderer.device.queue.writeBuffer(renderer.uniformBuffer, 0, renderer.uniformData);
        renderer.device.queue.writeBuffer(
          renderer.drawIndirectBuffer,
          0,
          new Uint32Array([6, 1, 0, 0]),
        );
        const encoder = renderer.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: renderer.offscreenView,
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
              loadOp: "clear",
              storeOp: "store",
            },
          ],
        });
        pass.executeBundles([renderer.cellBundle]);
        pass.end();
        renderer.device.queue.submit([encoder.finish()]);
      } else renderer.presentCurrentState();
      const pixels = await renderer.readPixels();
      const offset = (9 * pixels.width + 6) * 4;
      const channels = pixels.format?.startsWith("bgra") ? [2, 1, 0] : [0, 1, 2];
      for (let c = 0; c < 3; c++)
        check(
          Math.abs(pixels.data[offset + channels[c]] - expected[c]) <= 1,
          `shader slot ${slot} channel ${c}: ${pixels.data[offset + channels[c]]} != ${expected[c]}`,
        );
      check(!renderer.error, renderer.error);
    };

    await snapshots(6, 6);
    equal(renderer.glyphPartitions.get(owner).slotCapacity, 1600, "full viewport admission");
    equal(renderer.atlas.capacity, 468, "quarter-screen physical allocation");
    gray(0, 71);
    const stridedGray = new Uint8Array(7 + 31 * 19).fill(251);
    for (let y = 0; y < 19; y++) {
      stridedGray.fill(51, 7 + y * 31, 7 + y * 31 + 13);
      stridedGray.fill(117, 7 + y * 31 + 13, 7 + y * 31 + 26);
    }
    renderer.uploadBitmap(37, 2, stridedGray, 7, 31);
    const high = 473;
    gray(high, 193);
    let [coverage, overlay] = await snapshots(12, 6);
    tile(coverage, 0, [71]);
    tile(coverage, 37, [51]);
    tile(coverage, 38, [117]);
    tile(coverage, high, [193]);
    const red = [211, 41, 83, 255];
    color(high, 1, red);
    [coverage, overlay] = await snapshots(12, 6);
    tile(overlay, 0, red);
    equal(
      overlay.data.filter((value, index) => index % 4 === 3 && value !== 0).length,
      13 * 19,
      "one high gray address consumes exactly one compact RGBA tile",
    );
    await frame(high, red);

    color(1, 468, [17, 139, 229, 255]);
    [coverage, overlay] = await snapshots(12, 12);
    tile(overlay, 0, red);
    tile(overlay, 468, [17, 139, 229, 255]);
    tile(coverage, 0, [71]);
    await frame(high, red);
    await frame(468, [17, 139, 229]);
    gray(1599, 103);
    [coverage, overlay] = await snapshots(21, 12);
    tile(coverage, 0, [71]);
    tile(coverage, high, [193]);
    tile(coverage, 1599, [103]);
    tile(overlay, 0, red);
    await frame(high, red);

    gray(high, 192);
    await frame(high, [192, 192, 192]);
    color(1599, 1, [29, 223, 61, 255]);
    [, overlay] = await snapshots(21, 12);
    tile(overlay, 0, [29, 223, 61, 255]);
    await frame(1599, [29, 223, 61]);
    await frame(high, [192, 192, 192]);
    resizeTerminalPartition(renderer, owner, 11440);
    await snapshots(21, 12);
    gray(11439, 143);
    [coverage] = await snapshots(159, 12);
    tile(coverage, 11439, [143]);
    tile(coverage, 0, [71]);
    await frame(1599, [29, 223, 61]);
    color(0, 5000, [41, 109, 173, 255]);
    await snapshots(159, 106);
    await frame(4999, [41, 109, 173]);
    gray(4999, 192);
    await frame(4999, [192, 192, 192]);
    color(11439, 1, [29, 223, 61, 255]);
    await frame(11439, [29, 223, 61]);
    const inactive = Array.from({ length: 20 }, () => ({}));
    for (const core of inactive) registerTerminal(renderer, core, 11440, 80);
    equal(
      renderer.glyphPartitions.reservedSlots,
      11440,
      "inactive terminals do not accumulate physical reservations",
    );
    for (const core of inactive) releaseTerminal(renderer, core);
    resizeTerminalPartition(renderer, owner, 100);
    equal(
      renderer.glyphPartitions.get(owner).slotCapacity,
      11440,
      "shrinking retains the viewport high-water reservation",
    );
    await snapshots(159, 106);

    renderer.reconfigureGlyphAtlas(
      { width: 13, height: 19, fontSize: 15, columns: 7 },
      "canvas",
      "monospace",
      1600,
    );
    [coverage, overlay] = await snapshots(6, 6);
    check(
      coverage.data.every((value) => value === 0),
      "reset clears grayscale pixels",
    );
    check(
      overlay.data.every((value) => value === 0),
      "reset clears color pixels",
    );
    color(0, 1000, [233, 79, 149, 0]);
    [, overlay] = await snapshots(21, 6);
    check(
      overlay.data.every((value) => value === 0),
      "alpha-zero uploads do not allocate or write RGBA tiles",
    );
    gray(high, 155);
    await frame(high, [155, 155, 155]);
    renderer.reconfigureGlyphAtlas(
      { width: 13, height: 19, fontSize: 15, columns: 7 },
      "canvas",
      "monospace",
      100,
    );
    await snapshots(4, 4);
    equal(renderer.atlas.capacity, 312, "small viewports retain the whole-row 256-slot minimum");
    renderer.reconfigureGlyphAtlas(
      { width: 17, height: 23, fontSize: 17, columns: 200 },
      "canvas",
      "monospace",
      100,
    );
    const reconfigured = await renderer.readGlyphAtlas();
    equal(reconfigured.width, 1024, "metric reconfiguration retains fixed width");
    equal(reconfigured.columns, 60, "metric reconfiguration recomputes complete columns");
    equal(reconfigured.height, 115, "metric reconfiguration recomputes the minimum row count");
    check(
      reconfigured.data.every((value) => value === 0),
      "metric reconfiguration clears old texels",
    );
    renderer.reconfigureGlyphAtlas(
      { width: 13, height: 19, fontSize: 15, columns: 80 },
      "canvas",
      "monospace",
      100,
    );
    const { TerminalCore } = await import("/wgpuTerminal/src/TerminalCore.js");
    const { FramePresenter } = await import(`${base}FramePresenter.js`);
    const presenter = new FramePresenter({ _submitFrameMetadata() {} }, renderer);
    const cores = [];
    try {
      for (const text of ["A", "B"]) {
        const core = new TerminalCore({
          renderer: "canvas",
          font: { ligatures: false },
          wasmUrl: "/app-bcwebmux/zig-out/wgpu-terminal/terminal.wasm",
        });
        cores.push(core);
        await core.open({ cols: 80, rows: 20 });
        registerTerminal(renderer, core, 1600, 80);
        core.setRenderMetrics({ cellWidth: 13, cellHeight: 19, fontSize: 15 });
        core.write("\x1b[?25l" + text);
      }
      const captureCore = async (core) => {
        presenter.selectTerminal(core);
        equal(presenter.consumeFrame(core), 1, "activated core submits a replacement frame");
        check(renderer.cacheMisses > 0, "ownership changes must rerasterize overwritten glyphs");
        const image = await renderer.readGlyphAtlas();
        const mask = [];
        for (let y = 0; y < 19; y++)
          for (let x = 0; x < 13; x++) mask.push(image.data[y * image.width + x]);
        return mask;
      };
      const first = await captureCore(cores[0]);
      const second = await captureCore(cores[1]);
      check(
        first.some((value) => value > 0),
        "the real backend rasterizes the first glyph",
      );
      check(
        first.some((value, index) => value !== second[index]),
        "the second terminal replaces the first terminal's glyph",
      );
      const restored = await captureCore(cores[0]);
      check(
        first.every((value, index) => value === restored[index]),
        "reactivation rebuilds the original glyph rather than reusing the other terminal's pixels",
      );
    } finally {
      for (const core of cores) {
        releaseTerminal(renderer, core);
        core.dispose();
      }
    }
    if (renderer.device) await renderer.device.queue.onSubmittedWorkDone();
    if (renderer.gl) equal(renderer.gl.getError(), renderer.gl.NO_ERROR, "WebGL validation");
    check(errors.length === 0, `GPU validation: ${errors.join("; ")}`);
    check(!renderer.error, renderer.error);
    return { backend, adapter: renderer.adapterInfo, passed: true };
  } finally {
    renderer.device?.removeEventListener("uncapturederror", captureError);
    renderer.dispose();
    canvas.remove();
  }
}
