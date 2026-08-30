// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";

const serverPath = process.argv[2];
if (!serverPath) throw new Error("usage: node test/session-api-integration.mjs SERVER");

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(serverPath, ["--port", String(port), "--origin", base, "--max-sessions", "2"], {
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
server.stdout.on("data", chunk => { logs += chunk; });
server.stderr.on("data", chunk => { logs += chunk; });

try {
  await waitFor(async () => {
    try {
      return (await fetch(`${base}/api/server`)).ok;
    } catch {
      return false;
    }
  }, 5000, () => `server failed to start\n${logs}`);

  const infoResponse = await fetch(`${base}/api/server`);
  assertSecurity(infoResponse);
  const info = await infoResponse.json();
  assert.equal(info.protocol, "bcw.sessions");
  assert.equal(info.principal, "local");
  assert.equal(info.persistence, "memory");
  assert.equal(info.liveSessionLifetime, "daemon");
  assert.equal(info.checkpointCodec.name, "ghostty-snapshot");
  assert.equal(info.commandProfiles[0].id, "shell");
  assert.equal(info.limits.maxLiveSessions, 2);
  assert.equal(info.limits.scrollbackBytes, 8 * 1024 * 1024);

  const forbidden = await createSession("forbidden", { profile: "shell" }, "http://example.invalid");
  assert.equal(forbidden.status, 403);
  assertSecurity(forbidden);

  const unknown = await createSession("unknown", { profile: "shell", surprise: true });
  assert.equal(unknown.status, 400);
  const invalidGeometry = await createSession("bad-geometry", {
    profile: "shell",
    geometry: { cols: 1, rows: 1 },
  });
  assert.equal(invalidGeometry.status, 422);
  const invalidCellProduct = await createSession("bad-cell-product", {
    profile: "shell",
    geometry: { cols: 500, rows: 200 },
  });
  assert.equal(invalidCellProduct.status, 422);
  const invalidProfile = await createSession("bad-profile", { profile: "arbitrary-command" });
  assert.equal(invalidProfile.status, 422);

  const createBody = {
    profile: "shell",
    geometry: { cols: 90, rows: 30 },
  };
  const createdResponse = await createSession("create-first", createBody);
  assert.equal(createdResponse.status, 201);
  assert.equal(createdResponse.headers.get("cache-control"), "no-store");
  assert.equal(createdResponse.headers.get("idempotency-replayed"), "false");
  const first = await createdResponse.json();
  assert.equal(first.name, "");
  assert.match(first.id, /^[0-9a-f-]{36}$/);
  assert.match(first.generation, /^[0-9a-f-]{36}$/);
  assert.equal(first.state, "running");
  assert.equal(first.geometry.cols, 90);
  assert.equal(createdResponse.headers.get("location"), `/api/sessions/${first.id}`);
  const firstOutput = await waitForSession(first.id, session => session.outputOffset > 0);
  assert.equal(firstOutput.generation, first.generation);

  const replayResponse = await createSession("create-first", createBody);
  assert.equal(replayResponse.status, 201);
  assert.equal(replayResponse.headers.get("idempotency-replayed"), "true");
  assert.equal((await replayResponse.json()).id, first.id);
  const conflictReplay = await createSession("create-first", { profile: "shell", name: "Different" });
  assert.equal(conflictReplay.status, 409);

  const listResponse = await fetch(`${base}/api/sessions`);
  assertSecurity(listResponse);
  const list = await listResponse.json();
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0].generation, first.generation);

  const renameResponse = await fetch(`${base}/api/sessions/${first.id}`, {
    method: "PATCH",
    headers: mutationHeaders("rename-first", true),
    body: JSON.stringify({ name: "Renamed" }),
  });
  assert.equal(renameResponse.status, 200);
  assert.equal((await renameResponse.json()).name, "Renamed");

  const responses = await Promise.all([
    createSession("create-second", { profile: "shell", name: "Second" }),
    createSession("create-third", { profile: "shell", name: "Third" }),
  ]);
  assert.deepEqual(responses.map(response => response.status).sort((a, b) => a - b), [201, 429]);
  const secondResponse = responses.find(response => response.status === 201);
  const second = await secondResponse.json();

  const deleteRunning = await fetch(`${base}/api/sessions/${first.id}`, {
    method: "DELETE",
    headers: mutationHeaders("delete-running"),
  });
  assert.equal(deleteRunning.status, 409);

  const terminateResponse = await terminate(first.id, "terminate-first");
  assert.equal(terminateResponse.status, 202);
  assertSecurity(terminateResponse);
  const terminating = await terminateResponse.json();
  assert.equal(terminating.generation, first.generation);
  const terminateReplay = await terminate(first.id, "terminate-first");
  assert.equal(terminateReplay.status, 202);
  assert.equal(terminateReplay.headers.get("idempotency-replayed"), "true");

  const exited = await waitForSession(first.id, session => session.state === "exited");
  assert.equal(exited.generation, first.generation);
  assert.ok(exited.revision > first.revision);
  assert.ok(exited.eventSeq > 0);
  assert.ok(exited.outputOffset > 0);
  assert.equal(exited.checkpointEventSeq, exited.eventSeq);
  assert.ok(exited.checkpointBytes > 0);
  assert.equal(typeof exited.exitStatus, "number");

  const deleted = await fetch(`${base}/api/sessions/${first.id}`, {
    method: "DELETE",
    headers: mutationHeaders("delete-first"),
  });
  assert.equal(deleted.status, 204);
  assertSecurity(deleted, false);
  assert.equal((await fetch(`${base}/api/sessions/${first.id}`)).status, 404);

  const replacementResponse = await createSession("create-replacement", { profile: "shell", name: "Replacement" });
  assert.equal(replacementResponse.status, 201);
  const replacement = await replacementResponse.json();

  for (const [session, key] of [[second, "terminate-second"], [replacement, "terminate-replacement"]]) {
    assert.equal((await terminate(session.id, key)).status, 202);
    await waitForSession(session.id, value => value.state === "exited");
    const response = await fetch(`${base}/api/sessions/${session.id}`, {
      method: "DELETE",
      headers: mutationHeaders(`delete-${session.id}`),
    });
    assert.equal(response.status, 204);
  }

  const oversized = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: mutationHeaders("oversized", true),
    body: `{"profile":"shell","name":"${"x".repeat(5000)}"}`,
  });
  assert.equal(oversized.status, 413);
} finally {
  server.kill("SIGTERM");
  await Promise.race([
    new Promise(resolve => server.once("exit", resolve)),
    new Promise(resolve => setTimeout(resolve, 1000)),
  ]);
  if (server.exitCode === null) server.kill("SIGKILL");
}

