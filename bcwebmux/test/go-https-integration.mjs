// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

// Exercises the installed Go/cgo server, not an httptest substitute.
// Usage: node test/go-https-integration.mjs zig-out/bin/bcwebmux-server
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http2 from "node:http2";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import tls from "node:tls";
import { delay, freePort } from "./test-support.mjs";

const executable = process.argv[2];
assert.ok(executable, "usage: node test/go-https-integration.mjs SERVER");
const directory = await mkdtemp(join(tmpdir(), "bcwebmux-https-"));
let server;
let client;
let socket;
let exited;
let logs = "";
try {
  const cert = join(directory, "cert.pem");
  const key = join(directory, "key.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
    "-keyout", key, "-out", cert,
  ], { stdio: "ignore" });
  const port = await freePort();
  const origin = `https://127.0.0.1:${port}`;
  server = spawn(resolve(executable), [
    "--host", "127.0.0.1", "--port", String(port), "--origin", origin,
    "--tls-cert", cert, "--tls-key", key,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", chunk => { logs += chunk; });
  server.stderr.on("data", chunk => { logs += chunk; });
  exited = new Promise((resolveExit, reject) => {
    server.once("error", reject);
    server.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  await waitUntilListening(port);

  client = http2.connect(origin, { rejectUnauthorized: false });
  client.on("error", () => {});
  await new Promise((resolveConnect, reject) => {
    client.once("connect", resolveConnect);
    client.once("error", reject);
  });
  assert.equal(client.alpnProtocol, "h2", "TLS must negotiate HTTP/2");
  const info = await request("GET", "/api/server");
  assert.equal(info.headers[":status"], 200);
  assert.equal(JSON.parse(info.body).protocol, "bcw.sessions");
  assert.equal(info.headers["x-content-type-options"], "nosniff");
  const asset = await request("GET", "/");
  assert.equal(asset.headers[":status"], 200);
  assert.match(asset.headers["content-type"], /text\/html/);
  assert.ok(asset.body.includes("<html"), "embedded application must be served");
  const rejected = await request("POST", "/api/sessions", {
    origin: "https://untrusted.invalid", "content-type": "application/json",
    "idempotency-key": "https-rejected",
  }, JSON.stringify({ profile: "shell" }));
  assert.equal(rejected.headers[":status"], 403);
  const created = await request("POST", "/api/sessions", {
    origin, "content-type": "application/json", "idempotency-key": "https-create",
  }, JSON.stringify({ profile: "shell", name: "HTTPS integration" }));
  assert.equal(created.headers[":status"], 201, created.body);
  const session = JSON.parse(created.body);
  assert.equal(session.state, "running");

  // HTTP/1.1 WSS remains supported alongside h2 on the same TLS listener.
  socket = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] });
  const upgrade = new Promise((resolveUpgrade, reject) => {
    let bytes = "";
    socket.on("data", chunk => {
      bytes += chunk.toString("latin1");
      if (bytes.includes("\r\n\r\n")) resolveUpgrade(bytes);
    });
    socket.once("error", reject);
    socket.once("end", () => reject(new Error("WSS closed before upgrade")));
    socket.setTimeout(5000, () => socket.destroy(new Error("WSS handshake timed out")));
  });
  await new Promise((resolveConnect, reject) => {
    socket.once("secureConnect", resolveConnect);
    socket.once("error", reject);
  });
  socket.write([
    "GET /ws HTTP/1.1", `Host: 127.0.0.1:${port}`, `Origin: ${origin}`,
    "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13",
    `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
    "Sec-WebSocket-Protocol: bcw.sessions", "", "",
  ].join("\r\n"));
  assert.match(await upgrade, /^HTTP\/1\.1 101 /);
  socket.setTimeout(0);

  const terminated = await request("POST", `/api/sessions/${session.id}/terminate`, {
    origin, "idempotency-key": "https-terminate",
  });
  assert.equal(terminated.headers[":status"], 202, terminated.body);
  client.close();
  server.kill("SIGTERM");
  const result = await Promise.race([
    exited,
    delay(7000, undefined, { ref: false }).then(() => { throw new Error(`shutdown timed out with an open WSS connection\n${logs}`); }),
  ]);
  assert.equal(result.code, 0, `unclean shutdown ${JSON.stringify(result)}\n${logs}`);
  console.log("Go HTTPS integration passed: TLS, HTTP/2, embedded assets, origin checks, cgo session lifecycle, WSS, shutdown");

  function request(method, path, headers = {}, body = "") {
    return new Promise((resolveResponse, reject) => {
      const stream = client.request({ ":method": method, ":path": path, ...headers });
      let responseHeaders;
      let responseBody = "";
      stream.setEncoding("utf8");
      stream.setTimeout(5000, () => stream.destroy(new Error("HTTP/2 request timed out")));
      stream.on("response", value => { responseHeaders = value; });
      stream.on("data", chunk => { responseBody += chunk; });
      stream.once("error", reject);
      stream.once("end", () => resolveResponse({ headers: responseHeaders, body: responseBody }));
      stream.end(body || undefined);
    });
  }
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  socket?.destroy();
  client?.destroy();
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill("SIGKILL");
    await exited;
  }
  await rm(directory, { recursive: true, force: true });
}

async function waitUntilListening(port) {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error(`server exited\n${logs}`);
    const ready = await new Promise(resolveReady => {
      const probe = net.connect({ host: "127.0.0.1", port });
      probe.once("connect", () => { probe.destroy(); resolveReady(true); });
      probe.once("error", () => resolveReady(false));
    });
    if (ready) return;
    await delay(25);
  }
  throw new Error(`server did not listen\n${logs}`);
}
