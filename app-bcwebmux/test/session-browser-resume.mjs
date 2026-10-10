// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import sharp from "sharp";
import { Cdp, freePort, localTls, terminateProcess, waitFor } from "./test-support.mjs";

const [serverPath, webRoot] = process.argv.slice(2);
assert.ok(serverPath && webRoot, "usage: session-browser-resume.mjs SERVER WEB_ROOT");
const quality = process.env.WEBP_QUALITY;
assert.ok(quality === undefined || (/^\d+$/.test(quality) && Number(quality) <= 100));
const qualityArgs = quality === undefined ? [] : ["--webp-quality", quality];
const serverPort = await freePort();
const debugPort = await freePort();
const base = `https://127.0.0.1:${serverPort}`;
const tls = await localTls();
const profile = await mkdtemp(path.join(os.tmpdir(), "bcwebmux-session-browser-"));
const shell = path.join(profile, "shell");
await writeFile(shell, "#!/bin/sh\nexec /bin/bash --noprofile --norc -i\n", { mode: 0o700 });
let server = spawn(
  serverPath,
  [
    "--config",
    "/dev/null",
    "--auth=false",
    "--shell",
    shell,
    "--tls-cert",
    tls.cert,
    "--tls-key",
    tls.key,
    "--web-root",
    webRoot,
    "--listen",
    `127.0.0.1:${serverPort}`,
    "--origin",
    base,
    ...qualityArgs,
  ],
  {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: profile, GODEBUG: "http2server=0" },
  },
);
let serverLog = "";
server.stdout.on("data", (data) => {
  serverLog += data;
});
server.stderr.on("data", (data) => {
  serverLog += data;
});
let chromium;
let page;
let browser;

