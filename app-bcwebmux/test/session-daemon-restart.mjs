// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createZstdDecompress } from "node:zlib";
import {
  SUBPROTOCOL,
  MAX_FRAME_LENGTH,
  ZERO_SESSION_ID,
  FrameType,
  encodeFrame,
  decodeFrame,
  readUint64LE,
  writeUint32LE,
  writeUint64LE,
} from "../web/protocol.js";
import { freePort, terminateProcess, waitFor } from "./test-support.mjs";

const [daemonPath, webPath, webRoot] = process.argv.slice(2);
assert.ok(
  daemonPath && webPath && webRoot,
  "usage: session-daemon-restart.mjs DAEMON WEB_SERVER WEB_ROOT",
);
const fixture = await mkdtemp(path.join(os.tmpdir(), "bcwebmux-daemon-restart-"));
const socket = path.join(fixture, "session.sock");
const shell = path.join(fixture, "shell");
const marker = path.join(fixture, "progress");
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
let daemon, frontend;
let logs = "";
function capture(child) {
  child.detachedGroup = true;
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      logs += String(chunk);
    });
  return child;
}
function launchFrontend(stateHome = fixture) {
  return capture(
    spawn(
      path.resolve(webPath),
      [
        "--config",
        "/dev/null",
        "--auth=false",
        "--listen",
        `127.0.0.1:${port}`,
        "--origin",
        base,
        "--web-root",
        path.resolve(webRoot),
        "--session-socket",
        socket,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: { ...process.env, XDG_STATE_HOME: stateHome },
      },
    ),
  );
}
async function waitFrontend() {
  await waitFor(
    async () => (await fetch(`${base}/api/server`).catch(() => null))?.ok,
    10000,
    "frontend did not start",
  );
}
async function mutate(method, target, body, key) {
  const response = await fetch(base + target, {
    method,
    headers: {
      Origin: base,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok)
    throw new Error(`${method} ${target}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}
async function session(id) {
  const response = await fetch(`${base}/api/sessions/${id}`);
  assert.equal(response.status, 200);
  return response.json();
}
async function attachAndRead(metadata, cursor = { eventSeq: 0n, offset: 0n }) {
  const ws = new WebSocket(base.replace("http:", "ws:") + "/ws", {
    protocols: SUBPROTOCOL,
    headers: { Origin: base },
  });
  ws.binaryType = "arraybuffer";
  const frames = [];
  let sequence = 0n;
  const send = (type, payload, extra = {}) =>
    ws.send(
      encodeFrame({
        type,
        payload,
        connectionSequence: ++sequence,
        requestId: 1n,
        attachmentId: 0n,
        attachmentEpoch: 0n,
        sessionId: ZERO_SESSION_ID,
        ...extra,
      }),
    );
  ws.addEventListener("message", (event) => {
    const frame = decodeFrame(new Uint8Array(event.data));
    if (frame.type === FrameType.PING)
      send(FrameType.PONG, frame.payload, { requestId: frame.requestId });
    else frames.push(frame);
  });
  await waitFor(() => ws.readyState === WebSocket.OPEN, 5000, "websocket did not open");
  const hello = new Uint8Array(56);
  hello.set(randomBytes(16));
  hello.set(
    createHash("sha256")
      .update(
        "bcwebmux-graphics-frame-v8-checkpoint-v2-continuation-1m-glyph-cell-partitions-pty-zstd-stream-v2-kitty-worker-normalize-v1-ghostty-728bbef6c",
      )
      .digest(),
    16,
  );
  writeUint32LE(hello, 48, 33554432);
  writeUint32LE(hello, 52, MAX_FRAME_LENGTH);
  send(FrameType.HELLO, hello);
  await waitFor(
    () => frames.some((frame) => frame.type === FrameType.WELCOME),
    5000,
    "websocket welcome missing",
  );
  const uuid = (value) =>
    Uint8Array.from(value.replaceAll("-", "").match(/../g), (hex) => Number.parseInt(hex, 16));
  const payload = new Uint8Array(40);
  payload.set(uuid(metadata.generation));
  writeUint64LE(payload, 16, cursor.eventSeq);
  writeUint64LE(payload, 24, cursor.offset);
  writeUint32LE(payload, 32, 33554432);
  send(FrameType.ATTACH, payload, {
    requestId: 2n,
    attachmentId: 1n,
    sessionId: uuid(metadata.id),
  });
  await waitFor(
    () => frames.some((frame) => frame.type === FrameType.LIVE_BARRIER),
    5000,
    "attach barrier missing",
  );
  const barrier = frames.find((frame) => frame.type === FrameType.LIVE_BARRIER);
  await waitFor(
    () => frames.some((frame) => frame.type === FrameType.EVENT_BATCH && frame.payload[0] === 0),
    5000,
    "terminal output missing",
  );
  const output = createZstdDecompress();
  const chunks = [];
  output.on("data", (chunk) => chunks.push(chunk));
  for (const frame of frames.filter(
    (frame) => frame.type === FrameType.EVENT_BATCH && frame.payload[0] === 0,
  )) {
    await new Promise((resolve, reject) =>
      output.write(frame.payload.subarray(32), (error) => (error ? reject(error) : resolve())),
    );
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(Buffer.concat(chunks).toString(), /output/);
  output.destroy();
  return {
    ws,
    eventSeq: readUint64LE(barrier.payload, 0),
    offset: readUint64LE(barrier.payload, 8),
  };
}
try {
  await writeFile(
    shell,
    `#!/bin/sh\n[ -f ${JSON.stringify(marker + ".pid")} ] || echo $$ > ${JSON.stringify(marker + ".pid")}\nwhile :; do echo running >> ${JSON.stringify(marker)}; echo output; sleep 0.1; done\n`,
  );
  await chmod(shell, 0o700);
  daemon = capture(
    spawn(
      path.resolve(daemonPath),
      [
        "--socket",
        socket,
        "--shell",
        shell,
        "--worker",
        path.join(path.dirname(path.resolve(daemonPath)), "bcwebmux-worker"),
      ],
      { stdio: ["ignore", "pipe", "pipe"], detached: true },
    ),
  );
  await waitFor(
    async () => (await stat(socket).catch(() => null))?.isSocket(),
    5000,
    "session daemon did not start",
  );
  assert.equal((await stat(socket)).mode & 0o077, 0, "session socket must be owner-only");
  frontend = launchFrontend();
  await waitFrontend();
  const created = await mutate(
    "POST",
    "/api/sessions",
    { profile: "shell", name: "persistent" },
    "restart-create",
  );
  assert.equal(created.name, "persistent");
  const metadataDirectory = path.join(fixture, "bcwebmux");
  assert.equal(
    (await stat(path.join(metadataDirectory, "metadata.json.names"))).mode & 0o077,
    0,
    "session names must be private",
  );
  await chmod(metadataDirectory, 0o500);
  let failedRename;
  try {
    failedRename = await fetch(`${base}/api/sessions/${created.id}`, {
      method: "PATCH",
      headers: {
        Origin: base,
        "Content-Type": "application/json",
        "Idempotency-Key": "failed-rename",
      },
      body: JSON.stringify({ name: "not saved" }),
    });
  } finally {
    await chmod(metadataDirectory, 0o700);
  }
  assert.ok(failedRename.status >= 500, `storage failure returned ${failedRename.status}`);
  assert.equal((await session(created.id)).name, "persistent");
  const renamed = await mutate(
    "PATCH",
    `/api/sessions/${created.id}`,
    { name: "renamed Ω" },
    "restart-rename",
  );
  assert.equal(renamed.name, "renamed Ω");
  const replayed = await mutate(
    "POST",
    "/api/sessions",
    { profile: "shell", name: "persistent" },
    "restart-create",
  );
  assert.equal(replayed.id, created.id);
  assert.equal(replayed.name, "renamed Ω", "create replay must not undo a later rename");
  await waitFor(
    async () => (await readFile(marker, "utf8").catch(() => "")).length > 10,
    5000,
    "shell did not run",
  );
  const shellPid = (await readFile(marker + ".pid", "utf8")).trim();
  const before = await session(created.id);
  const attachment = await attachAndRead(before);
  const second = await mutate(
    "POST",
    "/api/sessions",
    { profile: "shell", name: "second" },
    "restart-second",
  );
  const layout = await mutate("POST", "/api/session-layout", {
    source: second.id,
    target: created.id,
    position: "group",
  });
  assert.deepEqual(layout.layout, [[created.id, second.id]]);
  const length = (await readFile(marker, "utf8")).length;
  await terminateProcess(frontend);
  frontend = null;
  await waitFor(
    () => attachment.ws.readyState === WebSocket.CLOSED,
    5000,
    "frontend left websocket open",
  );
  await waitFor(
    async () => (await readFile(marker, "utf8")).length > length,
    5000,
    "shell stopped while web frontend was down",
  );
  frontend = launchFrontend(path.join(fixture, "independent-state"));
  await waitFrontend();
  assert.equal((await session(created.id)).name, "", "names must belong to the frontend state");
  assert.equal((await session(second.id)).name, "", "daemon must not retain session names");
  await terminateProcess(frontend);
  frontend = null;
  frontend = launchFrontend();
  await waitFrontend();
  const after = await session(created.id);
  assert.equal(after.id, before.id);
  assert.equal(after.generation, before.generation);
  assert.equal(after.name, "renamed Ω");
  assert.equal(after.state, "running");
  assert.equal((await session(second.id)).name, "second");
  const reattachment = await attachAndRead(after, attachment);
  assert.ok(reattachment.eventSeq > attachment.eventSeq);
  assert.ok(reattachment.offset > attachment.offset);
  reattachment.ws.close();
  assert.equal((await readFile(marker + ".pid", "utf8")).trim(), shellPid);
  process.kill(Number(shellPid), 0);
  const restoredLayout = await (await fetch(`${base}/api/session-layout`)).json();
  assert.deepEqual(restoredLayout.layout, layout.layout);
  console.log("session survives frontend restart");
} catch (error) {
  error.message += `\nProcess log:\n${logs}`;
  throw error;
} finally {
  await terminateProcess(frontend);
  await terminateProcess(daemon);
  await rm(fixture, { recursive: true, force: true });
}
