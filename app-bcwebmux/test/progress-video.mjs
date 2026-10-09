// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitFor } from "./test-support.mjs";
import { VideoGoldens } from "./video-goldens.mjs";

export async function recordProgressVideos({ page, evaluate, report, backend }) {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const videos = new VideoGoldens({
    goldenDir: path.join(testDir, "golden", "terminal-progress", backend),
    outputDir: path.resolve(
      process.env.BCWEBMUX_SCREENSHOT_DIR ||
        path.join(testDir, "..", "zig-out", "screenshots", "terminal-progress"),
      backend,
    ),
    update: process.env.UPDATE_GOLDEN === "1",
  });
  await evaluate(`(() => {
    window.progressVideoClock = { now: performance.now() + 1000 };
    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: () => window.progressVideoClock.now,
    });
  })()`);
  try {
    await page.call("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
    });
    for (const [group, status, predicate] of [
      [
        "wave",
        "state=working:progress=65",
        "document.querySelector('#terminal-progress').getAttribute('aria-valuenow') === '65'",
      ],
      [
        "bounce",
        "state=working",
        "!document.querySelector('#terminal-progress').hasAttribute('aria-valuenow')",
      ],
    ]) {
      await evaluate("window.progressVideoClock.now += 100");
      await report(
        "\\033]7501;state=blocked:progress=0\\007",
        "document.querySelector('#terminal-progress').getAttribute('aria-valuenow') === '0'",
      );
      await evaluate("window.progressVideoClock.now += 100");
      await report(`\\033]7501;${status}\\007`, predicate);
      const hashes = new Set();
      for (let index = 0; index < 24; index++) {
        if (index > 0) {
          const before = await evaluate("window.bcwebmux.state.gpuFrames");
          await evaluate("window.progressVideoClock.now += 200");
          await waitFor(
            async () => (await evaluate("window.bcwebmux.state.gpuFrames")) > before,
            5000,
            "the video clock did not reach a GPU presentation",
          );
        }
        await evaluate(
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        );
        const sample = await evaluate("progressProbe.sample()");
        hashes.add(sample.hash);
        if (group === "wave") assert.equal(sample.blockErrors, 0);
        const clip = await evaluate(`(() => {
          const rect = document.querySelector('#screen').getBoundingClientRect();
          const height = Math.ceil(${sample.height - sample.minY} * rect.height / ${sample.height});
          return { x: Math.floor(rect.x), y: Math.ceil(rect.bottom) - height, width: Math.floor(rect.width), height, scale: 1 };
        })()`);
        const { data } = await page.call("Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
          clip,
        });
        await videos.add({
          png: Buffer.from(data, "base64"),
          name: `${group}-${String(index).padStart(2, "0")}`,
          width: clip.width,
          height: clip.height,
          group,
        });
      }
      assert.ok(hashes.size > 1, `${backend}: ${group} video must contain animation`);
    }
    await videos.finish();
    console.log(`${backend}: wave and bounce video goldens passed`);
  } finally {
    await evaluate("delete performance.now; delete window.progressVideoClock");
    await videos.dispose();
  }
}