try {
  await waitFor(
    async () => (await fetch(`${base}/api/server`).catch(() => null))?.ok,
    10000,
    "server failed to start",
  );
  const font = await fetch(`${base}/fonts/JetBrainsMonoNerdFontMono-Regular.ttf`);
  assert.equal(font.status, 200);
  assert.match(font.headers.get("content-type") || "", /^font\/ttf(?:;|$)/);
  assert.equal(font.headers.get("cache-control"), "public, no-cache, must-revalidate");
  assert.match(font.headers.get("etag") || "", /^"[0-9a-f]{64}"$/);
  assert.ok((await font.arrayBuffer()).byteLength > 2 * 1024 * 1024);
  const dialogs = await fetch(`${base}/dialogs.css`);
  assert.equal(dialogs.status, 200);
  chromium = spawn(
    process.env.CHROMIUM || "chromium",
    [
      "--headless=new",
      "--window-size=1024,720",
      "--no-sandbox",
      "--ignore-certificate-errors",
      "--disable-dev-shm-usage",
      "--enable-unsafe-webgpu",
      "--use-angle=vulkan",
      "--ignore-gpu-blocklist",
      "--enable-features=Vulkan",
      "--disable-background-networking",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      `${base}/?session-test=1&backend=${process.env.RENDER_BACKEND || "webgpu"}`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  const target = await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`).catch(() => null);
      if (!response?.ok) return null;
      return (await response.json()).find(
        (item) => item.type === "page" && item.url.includes("session-test=1"),
      );
    },
    15000,
    "Chromium did not expose session page",
  );
  const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
  browser = await Cdp.connect(version.webSocketDebuggerUrl);
  page = await Cdp.connect(target.webSocketDebuggerUrl);
  await page.call("Runtime.enable");
  await page.call("Page.enable");

  await waitBrowser(
    page,
    "window.bcwebmux?.connected === true",
    10000,
    "initial attachment did not become live",
  );
  const initial = await evaluate(
    page,
    "({ id: window.bcwebmux.activeSessionId, client: window.bcwebmux.clientInstanceId, cores: window.bcwebmux.coreCount })",
  );
  assert.match(initial.id, /^[0-9a-f-]{36}$/);
  assert.match(initial.client, /^[0-9a-f-]{36}$/);
  assert.equal(initial.cores, 1);

  await evaluate(
    page,
    `window.bcwebmux.write("echo L3PID=$$; echo BEFORE-RELOAD; M=WHILE; N=-DETACHED; (sleep 0.4; echo $M$N)&\\n")`,
  );
  await waitBrowser(
    page,
    `/L3PID=\\d+/.test(window.bcwebmux.sessionText())`,
    5000,
    "pre-reload output missing",
  );
  const beforeText = await evaluate(page, "window.bcwebmux.sessionText()");
  const pid = beforeText.match(/L3PID=(\d+)/)?.[1];
  assert.ok(pid, beforeText);

  await page.call("Page.reload", { ignoreCache: true });
  await waitBrowser(
    page,
    "window.bcwebmux?.connected === true",
    10000,
    "reloaded attachment did not become live",
  );
  await waitBrowser(
    page,
    `window.bcwebmux.sessionText().includes("WHILE-DETACHED")`,
    5000,
    "detached output was not replayed",
  );
  const resumed = await evaluate(
    page,
    `({ id: window.bcwebmux.activeSessionId, text: window.bcwebmux.sessionText(), cores: window.bcwebmux.coreCount, client: window.bcwebmux.clientInstanceId })`,
  );
  assert.equal(resumed.id, initial.id);
  assert.equal(resumed.client, initial.client);
  assert.equal(resumed.cores, 1);
  assert.match(resumed.text, new RegExp(`L3PID=${pid}`));
  assert.equal((resumed.text.match(/WHILE-DETACHED/g) || []).length, 1, resumed.text);

  const redImage = Buffer.from([
    255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255,
  ]).toString("base64");
  const kitty = `\x1b[10;1H\x1b_Ga=T,q=2,f=32,s=2,v=2,i=42,c=3,r=2;${redImage}\x1b\\`;
  const shell = `stty -echo; printf '%s' '${Buffer.from(kitty).toString("base64")}' | base64 -d\n`;
  await evaluate(page, `window.bcwebmux.write(${JSON.stringify(shell)})`);
  const redPixel = `(async () => {
    const result = await window.bcwebmux.readPixels();
    const x = Math.floor(window.bcwebmux.state.physicalCellWidth);
    const y = Math.floor(window.bcwebmux.state.physicalCellHeight * 9.5);
    const pixel = [...result.data.slice((y * result.width + x) * 4, (y * result.width + x) * 4 + 4)];
    return pixel[0] > 200 && pixel[1] < 50 && pixel[2] < 50;
  })()`;
  await waitBrowser(page, redPixel, 8000, "Kitty image was not drawn to GPU pixels");
  const imageScreenshot = (await page.call("Page.captureScreenshot", { format: "png" })).data;
  const deletion = Buffer.from("\x1b_Ga=d,d=I,i=42;\x1b\\").toString("base64");
  await evaluate(
    page,
    `window.bcwebmux.write(${JSON.stringify(`printf '%s' '${deletion}' | base64 -d; printf 'GRAPHICS-DELETED\\n'\n`)})`,
  );
  await waitBrowser(
    page,
    "window.bcwebmux.sessionText().includes('GRAPHICS-DELETED')",
    5000,
    "delete command was not processed by PTY",
  );
  await waitBrowser(
    page,
    `(async () => !(await ${redPixel}))()`,
    8000,
    "Kitty delete did not clear GPU pixels",
  );
  const clearedScreenshot = (await page.call("Page.captureScreenshot", { format: "png" })).data;
  assert.notEqual(
    imageScreenshot,
    clearedScreenshot,
    "image upload and delete screenshots are identical",
  );
  assert.equal((await evaluate(page, "window.bcwebmux.state")).gpuError, null);

  const writeControl = async (control, marker) => {
    const bytes = Buffer.from(control).toString("base64");
    await evaluate(
      page,
      `window.bcwebmux.write(${JSON.stringify(`printf '%s' '${bytes}' | base64 -d; printf '${marker}\\n'\n`)})`,
    );
    await waitBrowser(
      page,
      `window.bcwebmux.sessionText().includes(${JSON.stringify(marker)})`,
      5000,
      `${marker} output missing`,
    );
  };
  await writeControl("\x1b[10;1HN\x1b[10;1H", "GLYPH-READY");
  const region = `(async () => {
    const { data, width } = await window.bcwebmux.readPixels();
    const state = window.bcwebmux.state;
    const cellWidth = state.physicalCellWidth, cellHeight = state.physicalCellHeight;
    let white = 0, blue = 0, green = 0;
    for (let y = 9 * cellHeight; y < 10 * cellHeight; y++) {
      for (let x = 0; x < cellWidth; x++) {
        const i = (y * width + x) * 4;
        if (data[i] > 180 && data[i + 1] > 180 && data[i + 2] > 180) white++;
        if (data[i + 2] > 180 && data[i] < 70 && data[i + 1] < 70) blue++;
        if (data[i + 1] > 180 && data[i] < 70 && data[i + 2] < 70) green++;
      }
    }
    return { white, blue, green };
  })()`;
  await waitBrowser(
    page,
    `(${region}).then(p => p.white > 4)`,
    5000,
    "glyph foreground missing before graphics underlay",
  );
  const png = await sharp({
    create: { width: 2, height: 2, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const pngBase64 = deflateSync(png).toString("base64");
  const split = Math.floor(pngBase64.length / 8) * 4;
  const first = `\x1b[10;1H\x1b_Ga=T,q=2,f=100,o=z,S=${png.length},i=43,c=3,r=2,z=-1,m=1;${pngBase64.slice(0, split)}\x1b\\`;
  const second = `\x1b_Gm=0;${pngBase64.slice(split)}\x1b\\`;
  await writeControl(first + second, "PNG-READY");
  await waitBrowser(
    page,
    `(${region}).then(p => p.blue > 4 && p.white > 4)`,
    8000,
    "chunked zlib PNG underlay erased text or did not render",
  );
  const underlayScreenshot = (await page.call("Page.captureScreenshot", { format: "png" })).data;
  const green = Buffer.from([
    0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255,
  ]).toString("base64");
  await writeControl(
    `\x1b[10;1H\x1b_Ga=T,q=2,f=32,s=2,v=2,i=44,p=7,c=3,r=2,z=1;${green}\x1b\\`,
    "OVERLAY-READY",
  );
  await waitBrowser(
    page,
    `(${region}).then(p => p.green > 4 && p.white < 3)`,
    8000,
    "positive-z Kitty image did not cover glyphs",
  );
  const overlayScreenshot = (await page.call("Page.captureScreenshot", { format: "png" })).data;
  assert.notEqual(underlayScreenshot, overlayScreenshot, "z-layer screenshots are identical");
  await writeControl("\x1b_Ga=p,q=2,i=43,p=8,P=44,Q=7,H=4,C=1,c=2,r=2,z=1\x1b\\", "RELATIVE-READY");
  await waitBrowser(
    page,
    `(async () => {
    const { data, width } = await window.bcwebmux.readPixels();
    const state = window.bcwebmux.state;
    const x = Math.floor(state.physicalCellWidth * 4.5), y = Math.floor(state.physicalCellHeight * 9.5);
    const i = (y * width + x) * 4;
    return data[i] < 70 && data[i + 1] < 70 && data[i + 2] > 180;
  })()`,
    8000,
    "relative Kitty placement did not follow parent cell offset",
  );
  const virtual =
    "\x1b_Ga=p,q=2,i=43,p=9,U=1,c=1,r=1\x1b\\" +
    "\x1b[15;1H\x1b[38;2;0;0;43m\x1b[58;2;0;0;9m\u{10EEEE}\u{0305}\u{0305}\x1b[0m";
  await writeControl(virtual, "VIRTUAL-READY");
  await waitBrowser(
    page,
    `(async () => {
    const { data, width } = await window.bcwebmux.readPixels();
    const state = window.bcwebmux.state;
    const x = Math.floor(state.physicalCellWidth / 2), y = Math.floor(state.physicalCellHeight * 14.5);
    const i = (y * width + x) * 4;
    return data[i] < 70 && data[i + 1] < 70 && data[i + 2] > 180;
  })()`,
    8000,
    "Unicode placeholder image fragment did not render",
  );
  const alphaPixel = `(async () => {
    const { data, width } = await window.bcwebmux.readPixels();
    const state = window.bcwebmux.state;
    const x = Math.floor(state.physicalCellWidth / 2), y = Math.floor(state.physicalCellHeight * 19.5);
    const i = (y * width + x) * 4;
    return [...data.slice(i, i + 4)];
  })()`;
  const alphaBase = await evaluate(page, alphaPixel);
  const halfRed = Buffer.from([255, 0, 0, 128]).toString("base64");
  await writeControl(
    `\x1b[20;1H\x1b_Ga=T,q=2,f=32,s=1,v=1,i=46,c=2,r=2;${halfRed}\x1b\\`,
    "ALPHA-READY",
  );
  await waitBrowser(
    page,
    `(${alphaPixel}).then(pixel => pixel[0] > ${alphaBase[0] + 50})`,
    8000,
    "translucent Kitty pixel was not presented",
  );
  const alphaBlend = await evaluate(page, alphaPixel);
  for (let channel = 0; channel < 3; channel++) {
    const expected = alphaBase[channel] * (127 / 255) + (channel === 0 ? 128 : 0);
    assert.ok(
      Math.abs(alphaBlend[channel] - expected) < 25,
      `Kitty RGBA blending channel ${channel}: ${alphaBlend} vs ${alphaBase}`,
    );
  }
  const alternate = `\x1b[?1049h\x1b[H\x1b_Ga=T,q=2,f=32,s=2,v=2,i=45,c=2,r=2;${redImage}\x1b\\`;
  await writeControl(alternate, "ALTERNATE-READY");
  await waitBrowser(
    page,
    `(async () => {
    const { data, width } = await window.bcwebmux.readPixels();
    const x = Math.floor(window.bcwebmux.state.physicalCellWidth), y = Math.floor(window.bcwebmux.state.physicalCellHeight / 2);
    const i = (y * width + x) * 4;
    return data[i] > 200 && data[i + 1] < 50 && data[i + 2] < 50;
  })()`,
    8000,
    "alternate-screen Kitty source did not render",
  );
  await writeControl("\x1b[?1049l", "PRIMARY-READY");
  await waitBrowser(
    page,
    `(${region}).then(p => p.green > 4)`,
    8000,
    "returning from alternate screen lost primary image",
  );
  assert.equal((await evaluate(page, "window.bcwebmux.state")).gpuError, null);

  // Quality zero preserves safe uploads but still normalizes oversized sources.
  const gradientWidth = 320;
  const gradientHeight = 240;
  const gradient = Buffer.alloc(gradientWidth * gradientHeight * 4);
  for (let y = 0; y < gradientHeight; y++) {
    for (let x = 0; x < gradientWidth; x++) {
      const i = (y * gradientWidth + x) * 4;
      gradient[i] = 40 + Math.floor((x * 180) / gradientWidth);
      gradient[i + 1] = 200 - Math.floor((y * 150) / gradientHeight);
      gradient[i + 2] = 90;
      gradient[i + 3] = 255;
    }
  }
  const gradientBase64 = gradient.toString("base64");
  let gradientUpload = "\x1b[2;20H";
  for (let offset = 0; offset < gradientBase64.length; offset += 4096) {
    const more = offset + 4096 < gradientBase64.length ? 1 : 0;
    const keys =
      offset === 0
        ? `a=T,q=2,f=32,s=${gradientWidth},v=${gradientHeight},i=47,c=10,r=5,m=${more}`
        : `m=${more}`;
    gradientUpload += `\x1b_G${keys};${gradientBase64.slice(offset, offset + 4096)}\x1b\\`;
  }
  const gradientFile = path.join(profile, "gradient.kitty");
  await writeFile(gradientFile, gradientUpload);
  const sessionMetadata = async () => {
    const response = await fetch(`${base}/api/sessions/${initial.id}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const outputOffset = async () => (await sessionMetadata()).outputOffset;
  const offsetBefore = await outputOffset();
  await evaluate(
    page,
    `window.bcwebmux.write(${JSON.stringify(`cat ${JSON.stringify(gradientFile)}; printf 'WEBP-READY\\n'\n`)})`,
  );
  await waitBrowser(
    page,
    "window.bcwebmux.sessionText().includes('WEBP-READY')",
    8000,
    "WebP upload marker missing",
  );
  const journaled = (await outputOffset()) - offsetBefore;
  assert.ok(
    journaled > 0 &&
      journaled <
        (Number(quality) === 0 ? gradientUpload.length + 4096 : gradientUpload.length / 8),
    `server journaled ${journaled} bytes for a ${gradientUpload.length}-byte upload`,
  );
  await waitBrowser(
    page,
    `(async () => {
    const { data, width } = await window.bcwebmux.readPixels();
    const state = window.bcwebmux.state;
    const x = Math.floor(state.physicalCellWidth * 24), y = Math.floor(state.physicalCellHeight * 3.5);
    const i = (y * width + x) * 4;
    return Math.abs(data[i] - 130) < 24 && Math.abs(data[i + 1] - 125) < 24 && Math.abs(data[i + 2] - 90) < 24;
  })()`,
    8000,
    "gradient Kitty image did not render",
  );

  const liveMetadata = await sessionMetadata();
  assert.equal(liveMetadata.state, "running");
  assert.ok(liveMetadata.controller);
  const assertLiveSession = async () => {
    const metadata = await sessionMetadata();
    assert.equal(metadata.id, initial.id);
    assert.equal(metadata.generation, liveMetadata.generation);
    assert.equal(metadata.state, "running");
    assert.equal(metadata.exitStatus, null);
    assert.deepEqual(metadata.controller, liveMetadata.controller);
    const state = await evaluate(page, "window.bcwebmux.state");
    assert.equal(state.activeSessionId, initial.id);
    assert.equal(state.sessionState, "running");
    assert.equal(state.controller, true);
    assert.equal(state.connected, true);
    assert.equal(state.gpuError, null);
  };

  if (spawnSync("viu", ["--version"], { stdio: "ignore" }).status === 0) {
    for (const { width, height, rows } of [
      { width: 2630, height: 546, rows: 3 },
      { width: 3840, height: 2160, rows: 6 },
    ]) {
      const fixture = path.join(profile, `viu-${width}x${height}.ppm`);
      const pixels = Buffer.alloc(width * height * 3);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const color =
            y < height * 0.4
              ? x < width / 3
                ? [203, 19, 209]
                : [19, 203, 47]
              : x < width / 3
                ? [17, 73, 219]
                : [229, 153, 23];
          const inset =
            x > width * 0.55 && x < width * 0.7 && y > height * 0.6 && y < height * 0.85;
          const offset = (y * width + x) * 3;
          for (let channel = 0; channel < 3; channel++)
            pixels[offset + channel] = inset ? 245 : color[channel];
        }
      }
      await writeFile(
        fixture,
        Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]),
      );
      const before = await outputOffset();
      const marker = `VIU-${width}x${height}-READY PID=${pid}`;
      await evaluate(
        page,
        `window.bcwebmux.write(${JSON.stringify(`viu -a -x 0 -y 22 -w 20 -h ${rows} ${JSON.stringify(fixture)} && printf 'VIU-%s PID=%s\\n' '${width}x${height}-READY' "$$"\n`)})`,
      );
      await waitBrowser(
        page,
        `window.bcwebmux.sessionText().includes(${JSON.stringify(marker)})`,
        60000,
        `${width}x${height} viu upload lost the following shell output`,
      );
      const bytes = (await outputOffset()) - before;
      assert.ok(
        bytes > 0 && bytes < 1024 * 1024,
        `${width}x${height} viu upload journaled ${bytes} bytes`,
      );
      await assertLiveSession();
      assert.ok(
        !(await evaluate(page, "window.bcwebmux.sessionText()")).includes("▄"),
        "viu fell back to block characters instead of Kitty images",
      );
      const samples = [
        [0.15, 0.2, [203, 19, 209]],
        [0.8, 0.2, [19, 203, 47]],
        [0.15, 0.8, [17, 73, 219]],
        [0.9, 0.8, [229, 153, 23]],
        [0.625, 0.72, [245, 245, 245]],
      ];
      await waitBrowser(
        page,
        `(async () => {
          const { data, width, height } = await window.bcwebmux.readPixels();
          const cell = window.bcwebmux.state;
          return ${JSON.stringify(samples)}.every(([u, v, expected]) => {
            const x = Math.floor(cell.physicalCellWidth * 20 * u);
            const y = Math.floor(cell.physicalCellHeight * (22 + ${rows} * v));
            const i = (y * width + x) * 4;
            return x < width && y < height && expected.every((value, channel) => Math.abs(data[i + channel] - value) < 35);
          });
        })()`,
        12000,
        `${width}x${height} viu image lost, cropped, or transposed colored regions`,
      );
    }
  }

  const producer = path.join(profile, "graphics-recovery.py");
  await writeFile(
    producer,
    String.raw`import base64, os, select, termios, time, tty

def emit(data):
    while data:
        count = os.write(1, data[:4096])
        data = data[count:]

def apc(control, data=b""):
    emit(b"\x1b_G" + control + b";" + data + b"\x1b\\")

apc(b"a=T,q=2,f=32,s=4294967295,v=4294967295,i=60,m=1", b"AAAA")
apc(b"m=0", b"AAAA")
emit(b"\x1b_Ga=T,q=2,f=32,s=1,v=1,i=61,m=1;")
for _ in range(20 * 1024 * 1024 // 4096):
    emit(b"A" * 4096)
emit(b"\x1b\\")
apc(b"m=0", b"AAAA")
emit(b"\x1b[7;40HFALLBACK-TEXT\r\n")
emit(b"\x1b[8;40H")
apc(b"a=T,q=2,f=32,s=1,v=1,i=62,c=6,r=4,C=1,z=1", base64.b64encode(bytes([21, 207, 83, 255])))
fd = os.open("/dev/tty", os.O_RDWR)
saved = termios.tcgetattr(fd)
try:
    tty.setraw(fd)
    apc(b"a=q,f=24,s=1,v=1,i=63", b"AAAA")
    reply = b""
    deadline = time.monotonic() + 8
    while b"\x1b_Gi=63;OK\x1b\\" not in reply:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
            raise RuntimeError("valid Kitty query did not recover: " + repr(reply))
        reply += os.read(fd, 4096)
        if len(reply) > 16384:
            raise RuntimeError("unbounded Kitty replies")
finally:
    termios.tcsetattr(fd, termios.TCSANOW, saved)
    os.close(fd)
emit(b"\x1b[13;40HFALLBACK-QUERY-OK\r\n")
`,
  );
  const beforeRecovery = await outputOffset();
  await evaluate(
    page,
    `window.bcwebmux.write(${JSON.stringify(`python3 ${JSON.stringify(producer)} && printf 'FALLBACK-%s PID=%s\\n' 'SHELL-READY' "$$"\n`)})`,
  );
  await waitBrowser(
    page,
    `window.bcwebmux.sessionText().includes(${JSON.stringify(`FALLBACK-SHELL-READY PID=${pid}`)})`,
    30000,
    "rejected graphics upload lost the query response or following shell output",
  );
  const recoveryText = await evaluate(page, "window.bcwebmux.sessionText()");
  assert.ok(recoveryText.includes("FALLBACK-TEXT"), "rejected APC swallowed ordinary output");
  assert.ok(recoveryText.includes("FALLBACK-QUERY-OK"), "valid Kitty query did not recover");
  const recoveryBytes = (await outputOffset()) - beforeRecovery;
  assert.ok(
    recoveryBytes > 0 && recoveryBytes < 64 * 1024,
    `rejected APC journaled ${recoveryBytes} bytes`,
  );
  await assertLiveSession();
  await waitBrowser(
    page,
    `(async () => {
      const { data, width } = await window.bcwebmux.readPixels();
      const cell = window.bcwebmux.state;
      const x = Math.floor(cell.physicalCellWidth * 41.5), y = Math.floor(cell.physicalCellHeight * 8.5);
      const i = (y * width + x) * 4;
      return Math.abs(data[i] - 21) < 25 && Math.abs(data[i + 1] - 207) < 25 && Math.abs(data[i + 2] - 83) < 25;
    })()`,
    8000,
    "valid Kitty image did not render after rejected uploads",
  );

  const terminate = await fetch(`${base}/api/sessions/${initial.id}/terminate`, {
    method: "POST",
    headers: { Origin: base, "Idempotency-Key": "browser-checkpoint-terminate" },
  });
  assert.equal(terminate.status, 202);
  await waitFor(
    async () =>
      (await (await fetch(`${base}/api/sessions/${initial.id}`)).json()).state === "exited",
    5000,
    "session did not exit",
  );

  await page.call("Page.reload", { ignoreCache: true });
  await waitBrowser(
    page,
    "window.bcwebmux?.connected === true",
    10000,
    "checkpoint attachment did not become live",
  );
  const restored = await evaluate(
    page,
    `({ id: window.bcwebmux.activeSessionId, text: window.bcwebmux.sessionText(), cores: window.bcwebmux.coreCount, state: window.bcwebmux.state })`,
  );
  assert.equal(restored.id, initial.id);
  assert.equal(restored.cores, 1);
  assert.match(restored.text, /BEFORE-RELOAD/);
  assert.match(restored.text, /WHILE-DETACHED/);
  assert.equal(restored.state.sessionState, "exited");
  assert.equal(restored.state.replyBytes, 0);
  const oldInstance = (await (await fetch(`${base}/api/server`)).json()).serverInstance;
  await terminateProcess(server);
  server = spawn(
    serverPath,
    [
      "--config",
      "/dev/null",
      "--auth=false",
      "--shell",
      shell,
      "--tls-cert",
      tls.cert,
      "--tls-key",
      tls.key,
      "--web-root",
      webRoot,
      "--listen",
      `127.0.0.1:${serverPort}`,
      "--origin",
      base,
      ...qualityArgs,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: profile, GODEBUG: "http2server=0" },
    },
  );
  server.stdout.on("data", (data) => {
    serverLog += data;
  });
  server.stderr.on("data", (data) => {
    serverLog += data;
  });
  await waitFor(
    async () => {
      const response = await fetch(`${base}/api/server`).catch(() => null);
      return response?.ok && (await response.json()).serverInstance !== oldInstance;
    },
    10000,
    "replacement server failed to start",
  );
  await waitBrowser(
    page,
    `window.bcwebmux.connected && window.bcwebmux.activeSessionId !== ${JSON.stringify(initial.id)} &&
    window.bcwebmux.sessions.every(session => session.id !== ${JSON.stringify(initial.id)})`,
    20000,
    "browser retained vanished session after server restart",
  );
  const replacement = await evaluate(page, "window.bcwebmux.activeSessionId");
  assert.ok(await (await fetch(`${base}/api/sessions/${replacement}`)).ok);
  await evaluate(page, "window.bcwebmux.refreshSessions()");
  assert.ok(
    !(await evaluate(page, "window.bcwebmux.sessions")).some(
      (session) => session.id === initial.id,
    ),
  );
  const exceptions = page.events.filter((event) => event.method === "Runtime.exceptionThrown");
  assert.deepEqual(exceptions, [], JSON.stringify(exceptions));
} catch (error) {
  error.message += `\nServer log:\n${serverLog}`;
  if (page)
    error.message += `\nBrowser state: ${JSON.stringify(await evaluate(page, "({ href: location.href, ready: document.readyState, state: window.bcwebmux?.state, message: document.querySelector('#client-error-message')?.textContent })").catch((e) => e.message))}`;
  if (page)
    error.message += `\nBrowser console: ${JSON.stringify(
      page.events
        .filter((e) => e.method === "Runtime.consoleAPICalled")
        .map((e) => e.params.args.map((x) => x.value || x.description))
        .slice(-8),
    )}`;
  if (page)
    error.message += `\nBrowser exceptions: ${JSON.stringify(page.events.filter((e) => e.method === "Runtime.exceptionThrown"))}`;
  throw error;
} finally {
  page?.close();
  browser?.close();
  await terminateProcess(chromium);
  await terminateProcess(server);
  await tls.dispose();
  await rm(profile, { recursive: true, force: true });
}

async function evaluate(cdp, expression) {
  const response = await cdp.call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails)
    throw new Error(
      response.exceptionDetails.exception?.description || "browser evaluation failed",
    );
  return response.result.value;
}

async function waitBrowser(cdp, expression, timeout, message) {
  return waitFor(
    async () => Boolean(await evaluate(cdp, expression).catch(() => false)),
    timeout,
    message,
  );
}
