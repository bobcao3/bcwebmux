// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const web = fileURLToPath(new URL("../web/", import.meta.url));

test("install manifest references real icons and a root start URL", async () => {
  const html = await readFile(path.join(web, "index.html"), "utf8");
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  const manifest = JSON.parse(await readFile(path.join(web, "manifest.webmanifest"), "utf8"));
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  for (const size of [192, 512]) {
    const icon = manifest.icons.find(icon => icon.sizes === `${size}x${size}`);
    assert.ok(icon);
    const png = await readFile(path.join(web, icon.src.replace(/^\//, "")));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
});

test("service worker installs a network-only navigation handler", async () => {
  const client = await readFile(path.join(web, "client.js"), "utf8");
  assert.match(client, /serviceWorker\.register\("\/sw\.js"\)/);
  const listeners = new Map();
  const requests = [];
  const context = {
    self: { addEventListener: (name, handler) => listeners.set(name, handler) },
    fetch: request => { requests.push(request); return Promise.resolve({ ok: true }); },
  };
  vm.runInNewContext(await readFile(path.join(web, "sw.js"), "utf8"), context);
  const handler = listeners.get("fetch");
  assert.equal(typeof handler, "function");
  const request = { mode: "navigate" };
  let response;
  handler({ request, respondWith: promise => { response = promise; } });
  assert.equal((await response).ok, true);
  assert.deepEqual(requests, [request]);
  response = undefined;
  handler({ request: { mode: "cors" }, respondWith: promise => { response = promise; } });
  assert.equal(response, undefined);
});
