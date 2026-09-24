// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

// End-to-end test for the baseline factor: `bcwebmux-server auth totp` enrolls
// an authenticator-app secret over the terminal, and a real Chromium then signs
// in from an IP-literal origin — the address shape where a security key cannot
// work at all. The login page and the security panel are captured against the
// goldens in test/golden (UPDATE_GOLDEN=1 rewrites them).
//
// Usage: node test/auth-totp-e2e.mjs ./zig-out/bin/bcwebmux-server ./zig-out/web

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Cdp, freePort, terminateProcess, waitFor } from "./test-support.mjs";
import { compareScreenshot } from "./visual-compare.mjs";

const [serverPath, webRoot] = process.argv.slice(2);
if (!serverPath || !webRoot) {
  console.error("usage: node test/auth-totp-e2e.mjs ./zig-out/bin/bcwebmux-server ./zig-out/web");
  process.exit(2);
}

const viewport = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
const testDir = path.dirname(fileURLToPath(import.meta.url));
const goldenDir = path.join(testDir, "golden");
const outputDir = path.resolve(process.env.BCWEBMUX_SCREENSHOT_DIR || path.join(testDir, "..", "zig-out", "screenshots"));
const account = "bob@bcwebmux";

const directory = await mkdtemp(path.join(os.tmpdir(), "bcwebmux-totp-"));
const authFile = path.join(directory, "auth.json");
const profile = path.join(directory, "profile");
const port = await freePort();
const debugPort = await freePort();
// 127.0.0.1 stands in for every address in the operator's config that is an IP
// literal: no relying party ID can exist for it, so only TOTP can sign in.
const origin = `http://127.0.0.1:${port}`;
let enrolling;
let serving;
let chromium;
let browser;
let page;
let log = "";
const consoleMessages = [];

function captureLogs(child, prefix) {
  child.stdout?.on("data", chunk => { log += `[${prefix}] ${chunk}`; });
  child.stderr?.on("data", chunk => { log += `[${prefix}] ${chunk}`; });
}

