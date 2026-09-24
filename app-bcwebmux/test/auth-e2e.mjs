// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

// End-to-end test for the browser-managed factor set. `bcwebmux-server auth
// totp` enrolls the authenticator app over the terminal — the only step that
// needs the host — and a real Chromium then does the rest: sign in with a code,
// enroll two security keys from Settings → SECURITY (one per virtual
// authenticator, standing in for two devices), sign in with a key, and remove
// one. The authentication pages and the security panel are captured as
// full-viewport and dialog screenshots and compared against the goldens in
// test/golden (UPDATE_GOLDEN=1 rewrites them).
//
// Usage: node test/auth-e2e.mjs ./zig-out/bin/bcwebmux-server ./zig-out/web

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
  console.error("usage: node test/auth-e2e.mjs ./zig-out/bin/bcwebmux-server ./zig-out/web");
  process.exit(2);
}

// The authentication surfaces are plain DOM, so one desktop viewport covers
// them and no GPU backend is involved.
const viewport = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
const testDir = path.dirname(fileURLToPath(import.meta.url));
const goldenDir = path.join(testDir, "golden");
const outputDir = path.resolve(process.env.BCWEBMUX_SCREENSHOT_DIR || path.join(testDir, "..", "zig-out", "screenshots"));

const directory = await mkdtemp(path.join(os.tmpdir(), "bcwebmux-auth-e2e-"));
const profile = path.join(directory, "profile");
const authFile = path.join(directory, "auth.json");
const port = await freePort();
const debugPort = await freePort();
const origin = `http://localhost:${port}`;
const listen = ["--listen", "127.0.0.1", "--listen", "::1"];
const account = "bob@bcwebmux";
let enrolling;
let serving;
let chromium;
let page;
let browser;
let log = "";

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
  return waitFor(() => evaluate(expression), timeout, () => `${message}\n${log}`);
}

// capture writes one screenshot into the shared output directory and compares
// it with its golden. A clip restricts the image to one element, which is how
// the security dialog is captured without dragging the terminal behind its
// backdrop into the comparison.
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

