// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Cdp, freePort, terminateProcess, waitFor } from "./test-support.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const profile = await mkdtemp(path.join(tmpdir(), "bcwebmux-font-sizing-"));
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><title>Font sizing integration</title>");
      return;
    }
    const file = path.resolve(root, `.${pathname}`);
    if (!file.startsWith(root)) throw new Error("invalid fixture path");
    response.setHeader(
      "Content-Type",
      pathname.endsWith(".js") ? "text/javascript" : "application/octet-stream",
    );
    response.end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
});
let browser;
let cdp;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const debugPort = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  browser = spawn(
    process.env.CHROMIUM || "chromium",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      url,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let log = "";
  browser.stderr.on("data", (chunk) => {
    log = (log + chunk).slice(-8192);
  });
  const target = await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`).catch(() => null);
      return (
        response?.ok &&
        (await response.json()).find((page) => page.type === "page" && page.url === url)
      );
    },
    15000,
    () => `Chromium startup failed: ${log}`,
  );
  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await waitFor(
    async () => {
      const state = await cdp.call("Runtime.evaluate", {
        expression: "location.href + ' ' + document.readyState",
        returnByValue: true,
      });
      return state.result.value === `${url} complete`;
    },
    10000,
    () => "Font sizing fixture did not load",
  );
  const result = await cdp.call(
    "Runtime.evaluate",
    {
      expression:
        "import('/app-bcwebmux/test/font-sizing-browser.js').then(module => module.run())",
      awaitPromise: true,
      returnByValue: true,
    },
    30000,
  );
  assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
  assert.equal(result.result.value.ok, true);
  console.log(JSON.stringify(result.result.value));
} finally {
  await cdp?.close();
  await terminateProcess(browser);
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