await verifyNaturalExit();

function mutationHeaders(key, json = false) {
  const headers = {
    Origin: base,
    "Idempotency-Key": key,
  };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

function createSession(key, body, origin = base) {
  return fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify(body),
  });
}

async function verifyNaturalExit() {
  const port = await freePort();
  const localBase = `http://127.0.0.1:${port}`;
  const secondServer = spawn(serverPath, [
    "--port", String(port),
    "--origin", localBase,
    "--shell", "/bin/true",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitFor(async () => {
      try {
        return (await fetch(`${localBase}/api/server`)).ok;
      } catch {
        return false;
      }
    }, 5000, () => "natural-exit server failed to start");

    const createResponse = await fetch(`${localBase}/api/sessions`, {
      method: "POST",
      headers: {
        Origin: localBase,
        "Content-Type": "application/json",
        "Idempotency-Key": "natural-exit",
      },
      body: JSON.stringify({ profile: "shell" }),
    });
    assert.equal(createResponse.status, 201);
    const session = await createResponse.json();

    let exited;
    await waitFor(async () => {
      const response = await fetch(`${localBase}/api/sessions/${session.id}`);
      if (!response.ok) return false;
      exited = await response.json();
      return exited.state === "exited";
    }, 5000, () => "natural-exit session did not exit");
    assert.ok(exited.eventSeq > 0);
    assert.ok(exited.checkpointBytes > 0);
    assert.equal(typeof exited.exitStatus, "number");

    const deleteResponse = await fetch(`${localBase}/api/sessions/${session.id}`, {
      method: "DELETE",
      headers: {
        Origin: localBase,
        "Idempotency-Key": "delete-natural-exit",
      },
    });
    assert.equal(deleteResponse.status, 204);
  } finally {
    secondServer.kill("SIGTERM");
    await Promise.race([
      new Promise(resolve => secondServer.once("exit", resolve)),
      new Promise(resolve => setTimeout(resolve, 1000)),
    ]);
    if (secondServer.exitCode === null) secondServer.kill("SIGKILL");
  }
}

function terminate(id, key) {
  return fetch(`${base}/api/sessions/${id}/terminate`, {
    method: "POST",
    headers: mutationHeaders(key),
  });
}

async function waitForSession(id, predicate) {
  let latest;
  await waitFor(async () => {
    const response = await fetch(`${base}/api/sessions/${id}`);
    if (!response.ok) return false;
    latest = await response.json();
    return predicate(latest);
  }, 5000, () => `session did not reach expected state: ${JSON.stringify(latest)}\n${logs}`);
  return latest;
}

function assertSecurity(response, json = true) {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  if (json) assert.match(response.headers.get("content-type"), /^application\/json/);
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(message());
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}