// addAuthenticator installs a software FIDO2 key with automatic presence and
// user verification, standing in for one device's platform authenticator.
async function addAuthenticator() {
  const { authenticatorId } = await page.call("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "usb",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  assert.ok(authenticatorId, "virtual authenticator was not created");
  await page.call("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: true });
  await page.call("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId, enabled: true });
  return authenticatorId;
}

// signInWithCode types a current code into the login page's only form.
async function signInWithCode(secret) {
  await until(`globalThis.bcwebmuxAuth?.state.ready === true`, "login page did not finish initializing");
  await evaluate(`document.querySelector("#auth-code").value = ${JSON.stringify(totp(secret))}; document.querySelector("#auth-code-form").requestSubmit()`, true);
  await until(`location.pathname === "/"`, "the code did not sign in", 30000);
}

// addKeyFromPanel enrolls one key through Settings → SECURITY. A panel that is
// not armed asks for a factor first; `code` answers the code path, and null
// means an armed step-up already covers this change.
async function addKeyFromPanel(label, code = null) {
  await evaluate(`document.querySelector("#auth-key-name").value = ${JSON.stringify(label)}`);
  await evaluate(`document.querySelector("#auth-add-key").click()`, true);
  if (code !== null) {
    await until(`!document.querySelector("#auth-stepup-row").hidden`, "the panel did not ask for a code");
    await evaluate(`document.querySelector("#auth-stepup-code").value = ${JSON.stringify(code)}; document.querySelector("#auth-stepup-form").requestSubmit()`, true);
  }
  await until(`document.querySelector("#auth-credential-list").textContent.includes(${JSON.stringify(label)})`, `enrolling "${label}" did not complete`, 30000);
  await until(`!document.querySelector("#auth-add-key").disabled`, "key management did not become idle again");
}

try {
  // 1. The host enrolls the authenticator app — and nothing else.
  const secret = await enrolTOTP();
  const state = JSON.parse(await readFile(authFile, "utf8"));
  assert.ok(state.totp?.secret, "the state file must hold the authenticator secret");
  assert.equal((state.credentials ?? []).length, 0, "no security key can be enrolled from the host");

  // 2. A real browser with virtual security keys.
  chromium = spawn(process.env.CHROMIUM || "chromium", [
    "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
    // The terminal renderer needs a GPU; the authentication flow itself does not.
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
  await page.call("WebAuthn.enable");
  await page.call("Emulation.setDeviceMetricsOverride", viewport);
  // The app only prompts for notification permission while it is undecided;
  // granting it here keeps that modal out of the settings captures.
  await browser.call("Browser.grantPermissions", { origin, permissions: ["notifications"] });

  // 3. The application server on the same state file.
  serving = spawn(serverPath, [
    "--config", "/dev/null", "--auth-file", authFile, ...listen,
    "--port", String(port), "--origin", origin,
    "--web-root", webRoot, "--shell", "/bin/sh",
  ], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  serving.detachedGroup = true;
  captureLogs(serving, "server");
  await waitFor(async () => {
    const response = await fetch(`${origin}/auth/session`).catch(() => null);
    return response?.ok;
  }, 15000, () => `application server did not start\n${log}`);

  // An enrolled factor closes the application, key or no key.
  const status = await (await fetch(`${origin}/auth/session`)).json();
  assert.equal(status.required, true, "an enrolled factor must make authentication required");
  assert.equal(status.totp, true, "the authenticator app must be reported as enrolled");
  assert.equal(status.enrolled, 0, "no security key is enrolled yet");
  const guarded = await fetch(`${origin}/`, { redirect: "manual" });
  assert.equal(guarded.status, 302, "unauthenticated page must redirect");
  assert.equal(guarded.headers.get("location"), "/login");
  const api = await fetch(`${origin}/api/server`, { redirect: "manual" });
  assert.equal(api.status, 401, "unauthenticated API must be refused");
  const ws = await fetch(`${origin}/ws`, { redirect: "manual" });
  assert.equal(ws.status, 401, "unauthenticated websocket must be refused");

  // 4. The browser lands on the code form and signs in with a code.
  await page.call("Page.navigate", { url: `${origin}/` });
  await until(`location.pathname === "/login" && !!document.querySelector("#auth-code-form")`, "unauthenticated navigation must land on the login page");
  await until(`globalThis.bcwebmuxAuth?.state.ready === true`, "login page did not finish initializing");
  await until(`document.querySelector("#auth-subtitle").textContent === "Sign in to continue" && !document.querySelector("#auth-code-form label") && !/relying party/i.test(document.querySelector("#auth-card").textContent)`, "the login page must not name the relying party or repeat the code label");
  await capture("login");
  await signInWithCode(secret);
  const authenticated = await evaluate(`(async () => {
    const info = await fetch("/api/server").then(response => ({ status: response.status, body: response.text() }));
    return { status: info.status, body: await info.body };
  })()`);
  assert.equal(authenticated.status, 200, "authenticated API must answer");
  assert.match(authenticated.body, /bcw\.sessions/, "authenticated API must reach the session engine");
  // The application module graph executes only on a served application page.
  await until(`typeof window.bcwebmux === "object"`, "application modules did not load once signed in", 30000);
  const socket = await evaluate(`new Promise((resolve) => {
    const socket = new WebSocket("ws://" + location.host + "/ws", "bcw.sessions");
    const done = value => { try { socket.close(); } catch {} resolve(value); };
    socket.onopen = () => done("open");
    socket.onerror = () => done("error");
  })`);
  assert.equal(socket, "open", "authenticated websocket upgrade must succeed");

  // 5. Settings → SECURITY is where keys come from. The code-issued session
  // has no key of its own, so the panel asks for a code instead — the step
  // after the one the sign-in consumed.
  await evaluate(`document.querySelector("#settings-button").click()`);
  await until(`document.querySelector("#settings-dialog").open`, "settings dialog did not open");
  await evaluate(`document.querySelector("#settings-tab-auth").click()`);
  await until(`/authenticator app/.test(document.querySelector("#auth-summary").textContent)`, "settings panel did not list the authenticator app");
  assert.equal(await evaluate(`document.querySelectorAll("#auth-credential-list .auth-credential").length`), 1, "the panel must show the authenticator app and no keys");

  // One virtual authenticator carries both keys. Chrome's virtual environment
  // races two eligible devices for a single assertion and fails the request
  // when one of them aborts, which would make the sign-in below flaky; the
  // server cannot tell the devices apart anyway, and what the panel has to get
  // right is the per-device naming below.
  const device = await addAuthenticator();

  // A wrong code is reported in the panel: it must not be mistaken for an
  // expired session and throw the operator back to the login page.
  await evaluate(`document.querySelector("#auth-key-name").value = "macbook · touch id"`);
  await evaluate(`document.querySelector("#auth-add-key").click()`, true);
  await until(`!document.querySelector("#auth-stepup-row").hidden`, "the panel did not ask for a code");
  await evaluate(`document.querySelector("#auth-stepup-code").value = "000000"; document.querySelector("#auth-stepup-form").requestSubmit()`, true);
  await until(`/not valid/.test(document.querySelector("#auth-status").textContent)`, "a wrong code was not reported", 10000);
  assert.equal(await evaluate(`location.pathname`), "/", "a wrong code must not end the session");
  await until(`!document.querySelector("#auth-add-key").disabled`, "the panel did not become idle again after a wrong code");

  // The code for the step after the one the sign-in consumed is the right one.
  const firstStepUpCounter = Math.floor((Date.now() / 1000 + 30) / 30);
  await addKeyFromPanel("macbook · touch id", totp(secret, firstStepUpCounter * 30));
  assert.equal(await evaluate(`document.querySelector("#auth-key-name").value`), "", "the label field must be cleared after enrolling");

  // A second device's key. The step-up armed moments ago still covers it, so
  // this one needs no code.
  await addKeyFromPanel("pixel · fingerprint");
  await until(`document.querySelectorAll("#auth-credential-list .auth-credential").length === 3`, "adding a second key did not update the list", 30000);
  assert.match(await evaluate(`document.querySelector("#auth-summary").textContent`), /the authenticator app and 2 security keys/, "the summary must count both keys");
  const withTwo = JSON.parse(await readFile(authFile, "utf8"));
  assert.equal(withTwo.credentials.length, 2, "state file must hold both credentials");
  assert.deepEqual(withTwo.credentials.map(credential => credential.name).sort(), ["macbook · touch id", "pixel · fingerprint"]);
  assert.ok(withTwo.credentials.every(credential => credential.rpId === "localhost"), "both keys must be scoped to the origin host");

  // The panel labels carry enrollment and use timestamps, which differ per run;
  // keep the labels and the layout, fix only the volatile values.
  await evaluate(`(() => {
    for (const detail of document.querySelectorAll(".auth-credential-copy small")) {
      detail.textContent = detail.textContent
        .replace(/enrolled [^·]+/, "enrolled 2026-01-01, 00:00:00")
        .replace(/created [^·]+/, "created 2026-01-01, 00:00:00")
        .replace(/last used [^·]+/, "last used 2026-01-01, 00:00:00");
    }
    return true;
  })()`);
  const dialog = await evaluate(`(() => {
    const box = document.querySelector("#settings-dialog").getBoundingClientRect();
    return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
  })()`);
  await capture("security", dialog);

  // 7. Sign out, then back in with a security key. Both keys are still
  // enrolled, so the assertion matches whichever credential the device holds.
  await evaluate(`document.querySelector("#auth-sign-out").click()`, true);
  await until(`location.pathname === "/login"`, "sign out did not return to the login page");
  const afterLogout = await evaluate(`fetch("/api/server", { redirect: "manual" }).then(response => response.status)`);
  assert.equal(afterLogout, 401, "the signed-out browser must be refused again");
  await until(`globalThis.bcwebmuxAuth?.state.ready === true`, "login page did not finish initializing after signing out");
  await until(`!document.querySelector("#auth-action").hidden`, "the key button must be offered once a key is enrolled");
  await evaluate(`document.querySelector("#auth-action").click()`, true);
  await until(`location.pathname === "/"`, "the security key did not sign in", 30000);
  await until(`typeof window.bcwebmux === "object"`, "application modules did not load after the key sign-in", 30000);
  assert.ok(device, "the virtual device served the sign-in");

  // 8. Losing a device must not need the host either: one key is dropped from
  // here, and the state file keeps the other. Removing the key that issued this
  // session ends the session, which is how the panel answers an expired one.
  await evaluate(`document.querySelector("#settings-button").click()`);
  await until(`document.querySelector("#settings-dialog").open`, "settings dialog did not open");
  await evaluate(`document.querySelector("#settings-tab-auth").click()`);
  await until(`document.querySelectorAll("#auth-credential-list .auth-credential").length === 3`, "the panel did not list both keys");
  // A key on the laptop must not be required to enroll another device. After
  // signing in with a key, a fresh code still arms enrollment when keys exist.
  await waitFor(() => Math.floor(Date.now() / 30000) > firstStepUpCounter, 65000, "no unused TOTP step became available");
  await addKeyFromPanel("phone · passkey", totp(secret, Math.floor(Date.now() / 1000)));
  assert.equal((JSON.parse(await readFile(authFile, "utf8"))).credentials.length, 3,
    "a code must allow enrollment even with existing keys");
  const clickRemoval = name => evaluate(`(() => {
    const rows = [...document.querySelectorAll("#auth-credential-list .auth-credential")];
    rows.find(row => row.textContent.includes(${JSON.stringify(name)}))
      .querySelector(".auth-credential-remove").click();
  })()`, true);
  await clickRemoval("phone · passkey");
  await clickRemoval("phone · passkey");
  await until(`document.querySelectorAll("#auth-credential-list .auth-credential").length === 3`, "new key was not removed");
  await clickRemoval("pixel · fingerprint");
  await until(`/Click CONFIRM/.test(document.querySelector("#auth-status").textContent)`, "removal was not armed");
  await clickRemoval("pixel · fingerprint");
  await until(`location.pathname === "/login" || document.querySelectorAll("#auth-credential-list .auth-credential").length === 2`, "removing a key did not update the list or end its session", 30000);
  const afterRemoval = JSON.parse(await readFile(authFile, "utf8"));
  assert.deepEqual(afterRemoval.credentials.map(credential => credential.name), ["macbook · touch id"], "the state file must drop only the removed key");
  assert.ok(afterRemoval.sessionSecret, "the authenticator app keeps the state file signed");

  console.log("auth-e2e: CLI authenticator enrollment, code sign-in, per-device key enrollment from the panel, key sign-in, and removal verified");
} catch (error) {
  console.error(error.message);
  if (page) {
    try {
      console.error(`[page] ${await evaluate(`JSON.stringify({
        path: location.pathname,
        status: document.querySelector("#auth-status")?.textContent ?? null,
        summary: document.querySelector("#auth-summary")?.textContent ?? null,
        stepUp: document.querySelector("#auth-stepup-row")?.hidden ?? null,
        codeDisabled: document.querySelector("#auth-code")?.disabled ?? null,
        keys: document.querySelectorAll("#auth-credential-list .auth-credential").length,
      })`)}`);
    } catch (diagnostic) {
      console.error(`[page] diagnostics failed: ${diagnostic.message}`);
    }
  }
  process.exitCode = 1;
} finally {
  await Promise.all([
    terminateProcess(chromium),
    terminateProcess(enrolling),
    terminateProcess(serving),
  ]);
  if (!process.env.BCWEBMUX_KEEP_AUTH_STATE) await rm(directory, { recursive: true, force: true });
  if (process.exitCode) console.error(log.slice(-8192));
}