function base32Decode(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const character of secret.replace(/=+$/, "").toUpperCase()) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error(`bad base32 character ${character}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function totp(secret, unix = Math.floor(Date.now() / 1000)) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(unix / 30)));
  const digest = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) | digest[offset + 3];
  return String(value % 1_000_000).padStart(6, "0");
}

async function evaluate(expression, userGesture = false) {
  const response = await page.call("Runtime.evaluate", {
    expression, awaitPromise: true, returnByValue: true, userGesture,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || JSON.stringify(response.exceptionDetails));
  }
  return response.result.value;
}

async function until(expression, message, timeout = 20000) {
  return waitFor(() => evaluate(expression), timeout, `${message}\n${log}`);
}

async function capture(name, clip) {
  await evaluate("(async () => { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); })()");
  let previous;
  const png = await waitFor(async () => {
    const request = { format: "png", fromSurface: true, captureBeyondViewport: false };
    if (clip) request.clip = { ...clip, scale: 1 };
    const { data } = await page.call("Page.captureScreenshot", request);
    if (data === previous) return Buffer.from(data, "base64");
    previous = data;
    return null;
  }, 8000, `${name}: compositor did not settle`);
  const label = `desktop-auth-${name}`;
  await mkdir(outputDir, { recursive: true });
  await compareScreenshot({
    png, name: label, goldenName: label, goldenDir, outputDir,
    width: clip ? clip.width : viewport.width,
    height: clip ? clip.height : viewport.height,
    update: process.env.UPDATE_GOLDEN === "1",
  });
}

// enrolTOTP drives the CLI exactly as an operator would: read the secret from
// what the command prints, then type back the code the app would show.
async function enrolTOTP() {
  enrolling = spawn(serverPath, [
    "auth", "totp", "--config", "/dev/null", "--auth-file", authFile,
    "--account", account, "--no-qr", "--rotate",
  ], { stdio: ["pipe", "pipe", "pipe"] });
  captureLogs(enrolling, "totp");
  const exited = new Promise(resolve => enrolling.once("exit", code => resolve(code)));
  const secret = await waitFor(() => log.match(/secret\s+([A-Z2-7]{16,})/)?.[1], 15000, () => `no secret was printed\n${log}`);
  enrolling.stdin.write(`${totp(secret)}\n`);
  const code = await exited;
  assert.equal(code, 0, `enrollment exited with ${code}\n${log}`);
  return secret;
}

try {
  const secret = await enrolTOTP();
  assert.match(log, new RegExp(`account\\s+${account}`), "the CLI did not report the account label");
  const state = JSON.parse(await readFile(authFile, "utf8"));
  assert.ok(state.totp?.secret, "the state file must hold the authenticator secret");
  assert.ok(state.sessionSecret && state.userHandle, "enrollment must create the session key and user handle");

  serving = spawn(serverPath, [
    "--config", "/dev/null", "--auth-file", authFile,
    "--listen", "127.0.0.1", "--port", String(port), "--origin", origin,
    "--web-root", webRoot, "--shell", "/bin/sh",
  ], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  serving.detachedGroup = true;
  captureLogs(serving, "server");
  await waitFor(async () => (await fetch(`${origin}/auth/session`).catch(() => null))?.ok, 15000, () => `server did not start\n${log}`);

  // 1. The application is closed at an IP literal, and the only way in is the app.
  const status = await (await fetch(`${origin}/auth/session`)).json();
  assert.equal(status.required, true, "an enrolled factor must make authentication required");
  assert.equal(status.totp, true, "the authenticator app must be reported as enrolled");
  assert.equal(status.rpId, null, "an IP literal cannot be a relying party");
  assert.equal((await fetch(`${origin}/`, { redirect: "manual" })).status, 302, "unauthenticated page must redirect");
  assert.equal((await fetch(`${origin}/api/server`, { redirect: "manual" })).status, 401, "unauthenticated API must be refused");
  assert.equal((await fetch(`${origin}/ws`, { redirect: "manual" })).status, 401, "unauthenticated websocket must be refused");

  chromium = spawn(process.env.CHROMIUM || "chromium", [
    "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
    "--enable-unsafe-webgpu", "--use-angle=vulkan", "--ignore-gpu-blocklist", "--enable-features=Vulkan",
    "--disable-background-networking", `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"], detached: true });
  chromium.detachedGroup = true;
  captureLogs(chromium, "chromium");
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`).catch(() => null);
    return response?.ok && (await response.json()).find(candidate => candidate.type === "page");
  }, 15000, () => `Chromium did not expose a page\n${log}`);
  const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
  browser = await Cdp.connect(version.webSocketDebuggerUrl);
  page = await Cdp.connect(target.webSocketDebuggerUrl);
  await page.call("Runtime.enable");
  await page.call("Page.enable");
  await page.call("Emulation.setDeviceMetricsOverride", viewport);
  // The app only prompts for notification permission while it is undecided;
  // granting it here keeps that modal out of the settings captures.
  await browser.call("Browser.grantPermissions", { origin, permissions: ["notifications"] });
  page.on("Runtime.consoleAPICalled", params => {
    consoleMessages.push(`${params.type}: ${params.args.map(argument => argument.value ?? argument.description ?? "").join(" ")}`);
  });
  page.on("Runtime.exceptionThrown", params => {
    consoleMessages.push(`exception: ${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text}`);
  });

  // 2. The browser lands on a code form, not on a dead end.
  await page.call("Page.navigate", { url: `${origin}/` });
  await until(`location.pathname === "/login" && !!document.querySelector("#auth-code-form")`, "unauthenticated navigation must land on the login page");
  // The template ships the form enabled, so readiness must come from the page
  // itself: the module clears the status line and only then flags itself ready.
  await until(`globalThis.bcwebmuxAuth?.state.ready === true`, "the code form did not finish initializing");
  assert.equal(await evaluate(`document.querySelector("#auth-action").hidden`), true, "the security key button must stay hidden at an IP origin");
  assert.equal(await evaluate(`document.querySelector("#auth-status").getBoundingClientRect().height`), 0, "an empty status line must not reserve space above the footer");
  await capture("totp-login");

  // 3. A wrong code is refused in the browser, a right one signs in.
  await evaluate(`document.querySelector("#auth-code").value = "000000"; document.querySelector("#auth-code-form").requestSubmit()`);
  await until(`document.querySelector("#auth-status").dataset.tone === "error"`, "a wrong code must be reported");
  await until(`!document.querySelector("#auth-code").disabled`, "the form must become usable again after a refusal");
  await evaluate(`document.querySelector("#auth-code").value = ${JSON.stringify(totp(secret))}; document.querySelector("#auth-code-form").requestSubmit()`);
  await until(`location.pathname === "/"`, "a valid code must sign in", 30000);

  const authenticated = await evaluate(`(async () => {
    const info = await fetch("/api/server").then(response => ({ status: response.status, body: response.text() }));
    return { status: info.status, body: await info.body };
  })()`);
  assert.equal(authenticated.status, 200, "authenticated API must answer at an IP origin");
  assert.match(authenticated.body, /bcw\.sessions/, "authenticated API must reach the session engine");
  await until(`typeof window.bcwebmux === "object"`, "application modules did not load once signed in", 30000);
  const socket = await evaluate(`new Promise((resolve) => {
    const socket = new WebSocket("ws://" + location.host + "/ws", "bcw.sessions");
    const done = value => { try { socket.close(); } catch {} resolve(value); };
    socket.onopen = () => done("open");
    socket.onerror = () => done("error");
  })`);
  assert.equal(socket, "open", "authenticated websocket upgrade must succeed at an IP origin");

  // 4. The security panel reports the app as an enrolled factor.
  await evaluate(`document.querySelector("#settings-button").click()`);
  await until(`document.querySelector("#settings-dialog").open`, "settings dialog did not open");
  await evaluate(`document.querySelector("#settings-tab-auth").click()`);
  await until(`/authenticator app/.test(document.querySelector("#auth-summary").textContent)`, "the panel did not report the factor");
  await until(`document.querySelector("#auth-credential-list").textContent.includes(${JSON.stringify(account)})`, "the panel did not name the account");
  // Timestamps differ per run; keep the labels and the layout, fix the values.
  await evaluate(`(() => {
    for (const detail of document.querySelectorAll(".auth-credential-copy small")) {
      detail.textContent = detail.textContent
        .replace(/enrolled [^·]+/, "enrolled 2026-01-01, 00:00:00")
        .replace(/last used [^·]+/, "last used 2026-01-01, 00:00:00");
    }
    return true;
  })()`);
  const dialog = await evaluate(`(() => {
    const box = document.querySelector("#settings-dialog").getBoundingClientRect();
    return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
  })()`);
  await capture("totp-security", dialog);

  // 5. Signing out returns the browser to the code form.
  await evaluate(`document.querySelector("#auth-sign-out").click()`, true);
  await until(`location.pathname === "/login"`, "sign out did not return to the login page");
  assert.equal(await evaluate(`fetch("/api/server", { redirect: "manual" }).then(response => response.status)`), 401, "the signed-out browser must be refused again");

  // 6. The authenticator app can be removed from the host, which reopens the app.
  const removed = spawn(serverPath, ["auth", "remove", "--totp", "--config", "/dev/null", "--auth-file", authFile], { stdio: ["ignore", "pipe", "pipe"] });
  captureLogs(removed, "remove");
  assert.equal(await new Promise(resolve => removed.once("exit", resolve)), 0);
  await waitFor(async () => {
    const response = await fetch(`${origin}/api/server`, { redirect: "manual" }).catch(() => null);
    return response?.status === 200;
  }, 10000, () => `removing the factor did not reopen the application\n${log}`);

  console.log("auth-totp-e2e: CLI enrollment, IP-literal sign-in, panel, and reset verified");
} catch (error) {
  console.error(error.message);
  if (page) {
    try {
      console.error(`[page] ${await evaluate(`JSON.stringify({
        path: location.pathname,
        status: document.querySelector("#auth-status")?.textContent ?? null,
        tone: document.querySelector("#auth-status")?.dataset.tone ?? null,
        codeDisabled: document.querySelector("#auth-code")?.disabled ?? null,
        verifyText: document.querySelector("#auth-verify")?.textContent ?? null,
        formHidden: document.querySelector("#auth-code-form")?.hidden ?? null,
        intro: document.querySelector("#auth-intro")?.textContent ?? null,
        console: ${JSON.stringify(consoleMessages.slice(-6))},
      })`)}`);
    } catch (diagnostic) {
      console.error(`[page] diagnostics failed: ${diagnostic.message}`);
    }
  }
  process.exitCode = 1;
} finally {
  await Promise.all([terminateProcess(chromium), terminateProcess(enrolling), terminateProcess(serving)]);
  if (!process.env.BCWEBMUX_KEEP_AUTH_STATE) await rm(directory, { recursive: true, force: true });
  if (process.exitCode) console.error(log.slice(-8192));
}
