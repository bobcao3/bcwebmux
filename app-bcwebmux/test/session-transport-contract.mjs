// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

// Use installed assets: fzstd.js is produced by the normal web build.
const root = resolve(process.argv[2] ?? "zig-out/web");
const load = (name) => import(pathToFileURL(resolve(root, name)).href);
const { SessionTransport, CONNECTION_PROFILE: PROFILE } = await load("SessionTransport.js");
const { ABI_DIGEST, uuidBytes, writeGeometry } = await load("SessionWire.js");
const {
  FrameType: F,
  MAX_FRAME_LENGTH,
  encodeFrame,
  decodeFrame,
  writeUint32LE,
  writeUint64LE,
  readUint32LE,
  readUint64LE,
} = await load("protocol.js");

// Drain promise/message chains through an event-loop turn, not a wall-clock sleep.
const flush = () => new Promise((resolve) => setImmediate(resolve));
class Clock {
  time = 0;
  sequence = 0;
  timers = new Map();
  now = () => this.time;
  setTimeout = (fn, ms) => {
    const id = ++this.sequence;
    this.timers.set(id, { fn, at: this.time + Math.max(0, ms) });
    return id;
  };
  clearTimeout = (id) => this.timers.delete(id);
  next() {
    return [...this.timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
  }
  async advance(ms) {
    const end = this.time + ms;
    for (let timer; (timer = this.next()) && timer[1].at <= end;) {
      this.time = Math.max(this.time, timer[1].at);
      this.timers.delete(timer[0]);
      timer[1].fn();
      await flush();
    }
    this.time = end;
    await flush();
  }
  delay() {
    return this.next()?.[1].at - this.time;
  }
}
class Target {
  listeners = new Map();
  hidden = false;
  addEventListener(type, fn) {
    const values = this.listeners.get(type) ?? new Set();
    values.add(fn);
    this.listeners.set(type, values);
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type, event = {}) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
  count() {
    return [...this.listeners.values()].reduce((sum, values) => sum + values.size, 0);
  }
}
class Socket extends Target {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = Socket.CONNECTING;
  sent = [];
  serverSequence = 0n;
  bufferedAmount = 0;
  closeCalls = 0;
  open() {
    this.readyState = Socket.OPEN;
    this.emit("open");
  }
  send(bytes) {
    this.sent.push(decodeFrame(bytes));
  }
  // Deliberately never completes the close handshake.
  close() {
    this.closeCalls++;
    this.readyState = Socket.CLOSING;
  }
  closed() {
    this.readyState = Socket.CLOSED;
    this.emit("close");
  }
  frame(type, payload = new Uint8Array(), fields = {}) {
    this.emit("message", {
      data: encodeFrame({ type, payload, connectionSequence: ++this.serverSequence, ...fields }),
    });
  }
  frames(type) {
    return this.sent.filter((frame) => frame.type === type);
  }
  last(type) {
    return this.frames(type).at(-1);
  }
}
globalThis.WebSocket = Socket;
const metadata = {
  id: "11111111-1111-4111-8111-111111111111",
  generation: "22222222-2222-4222-8222-222222222222",
};
const geometry = { cols: 80, rows: 24, cellWidthPx: 8, cellHeightPx: 16 };
const backendInstance = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
class Core {
  disposed = 0;
  writes = [];
  onData(fn) {
    this.input = fn;
    return { dispose() {} };
  }
  setReplayMode() {}
  resizeCanonical() {}
  reset() {}
  write(bytes) {
    this.writes.push(bytes.slice());
  }
  dispose() {
    this.disposed++;
  }
}
function harness(t, options = {}) {
  const clock = new Clock(),
    sockets = [],
    window = new Target(),
    document = new Target(),
    errors = [];
  const transport = new SessionTransport({
    url: "wss://contract.invalid/ws",
    clientInstanceId: "33333333-3333-4333-8333-333333333333",
    clock,
    random: () => 0.5,
    window,
    document,
    webSocketFactory: () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
    ...options,
  });
  transport.configureServer({ capabilities: { attachmentResume: true } });
  transport.onError((error) => errors.push(error));
  t.after(() => transport.dispose());
  return { clock, sockets, window, document, errors, transport };
}
async function welcome(h, socket = h.sockets.at(-1), rtt = 40) {
  if (socket.readyState !== Socket.OPEN) socket.open();
  const hello = socket.last(F.HELLO);
  await h.clock.advance(rtt);
  const payload = new Uint8Array(88);
  payload.set(uuidBytes(backendInstance), 0);
  payload.set(ABI_DIGEST, 16);
  writeUint32LE(payload, 48, MAX_FRAME_LENGTH);
  writeUint32LE(payload, 52, 1024);
  writeUint32LE(payload, 56, 32 * 1024 * 1024);
  writeUint32LE(payload, 60, 15000);
  writeUint32LE(payload, 64, 45000);
  payload[68] = 1;
  writeUint64LE(payload, 80, 1n);
  socket.frame(F.WELCOME, payload, { requestId: hello.requestId });
  await flush();
  return socket;
}
test("WELCOME exposes backend restart identity", async (t) => {
  const h = harness(t);
  const ready = h.transport.connect();
  await welcome(h);
  await ready;
  assert.equal(h.transport.state.serverInstance, backendInstance);
});

async function pong(h, rtt = 40, socket = h.sockets.at(-1)) {
  const ping = socket.last(F.PING);
  assert.ok(ping);
  await h.clock.advance(rtt);
  socket.frame(F.PONG, ping.payload, { requestId: ping.requestId });
  await flush();
}
async function healthy(h) {
  const ready = h.transport.connect();
  const socket = await welcome(h);
  await ready;
  await pong(h);
  return socket;
}
function attachmentFields(attach) {
  return {
    attachmentId: attach.attachmentId,
    attachmentEpoch: attach.serverEpoch ?? 1n,
    sessionId: attach.sessionId,
  };
}
async function begin(socket, mode = 2, controller = false, options = {}) {
  const attach = socket.last(F.ATTACH);
  attach.serverEpoch = options.epoch ?? 1n;
  const payload = new Uint8Array(80);
  payload.set(uuidBytes(metadata.generation));
  payload[16] = mode;
  writeGeometry(payload, 20, geometry);
  writeGeometry(payload, 28, geometry);
  writeUint64LE(payload, 64, options.leaseEpoch ?? 1n);
  writeUint64LE(payload, 72, controller ? attach.attachmentId : 0n);
  socket.frame(F.ATTACH_BEGIN, payload, {
    ...attachmentFields(attach),
    requestId: attach.requestId,
  });
  await flush();
  return attach;
}
async function live(socket, attach) {
  socket.frame(F.LIVE_BARRIER, new Uint8Array(16), attachmentFields(attach));
  await flush();
}
async function lease(socket, attach) {
  const payload = new Uint8Array(24);
  writeUint64LE(payload, 0, 1n);
  writeUint64LE(payload, 8, attach.attachmentId);
  writeGeometry(payload, 16, geometry);
  socket.frame(F.LEASE_CHANGED, payload, attachmentFields(attach));
  await flush();
}

test("old callbacks and rejected async message work cannot retire or block replacement", async (t) => {
  const h = harness(t),
    socket = await healthy(h),
    core = new Core();
  let rejectShadow;
  h.transport.activate({
    core,
    onResize: () => ({ dispose() {} }),
    onSelectionModeChange: () => ({ dispose() {} }),
    createCore: () =>
      new Promise((resolve, reject) => {
        rejectShadow = reject;
      }),
  });
  const attached = h.transport.attach(metadata, core);
  attached.catch(() => {});
  await flush();
  await begin(socket, 1);
  assert.equal(typeof rejectShadow, "function");
  socket.emit("error");
  await h.clock.advance(PROFILE.retryFloorMs);
  const replacement = await welcome(h);
  assert.equal(
    h.transport.state.connected,
    true,
    "new message chain is independent of old pending await",
  );
  const errors = h.errors.length;
  rejectShadow(new Error("stale shadow rejection"));
  socket.emit("open");
  socket.emit("error");
  socket.emit("close");
  socket.emit("message", { data: new Uint8Array([255]) });
  await flush();
  assert.equal(h.errors.length, errors);
  assert.equal(replacement.closeCalls, 0);
  assert.equal(h.transport.state.connected, true);
});

test("input is never replayed and disconnected input is dropped", async (t) => {
  const h = harness(t),
    socket = await healthy(h),
    core = new Core();
  const attached = h.transport.attach(metadata, core);
  await flush();
  const initial = await begin(socket, 2, true);
  await live(socket, initial);
  const record = await attached;
  h.transport.setActive(record);
  core.input(new TextEncoder().encode("unacknowledged\n"));
  assert.equal(socket.frames(F.INPUT).length, 1);
  socket.emit("error");
  core.input(new TextEncoder().encode("offline\n"));
  await h.clock.advance(PROFILE.retryFloorMs);
  const replacement = h.sockets.at(-1);
  replacement.open();
  assert.equal(replacement.last(F.ATTACH).attachmentId, initial.attachmentId);
  assert.notEqual(replacement.last(F.ATTACH).requestId, initial.requestId);
  assert.equal(h.transport.state.connected, false);
  assert.equal(replacement.closeCalls, 0);
  assert.deepEqual(
    replacement.sent.map((frame) => frame.type),
    [F.HELLO, F.ATTACH],
  );
  assert.equal(replacement.frames(F.INPUT).length, 0);
  await welcome(h, replacement);
  assert.equal(replacement.frames(F.ATTACH).length, 1);
  const attach = await begin(replacement);
  await live(replacement, attach);
  await lease(replacement, attach);
  assert.equal(replacement.frames(F.INPUT).length, 0);
  core.input(new TextEncoder().encode("fresh\n"));
  assert.equal(replacement.frames(F.INPUT).length, 1);
  assert.equal(new TextDecoder().decode(replacement.last(F.INPUT).payload.subarray(24)), "fresh\n");
  assert.equal(socket.frames(F.INPUT).length, 1);
});

test("dispose during negotiation rejects readiness and cancels deadlines", async (t) => {
  const h = harness(t);
  const ready = h.transport.connect();
  const rejected = assert.rejects(ready, /disposed/);
  h.transport.dispose();
  await rejected;
  assert.equal(h.clock.timers.size, 0);
  assert.equal(h.sockets[0].closeCalls, 1);
  h.sockets[0].emit("close");
  assert.equal(h.clock.timers.size, 0);
});

test("stable attachment handover carries controller lease, ACK precedes input, and unchanged size does not resize", async (t) => {
  const h = harness(t),
    socket = await healthy(h),
    core = new Core();
  let resize;
  const terminal = {
    core,
    state: { physicalCellWidth: 8, physicalCellHeight: 16 },
    onResize: (fn) => {
      resize = fn;
      return { dispose() {} };
    },
    onSelectionModeChange: () => ({ dispose() {} }),
    attachCore(value) {
      this.core = value;
    },
  };
  h.transport.activate(terminal);
  const attached = h.transport.attach(metadata, core);
  await flush();
  const initial = await begin(socket, 2, true);
  await live(socket, initial);
  const record = await attached;
  h.transport.setActive(record);
  resize({ cols: 80, rows: 24 });
  assert.equal(socket.frames(F.RESIZE_REQUEST).length, 0);
  socket.emit("error");
  resize({ cols: 80, rows: 24 });
  await h.clock.advance(PROFILE.retryFloorMs);
  const replacement = h.sockets.at(-1);
  replacement.open();
  const resumedRequest = replacement.last(F.ATTACH);
  assert.equal(resumedRequest.attachmentId, initial.attachmentId);
  assert.notEqual(resumedRequest.requestId, initial.requestId);
  assert.equal(resumedRequest.attachmentEpoch, 0n);
  await welcome(h, replacement);
  const resumed = await begin(replacement, 2, true, { epoch: 7n, leaseEpoch: 73n });
  assert.equal(record.controller, true);
  assert.equal(record.live, false);
  assert.equal(record.epoch, 7n);
  core.setReplayMode = (mode) => {
    if (!mode) core.input(new TextEncoder().encode("activation must not precede ACK"));
  };
  await live(replacement, resumed);
  assert.equal(replacement.frames(F.INPUT).length, 0);
  assert.equal(replacement.frames(F.ACK).length, 1);
  assert.equal(replacement.frames(F.CLAIM_CONTROL).length, 0);
  assert.equal(replacement.frames(F.RESIZE_REQUEST).length, 0);
  socket.emit("open");
  socket.emit("error");
  socket.emit("close");
  socket.emit("message", { data: new Uint8Array([255]) });
  await flush();
  assert.equal(replacement.closeCalls, 0);
  core.input(new TextEncoder().encode("fresh\n"));
  const input = replacement.last(F.INPUT);
  const ack = replacement.frames(F.ACK).at(-1);
  assert.equal(readUint64LE(input.payload, 0), 73n);
  assert.equal(input.attachmentEpoch, 7n);
  assert.ok(replacement.sent.indexOf(ack) < replacement.sent.indexOf(input));
  assert.equal(record.live, true);
  resize({ cols: 81, rows: 24 });
  assert.equal(replacement.frames(F.RESIZE_REQUEST).length, 1);
  assert.equal(readUint64LE(replacement.last(F.RESIZE_REQUEST).payload, 0), 73n);
});

test("old-server absent capability uses a fresh ID and still claims after ACK", async (t) => {
  const h = harness(t),
    socket = await healthy(h),
    core = new Core();
  h.transport.configureServer({});
  const attached = h.transport.attach(metadata, core);
  await flush();
  const initial = await begin(socket, 2, true);
  await live(socket, initial);
  const record = await attached;
  h.transport.setActive(record);
  socket.emit("error");
  await h.clock.advance(PROFILE.retryFloorMs);
  const replacement = await welcome(h);
  const resumed = await begin(replacement, 2, false, { epoch: 2n });
  await live(replacement, resumed);
  assert.equal(record.controller, false);
  assert.notEqual(resumed.attachmentId, initial.attachmentId);
  assert.equal(record.epoch, 2n);
  assert.equal(replacement.frames(F.CLAIM_CONTROL).length, 1);
  const ack = replacement.frames(F.ACK).at(-1);
  const claim = replacement.frames(F.CLAIM_CONTROL).at(-1);
  assert.ok(replacement.sent.indexOf(ack) < replacement.sent.indexOf(claim));
  core.input(new Uint8Array([1]));
  assert.equal(replacement.frames(F.INPUT).length, 0);
  await lease(replacement, resumed);
  core.input(new Uint8Array([2]));
  assert.equal(replacement.frames(F.INPUT).length, 1);
});

test("matched PONG arrival bypasses deferred core creation while application frames stay ordered", async (t) => {
  const h = harness(t),
    socket = await healthy(h),
    core = new Core();
  let resolveShadow;
  const terminal = {
    core,
    onResize: () => ({ dispose() {} }),
    onSelectionModeChange: () => ({ dispose() {} }),
    createCore: () =>
      new Promise((resolve) => {
        resolveShadow = resolve;
      }),
    attachCore(value) {
      this.core = value;
    },
  };
  h.transport.activate(terminal);
  const attached = h.transport.attach(metadata, core, { eventSeq: 1 });
  await flush();
  const attach = await begin(socket, 0, true);
  assert.equal(typeof resolveShadow, "function");
  socket.frame(F.LIVE_BARRIER, new Uint8Array(16), attachmentFields(attach));
  await flush();
  assert.equal(socket.frames(F.ACK).length, 0);
  for (let i = 0; i < 6; i++) {
    await h.clock.advance(1000);
    await pong(h, 40, socket);
    assert.equal(socket.closeCalls, 0);
    assert.equal(h.sockets.length, 1);
  }
  assert.equal(socket.frames(F.ACK).length, 0);
  assert.equal(h.transport.state.wsRttLatestMs, 40);
  resolveShadow(new Core());
  await flush();
  const record = await attached;
  assert.equal(record.live, true);
  assert.equal(socket.frames(F.ACK).length, 1);
  assert.equal(h.errors.length, 0);
});

test("fast PONG path still enforces wire sequence, connection scope, and nonce", async (t) => {
  for (const kind of ["sequence", "scope", "nonce"]) {
    const h = harness(t),
      socket = await healthy(h);
    await h.clock.advance(1000);
    const ping = socket.last(F.PING);
    const payload = ping.payload.slice();
    const fields = { requestId: ping.requestId };
    if (kind === "sequence") fields.connectionSequence = socket.serverSequence + 2n;
    if (kind === "scope") fields.attachmentId = 1n;
    if (kind === "nonce") writeUint64LE(payload, 0, ping.requestId + 1n);
    const samples = h.transport.state._rttSamples.length;
    socket.frame(F.PONG, payload, fields);
    assert.equal(socket.closeCalls, 1);
    assert.equal(h.transport.state.connected, false);
    assert.equal(h.transport.state._rttSamples.length, samples);
    assert.match(h.errors.at(-1).message, /sequence gap|invalid PONG/);
    h.transport.dispose();
    assert.equal(h.clock.timers.size, 0);
  }
});

test("genuine geometry changes made offline remain pending through carried-lease resume", async (t) => {
  const h = harness(t),
    socket = await healthy(h),
    core = new Core();
  let resize;
  h.transport.activate({
    core,
    state: { physicalCellWidth: 8, physicalCellHeight: 16 },
    onResize: (fn) => {
      resize = fn;
      return { dispose() {} };
    },
    onSelectionModeChange: () => ({ dispose() {} }),
  });
  const attached = h.transport.attach(metadata, core);
  await flush();
  const initial = await begin(socket, 2, true);
  await live(socket, initial);
  const record = await attached;
  h.transport.setActive(record);
  socket.emit("error");
  resize({ cols: 81, rows: 25 });
  assert.equal(socket.frames(F.RESIZE_REQUEST).length, 0);
  await h.clock.advance(PROFILE.retryFloorMs);
  const replacement = await welcome(h);
  const resumed = await begin(replacement, 2, true, { epoch: 3n, leaseEpoch: 9n });
  await live(replacement, resumed);
  assert.equal(replacement.frames(F.CLAIM_CONTROL).length, 0);
  assert.equal(replacement.frames(F.RESIZE_REQUEST).length, 1);
  const request = replacement.last(F.RESIZE_REQUEST);
  assert.equal(readUint64LE(request.payload, 0), 9n);
  assert.ok(
    replacement.sent.indexOf(replacement.frames(F.ACK).at(-1)) < replacement.sent.indexOf(request),
  );
});

test("fatal ERROR during digest preserves committed core and retries after the floor", async (t) => {
  const h = harness(t),
    socket = await healthy(h),
    core = new Core(),
    shadow = new Core();
  let snapshots = 0;
  shadow.restoreSnapshot = () => snapshots++;
  h.transport.activate({
    core,
    onResize: () => ({ dispose() {} }),
    onSelectionModeChange: () => ({ dispose() {} }),
    createCore: async () => shadow,
    attachCore(value) {
      this.core = value;
    },
  });
  const attached = h.transport.attach(metadata, core);
  await flush();
  const initial = await begin(socket, 2, true);
  await live(socket, initial);
  const record = await attached;
  record.eventSeq = 7n;
  record.outputOffset = 9n;
  socket.emit("error");
  await h.clock.advance(PROFILE.retryFloorMs);
  const replacement = await welcome(h);
  const attach = await begin(replacement, 1);
  assert.equal(record.core, shadow);
  const digest = crypto.subtle.digest;
  let resolveDigest;
  try {
    crypto.subtle.digest = () =>
      new Promise((resolve) => {
        resolveDigest = resolve;
      });
    record.checkpoint = new Uint8Array([1]);
    record.checkpointOffset = 1;
    record.checkpointHash = new Uint8Array(32);
    replacement.frame(F.CHECKPOINT_END, new Uint8Array(32), attachmentFields(attach));
    await flush();
    assert.equal(typeof resolveDigest, "function");
    replacement.frame(F.ERROR, fatalPayload());
    replacement.closed();
    assert.equal(h.errors.length, 1);
    assert.equal(h.transport.state.status, "backoff");
    assert.equal(record.core, core);
    assert.equal(record.eventSeq, 7n);
    assert.equal(record.outputOffset, 9n);
    resolveDigest(new ArrayBuffer(32));
    await flush();
    assert.equal(snapshots, 0);
    assert.equal(shadow.disposed, 1);
    assert.equal(core.disposed, 0);
    assert.equal(replacement.frames(F.ACK).length, 0);
    assert.equal(h.transport.state.queuedApplicationBytes, 0);
    socket.closed();
    await h.clock.advance(PROFILE.retryFloorMs * 2 - 1);
    assert.equal(h.sockets.length, 2);
    await h.clock.advance(1);
    assert.equal(h.sockets.length, 3);
  } finally {
    crypto.subtle.digest = digest;
  }
});

test("backoff has a positive floor and ceiling; WELCOME alone cannot reset it", async (t) => {
  const h = harness(t);
  const ready = h.transport.connect();
  for (const delay of [500, 1000, 2000, 4000, 8000, 10000, 10000, 10000]) {
    const socket = await welcome(h);
    await ready;
    socket.emit("error");
    socket.closed();
    const count = h.sockets.length;
    h.window.emit("online");
    await h.clock.advance(delay - 1);
    assert.equal(h.sockets.length, count);
    await h.clock.advance(1);
    assert.equal(h.sockets.length, count + 1);
  }
  await welcome(h);
  await pong(h);
  h.sockets.at(-1).emit("error");
  await h.clock.advance(PROFILE.retryFloorMs);
  assert.equal(
    h.sockets.length,
    10,
    "a healthy connection resets retry backoff to its 500ms floor",
  );
});

test("queued ACK stays ahead of input and controls get bounded reserved priority", async (t) => {
  const h = harness(t),
    socket = await healthy(h),
    core = new Core();
  const attached = h.transport.attach(metadata, core);
  await flush();
  const attach = await begin(socket, 2, true);
  socket.bufferedAmount = 4 * 1024 * 1024 - 64 * 1024;
  await live(socket, attach);
  const record = await attached;
  assert.equal(record.live, true);
  assert.equal(socket.frames(F.ACK).length, 0);
  core.input(new Uint8Array([1]));
  assert.equal(socket.frames(F.INPUT).length, 0);
  socket.frame(F.PING, new Uint8Array(8));
  assert.equal(socket.frames(F.PONG).length, 1);
  socket.bufferedAmount = 0;
  await h.clock.advance(100);
  assert.equal(socket.frames(F.ACK).length, 1);
  core.input(new Uint8Array([2]));
  assert.equal(socket.frames(F.INPUT).length, 1);
  assert.ok(socket.sent.indexOf(socket.last(F.ACK)) < socket.sent.indexOf(socket.last(F.INPUT)));
  socket.sent.forEach((frame, i) => assert.equal(frame.connectionSequence, BigInt(i + 1)));
});

test("local core creation failure belongs to attachment operation, not connection failure", async (t) => {
  const h = harness(t),
    socket = await healthy(h),
    core = new Core();
  h.transport.activate({
    core,
    onResize: () => ({ dispose() {} }),
    onSelectionModeChange: () => ({ dispose() {} }),
    createCore: async () => {
      throw new Error("core allocation failed");
    },
  });
  const attached = h.transport.attach(metadata, core);
  const rejected = assert.rejects(attached, /core allocation failed/);
  await flush();
  await begin(socket, 1);
  await rejected;
  assert.equal(socket.closeCalls, 0);
  assert.equal(h.errors.length, 0);
  await h.clock.advance(PROFILE.probeIntervalMs);
  await pong(h);
  assert.equal(h.transport.state.connected, true);
});

test("attachment notifications are synchronous committed changes, separate from lifecycle", async (t) => {
  const h = harness(t),
    socket = await healthy(h),
    core = new Core(),
    changes = [],
    statuses = [];
  h.transport.onStatus((status) => statuses.push(status));
  const subscription = h.transport.onAttachmentChanged((record, reason) => {
    changes.push(reason);
    if (reason === "live") {
      assert.equal(record.live, true);
      assert.ok(socket.last(F.ACK), "LIVE notification follows application and ACK admission");
    }
  });
  const attached = h.transport.attach(metadata, core);
  await flush();
  const attach = await begin(socket, 2, false);
  socket.frame(F.LIVE_BARRIER, new Uint8Array(16), attachmentFields(attach));
  assert.equal(changes.at(-1), "live");
  const record = await attached;
  h.transport.setActive(record);
  assert.equal(changes.at(-1), "active");
  await lease(socket, attach);
  assert.equal(changes.at(-1), "lease");
  const inputAck = new Uint8Array(12);
  inputAck[8] = 2;
  socket.frame(F.INPUT_ACK, inputAck, attachmentFields(attach));
  assert.equal(changes.at(-1), "controller");
  assert.equal(record.controller, false);
  await flush();
  socket.frame(F.EXITED, new Uint8Array(20), attachmentFields(attach));
  assert.equal(changes.at(-1), "exit");
  await flush();
  h.transport.detach(record);
  assert.equal(changes.at(-1), "removed");
  assert.equal(h.transport.activeAttachment, null);
  assert.deepEqual(statuses, [], "attachment changes are not duplicate lifecycle events");
  subscription.dispose();
});

test("attach cancellation before and while waiting for connect preserves caller reason", async (t) => {
  const h = harness(t),
    abort = new AbortController(),
    reason = new Error("caller canceled startup");
  abort.abort(reason);
  await assert.rejects(
    h.transport.attach(metadata, new Core(), { signal: abort.signal }),
    (error) => error === reason,
  );
  assert.equal(h.sockets.length, 0);
  const next = new AbortController();
  const attaching = h.transport.attach(metadata, new Core(), { signal: next.signal });
  const rejected = assert.rejects(attaching, (error) => error === reason);
  next.abort(reason);
  await rejected;
  assert.equal(h.sockets[0].closeCalls, 0);
  await welcome(h);
  assert.equal(h.sockets[0].frames(F.ATTACH).length, 0);
  assert.equal(h.transport.state.attachmentCount, 0);
});

test("abort during restore releases ordered work and late core without closing shared socket", async (t) => {
  const h = harness(t),
    socket = await healthy(h),
    core = new Core(),
    abort = new AbortController();
  let resolveCore;
  h.transport.activate({
    core,
    onResize: () => ({ dispose() {} }),
    onSelectionModeChange: () => ({ dispose() {} }),
    createCore: () =>
      new Promise((resolve) => {
        resolveCore = resolve;
      }),
  });
  const attached = h.transport.attach(metadata, core, { signal: abort.signal });
  const reason = new Error("caller canceled restore"),
    rejected = assert.rejects(attached, (error) => error === reason);
  await flush();
  const attach = await begin(socket, 1);
  socket.frame(F.LIVE_BARRIER, new Uint8Array(16), attachmentFields(attach));
  abort.abort(reason);
  await rejected;
  await flush();
  assert.equal(h.transport.state.attachmentCount, 0);
  assert.equal(h.transport.state.queuedApplicationBytes, 0);
  assert.equal(socket.frames(F.DETACH).length, 1);
  assert.equal(socket.frames(F.ACK).length, 0);
  assert.equal(socket.closeCalls, 0);
  const late = new Core();
  resolveCore(late);
  await flush();
  assert.equal(late.disposed, 1);
  await h.clock.advance(PROFILE.probeIntervalMs);
  await pong(h);
  assert.equal(h.errors.length, 0);
});

test("abort after ATTACH submission detaches when its admitted server epoch arrives", async (t) => {
  const h = harness(t),
    socket = await healthy(h),
    abort = new AbortController();
  const attached = h.transport.attach(metadata, new Core(), { signal: abort.signal });
  const reason = new Error("cancel pending ATTACH"),
    rejected = assert.rejects(attached, (error) => error === reason);
  await flush();
  abort.abort(reason);
  await rejected;
  assert.equal(socket.frames(F.DETACH).length, 0);
  await begin(socket, 2);
  assert.equal(socket.frames(F.DETACH).length, 1);
  assert.equal(socket.last(F.DETACH).attachmentEpoch, 1n);
  assert.equal(socket.closeCalls, 0);
});

test("successful LIVE removes old abort signal; pending uncanceled attach survives retries", async (t) => {
  const h = harness(t),
    socket = await healthy(h),
    abort = new AbortController();
  const attached = h.transport.attach(metadata, new Core(), { signal: abort.signal });
  await flush();
  socket.emit("error");
  await h.clock.advance(PROFILE.retryFloorMs);
  const replacement = await welcome(h);
  const attach = await begin(replacement, 2, true);
  await live(replacement, attach);
  const record = await attached;
  abort.abort(new Error("old caller disposed"));
  assert.equal(record.live, true);
  assert.equal(record.active, true);
  assert.equal(replacement.frames(F.DETACH).length, 0);
  assert.equal(record.cleanupAbort, null);
});

test("two actual core creations bound canceled retries until actual completion releases admission", async (t) => {
  const h = harness(t),
    core = new Core(),
    jobs = [];
  let socket = await healthy(h);
  h.transport.activate({
    core,
    onResize: () => ({ dispose() {} }),
    onSelectionModeChange: () => ({ dispose() {} }),
    createCore: () => new Promise((resolve) => jobs.push(resolve)),
  });
  const attached = h.transport.attach(metadata, core);
  attached.catch(() => {});
  await flush();
  await begin(socket, 1);
  assert.equal(jobs.length, 1);
  for (let i = 0; i < 4; i++) {
    socket.emit("error");
    socket.closed();
    await h.clock.advance(i === 0 ? PROFILE.retryFloorMs : 10000);
    socket = await welcome(h);
    await begin(socket, 1);
    assert.equal(jobs.length, 2, "logical cancellation cannot admit a third unresolved job");
  }
  assert.equal(socket.closeCalls, 0);
  await pong(h, 1000);
  assert.equal(h.transport.state.connected, true);
  const late = new Core();
  jobs[0](late);
  await flush();
  assert.equal(late.disposed, 1);
  assert.equal(jobs.length, 3, "actual completion admits current waiting restore only");
  const stale = new Core();
  jobs[1](stale);
  await flush();
  assert.equal(stale.disposed, 1);
  h.transport.dispose();
  const last = new Core();
  jobs[2](last);
  await flush();
  assert.equal(last.disposed, 1);
});

function fatalPayload(detail = "terminal ABI mismatch") {
  const text = new TextEncoder().encode(detail),
    payload = new Uint8Array(4 + text.length);
  payload[0] = 2;
  payload[2] = 1;
  payload.set(text, 4);
  return payload;
}

test("connection profile rejects invalid windows", (t) => {
  for (const value of [0, -1, Infinity, NaN])
    assert.throws(() => harness(t, { profile: { responseMs: value } }), /finite and positive/);
});

test("ensure-ready survives independent cold connection and HELLO windows", async (t) => {
  const h = harness(t);
  let settled = 0;
  const ready = h.transport.connect().then(() => settled++);
  const first = h.sockets[0];
  await h.clock.advance(PROFILE.connectMs - 1);
  assert.equal(first.closeCalls, 0);
  await h.clock.advance(1);
  assert.equal(first.closeCalls, 1);
  assert.equal(settled, 0);
  assert.equal(h.errors.length, 0);
  first.closed();
  await h.clock.advance(PROFILE.retryFloorMs);
  const second = h.sockets[1];
  await h.clock.advance(9000);
  second.open();
  await h.clock.advance(PROFILE.helloMs - 1);
  assert.equal(second.closeCalls, 0, "HELLO does not borrow the connection window");
  await h.clock.advance(1);
  assert.equal(second.closeCalls, 1);
  second.closed();
  await h.clock.advance(PROFILE.retryFloorMs * 2);
  await welcome(h, h.sockets[2], 1200);
  await ready;
  assert.equal(settled, 1);
  assert.equal(h.transport.state.negotiationMs, 1200);
  assert.equal(h.transport.state.wsRttLatestMs, null, "negotiation is not a PONG sample");
  await pong(h, 1200);
  assert.equal(h.transport.state.wsRttLatestMs, 1200);
  assert.equal(h.errors.length, 0);
});

test("two unreleased sockets bound repeated logical retirement; closure alone releases slots", async (t) => {
  const h = harness(t),
    first = await healthy(h);
  first.emit("error");
  await h.clock.advance(PROFILE.retryFloorMs);
  const second = h.sockets[1];
  assert.ok(second);
  second.emit("error");
  await h.clock.advance(60000);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.transport.state.status, "resource-wait");
  assert.equal(h.transport.state.unreleasedSockets, 2);
  const waiting = h.transport.connect();
  waiting.catch(() => {});
  h.window.emit("online");
  h.document.emit("visibilitychange");
  first.bufferedAmount = second.bufferedAmount = 0;
  await h.clock.advance(60000);
  assert.equal(h.sockets.length, 2);
  first.closed();
  assert.equal(h.sockets.length, 3);
  assert.equal(h.transport.state.unreleasedSockets, 2);
  first.emit("close");
  assert.equal(h.transport.state.unreleasedSockets, 2, "release is exactly once");
  const third = await welcome(h);
  await waiting;
  third.emit("error");
  await h.clock.advance(20000);
  assert.equal(h.sockets.length, 3, "third logical retirement still cannot forge physical closure");
  second.closed();
  assert.equal(h.sockets.length, 4);
  h.transport.dispose();
  third.closed();
  h.sockets[3].closed();
  assert.equal(h.transport.state.unreleasedSockets, 0);
  assert.equal(h.sockets.length, 4);
  assert.equal(h.clock.timers.size, 0);
  assert.equal(h.errors.length, 0);
});

test("observed CLOSED state admits only after backoff and releases constructor failures", async (t) => {
  const h = harness(t),
    first = await healthy(h);
  first.emit("error");
  await h.clock.advance(PROFILE.retryFloorMs);
  const second = h.sockets[1];
  second.emit("error");
  first.readyState = Socket.CLOSED;
  const ready = h.transport.connect();
  ready.catch(() => {});
  h.window.emit("online");
  assert.equal(h.sockets.length, 2, "notification cannot bypass backoff");
  await h.clock.advance(500);
  assert.equal(h.sockets.length, 3);
  assert.equal(h.transport.state.unreleasedSockets, 2);
  h.transport.dispose();
  let attempts = 0;
  const k = harness(t, {
    webSocketFactory: () => {
      attempts++;
      throw new Error("constructor failed");
    },
  });
  const pending = k.transport.connect();
  pending.catch(() => {});
  await k.clock.advance(10000);
  assert.ok(attempts > 2);
  assert.equal(k.transport.state.unreleasedSockets, 0);
  assert.equal(k.errors.length, 0);
});

test("operation cancellation and deadline do not retire a shared connection", async (t) => {
  const h = harness(t),
    abort = new AbortController();
  const canceled = h.transport.connect({ signal: abort.signal });
  const expires = h.transport.connect({ timeoutMs: 50 });
  const survives = h.transport.connect();
  const rejected = assert.rejects(canceled, /canceled/);
  const timed = assert.rejects(expires, /operation deadline/);
  abort.abort(new Error("canceled by caller"));
  await h.clock.advance(50);
  await rejected;
  await timed;
  assert.equal(h.sockets[0].closeCalls, 0);
  await welcome(h);
  await survives;
  assert.equal(h.errors.length, 0);
});

test("suspect retains attachment/input authority; late PONG clears it without teardown", async (t) => {
  const h = harness(t),
    socket = await healthy(h),
    core = new Core();
  const attached = h.transport.attach(metadata, core);
  await flush();
  const attach = await begin(socket, 2, true);
  await live(socket, attach);
  const record = await attached;
  h.transport.setActive(record);
  await h.clock.advance(PROFILE.probeIntervalMs);
  const probe = socket.last(F.PING);
  await h.clock.advance(6000);
  assert.equal(h.transport.state.status, "hedging-connect");
  assert.equal(h.transport.state.connected, true);
  assert.equal(record.live && record.controller, true);
  core.input(new Uint8Array([42]));
  assert.equal(socket.frames(F.INPUT).length, 1);
  socket.frame(F.PONG, probe.payload, { requestId: probe.requestId });
  assert.equal(h.transport.state.status, "ready");
  assert.equal(h.transport.state.wsRttLatestMs, 6000);
  assert.equal(h.transport.state.latePongs, 1);
  assert.equal(socket.closeCalls, 0);
  const count = socket.frames(F.PING).length;
  await h.clock.advance(PROFILE.probeIntervalMs - 1);
  assert.equal(socket.frames(F.PING).length, count);
  await h.clock.advance(1);
  assert.equal(socket.frames(F.PING).length, count + 1);
  assert.equal(h.errors.length, 0);
});

test("missing heartbeat starts one hedge without retiring the incumbent", async (t) => {
  const h = harness(t),
    incumbent = await healthy(h),
    core = new Core();
  const attached = h.transport.attach(metadata, core);
  await flush();
  const attach = await begin(incumbent, 2, true);
  await live(incumbent, attach);
  const record = await attached;
  h.transport.setActive(record);
  await h.clock.advance(PROFILE.probeIntervalMs);
  await h.clock.advance(PROFILE.hedgeDelayMs - 1);
  assert.equal(h.sockets.length, 1);
  await h.clock.advance(1);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.transport.state.connected, true);
  assert.equal(incumbent.closeCalls, 0);
  core.input(new Uint8Array([7]));
  assert.equal(incumbent.frames(F.INPUT).length, 1);
  await h.clock.advance(5000);
  assert.equal(h.sockets.length, 2, "one unanswered heartbeat admits only one hedge");
});

test("late incumbent heartbeat cancels its hedge without switching", async (t) => {
  const h = harness(t),
    incumbent = await healthy(h);
  await h.clock.advance(PROFILE.probeIntervalMs + PROFILE.hedgeDelayMs);
  const hedge = h.sockets[1];
  assert.ok(hedge);
  await pong(h, 1, incumbent);
  assert.equal(incumbent.closeCalls, 0);
  assert.equal(hedge.closeCalls, 1);
  assert.equal(h.transport.state.status, "ready");
  assert.equal(h.transport.state.generation, 1);
});

test("a ready hedge replaces the incumbent without a disconnected state", async (t) => {
  const h = harness(t),
    incumbent = await healthy(h),
    core = new Core(),
    statuses = [];
  h.transport.onStatus((status, state) => statuses.push([status, state.connected]));
  const attached = h.transport.attach(metadata, core);
  await flush();
  const initial = await begin(incumbent, 2, true);
  await live(incumbent, initial);
  const record = await attached;
  h.transport.setActive(record);
  await h.clock.advance(PROFILE.probeIntervalMs + PROFILE.hedgeDelayMs);
  const hedge = h.sockets[1];
  hedge.open();
  await welcome(h, hedge, 40);
  assert.equal(incumbent.closeCalls, 1);
  assert.equal(h.transport.state.connected, true);
  assert.equal(h.transport.state.status, "roaming");
  assert.ok(
    statuses.every(([, connected]) => connected),
    "hedging must not publish a disconnected switchover",
  );
  assert.equal(record.live, true, "the incumbent core stays presented while the hedge attaches");
  assert.equal(record.core, core);
  const resumed = hedge.last(F.ATTACH);
  assert.equal(resumed.attachmentId, initial.attachmentId);
  const rebound = await begin(hedge, 2, true, { epoch: 2n, leaseEpoch: 2n });
  await live(hedge, rebound);
  assert.equal(h.transport.state.status, "ready");
  core.input(new Uint8Array([9]));
  assert.equal(hedge.frames(F.INPUT).length, 1);
});

test("continuous one-way application traffic and unmatched PONG do not renew response budget", async (t) => {
  const h = harness(t),
    socket = await healthy(h),
    core = new Core();
  const attached = h.transport.attach(metadata, core);
  await flush();
  const attach = await begin(socket, 2, true);
  await live(socket, attach);
  await attached;
  await h.clock.advance(PROFILE.probeIntervalMs);
  const count = socket.frames(F.PING).length;
  const unmatched = new Uint8Array(8);
  writeUint64LE(unmatched, 0, 1n);
  for (let i = 0; i < 14; i++) {
    await h.clock.advance(1000);
    const payload = new Uint8Array(40);
    payload[0] = 1;
    writeUint32LE(payload, 4, 8);
    writeUint32LE(payload, 12, 8);
    writeUint64LE(payload, 16, BigInt(i + 1));
    writeGeometry(payload, 32, geometry);
    socket.frame(F.EVENT_BATCH, payload, attachmentFields(attach));
    socket.frame(F.PONG, unmatched, { requestId: 1n });
    await flush();
    assert.equal(socket.closeCalls, 0);
  }
  assert.equal(socket.frames(F.ACK).length, 15);
  assert.equal(
    readUint32LE(socket.frames(F.ACK)[0].payload, 16),
    0,
    "barrier must not duplicate the initial receive grant",
  );
  for (const ack of socket.frames(F.ACK).slice(1))
    assert.equal(
      readUint32LE(ack.payload, 16),
      128,
      "return exactly the native resize-event credit charge",
    );
  assert.equal(socket.frames(F.PING).length, count);
  assert.equal(h.transport.state.unmatchedPongs, 14);
  await h.clock.advance(999);
  assert.equal(socket.closeCalls, 0);
  await h.clock.advance(1);
  assert.equal(socket.closeCalls, 1);
  assert.equal(h.transport.state.lastOutcome.kind, "response-unavailable");
  assert.equal(h.errors.length, 0);
});

test("healthy burst/jitter traffic keeps paced probes and FIFO without disconnects", async (t) => {
  const h = harness(t),
    socket = await healthy(h);
  for (const delay of [40, 110, 600, 1600, 35, 8000, 50, 3000]) {
    await h.clock.advance(PROFILE.probeIntervalMs);
    for (let i = 0; i < 200; i++) socket.frame(F.SESSION_CHANGED, new Uint8Array(8));
    await pong(h, delay, socket);
    assert.equal(socket.closeCalls, 0);
    assert.equal(h.transport.state.status, "ready");
  }
  assert.equal(socket.closeCalls, 0);
  assert.ok(h.sockets.slice(1).every((candidate) => candidate.closeCalls === 1));
  assert.equal(h.errors.length, 0);
  socket.sent.forEach((frame, i) => assert.equal(frame.connectionSequence, BigInt(i + 1)));
});

test("control submission stalls retire after their fixed window, never from RTT", async (t) => {
  const h = harness(t),
    socket = await healthy(h);
  socket.bufferedAmount = 4 * 1024 * 1024;
  await h.clock.advance(PROFILE.probeIntervalMs);
  const count = socket.frames(F.PING).length;
  await h.clock.advance(PROFILE.controlSubmitMs - 1);
  assert.equal(socket.closeCalls, 0);
  assert.equal(socket.frames(F.PING).length, count);
  await h.clock.advance(1);
  assert.equal(socket.closeCalls, 1);
  assert.equal(h.transport.state.lastOutcome.kind, "local-control-stall");
  assert.equal(h.errors.length, 0);
});

test("pressure released before submission expiry grants full response opportunity", async (t) => {
  const h = harness(t),
    socket = await healthy(h);
  socket.bufferedAmount = 4 * 1024 * 1024;
  await h.clock.advance(PROFILE.probeIntervalMs);
  await h.clock.advance(4000);
  socket.bufferedAmount = 0;
  await h.clock.advance(100);
  const probe = socket.last(F.PING);
  await h.clock.advance(10000);
  assert.equal(socket.closeCalls, 0);
  socket.frame(F.PONG, probe.payload, { requestId: probe.requestId });
  assert.equal(h.transport.state.wsRttLatestMs, 10000);
  assert.equal(h.errors.length, 0);
});

test("fatal ERROR bypasses delayed restore, fences late work, and retries attachment", async (t) => {
  const h = harness(t),
    socket = await healthy(h),
    core = new Core();
  let resolveCore,
    coreCalls = 0;
  h.transport.activate({
    core,
    onResize: () => ({ dispose() {} }),
    onSelectionModeChange: () => ({ dispose() {} }),
    createCore: () =>
      ++coreCalls === 1
        ? new Promise((resolve) => {
            resolveCore = resolve;
          })
        : new Core(),
  });
  const attached = h.transport.attach(metadata, core, { eventSeq: 7 });
  await flush();
  const attach = await begin(socket, 1);
  socket.frame(F.LIVE_BARRIER, new Uint8Array(16), attachmentFields(attach));
  socket.frame(F.PING, new Uint8Array(8));
  assert.equal(socket.frames(F.PONG).length, 1, "PING bypasses restore too");
  socket.frame(F.ERROR, fatalPayload());
  assert.equal(
    h.transport.state.status,
    "backoff",
    "protocol failure schedules retry before callback returns",
  );
  assert.equal(h.errors.length, 1);
  socket.closed();
  const late = new Core();
  resolveCore(late);
  await flush();
  assert.equal(late.disposed, 1);
  assert.equal(core.disposed, 0);
  assert.equal(socket.frames(F.ACK).length, 0);
  assert.equal(h.transport.state.queuedApplicationBytes, 0);
  h.window.emit("online");
  await h.clock.advance(PROFILE.retryFloorMs);
  const replacement = await welcome(h);
  const resumed = await begin(replacement, 2, true);
  await live(replacement, resumed);
  await attached;
  assert.equal(h.transport.state.status, "ready");
});

test("fatal negotiation and malformed ERROR retry without granting peer authority", async (t) => {
  const h = harness(t);
  const first = h.transport.connect(),
    second = h.transport.connect();
  const socket = h.sockets[0];
  socket.open();
  socket.frame(F.ERROR, fatalPayload(), { requestId: socket.last(F.HELLO).requestId });
  socket.closed();
  assert.equal(h.errors.length, 1);
  assert.equal(h.transport.state.status, "backoff");
  await h.clock.advance(PROFILE.retryFloorMs);
  await welcome(h);
  await first;
  await second;
  for (const kind of ["flag", "code", "scope", "context", "utf8"]) {
    const k = harness(t),
      old = await healthy(k),
      payload = fatalPayload("peer diagnostic"),
      fields = {};
    if (kind === "flag") payload[2] = 2;
    if (kind === "code") payload[0] = 99;
    if (kind === "scope") fields.attachmentEpoch = 1n;
    if (kind === "context") fields.requestId = 1n;
    if (kind === "utf8") payload[4] = 255;
    old.frame(F.ERROR, payload, fields);
    await flush();
    assert.equal(k.errors.length, 1);
    assert.notEqual(k.errors[0].message, "peer diagnostic");
    assert.equal(k.transport.state.status, "backoff");
    old.closed();
    await k.clock.advance(PROFILE.retryFloorMs);
    await welcome(k);
    assert.equal(k.sockets.length, 2);
  }
});

test("nonfatal attachment ERROR remains ordered behind restore", async (t) => {
  const h = harness(t),
    socket = await healthy(h),
    core = new Core();
  let resolveCore;
  h.transport.activate({
    core,
    onResize: () => ({ dispose() {} }),
    onSelectionModeChange: () => ({ dispose() {} }),
    createCore: () =>
      new Promise((resolve) => {
        resolveCore = resolve;
      }),
  });
  const attached = h.transport.attach(metadata, core);
  const rejected = assert.rejects(attached, /operation failed/);
  await flush();
  const attach = await begin(socket, 1);
  const payload = fatalPayload("operation failed");
  payload[2] = 0;
  socket.frame(F.ERROR, payload, attachmentFields(attach));
  assert.equal(h.errors.length, 0);
  assert.equal(socket.closeCalls, 0);
  resolveCore(new Core());
  await flush();
  await rejected;
  assert.equal(h.transport.state.connected, true);
  assert.equal(h.errors.length, 0, "operation's rejecting promise is its reporting owner");
});

test("resume invalidates old probes once; hints and pre-suspension PONG cannot renew", async (t) => {
  const h = harness(t),
    socket = await healthy(h);
  await h.clock.advance(PROFILE.probeIntervalMs);
  const old = socket.last(F.PING),
    samples = h.transport.state._rttSamples.length;
  h.document.hidden = true;
  h.document.emit("visibilitychange");
  h.clock.time += 60000;
  h.document.hidden = false;
  await h.clock.advance(0); // timer-before-visibility ordering
  const fresh = socket.last(F.PING);
  assert.notEqual(fresh.requestId, old.requestId);
  h.document.emit("visibilitychange");
  h.window.emit("online");
  assert.equal(socket.last(F.PING).requestId, fresh.requestId);
  socket.frame(F.PONG, old.payload, { requestId: old.requestId });
  assert.equal(h.transport.state._rttSamples.length, samples);
  await h.clock.advance(PROFILE.responseMs - 1);
  h.window.emit("online");
  h.document.emit("visibilitychange");
  assert.equal(socket.closeCalls, 0);
  await h.clock.advance(1);
  assert.equal(socket.closeCalls, 1);
  assert.equal(h.transport.state.lastOutcome.kind, "response-unavailable");
});

test("unannounced scheduling gap and visible freeze grant fresh observation, not timer backlog", async (t) => {
  const h = harness(t),
    socket = await healthy(h);
  await h.clock.advance(PROFILE.probeIntervalMs);
  const old = socket.last(F.PING);
  h.clock.time += 60000;
  socket.frame(F.PONG, old.payload, { requestId: old.requestId }); // message-before-timer ordering
  const fresh = socket.last(F.PING);
  assert.notEqual(fresh.requestId, old.requestId);
  h.window.emit("online");
  assert.equal(socket.last(F.PING).requestId, fresh.requestId);
  await h.clock.advance(0);
  await pong(h);
  h.document.emit("freeze");
  await h.clock.advance(30000);
  assert.equal(socket.closeCalls, 0);
  h.document.emit("resume");
  await pong(h, 500);
  assert.equal(h.transport.state.wsRttLatestMs, 500);
  assert.equal(h.errors.length, 0);
});

test("hidden cold negotiation receives a fresh HELLO window on actual resume", async (t) => {
  const h = harness(t);
  h.document.hidden = true;
  const ready = h.transport.connect(),
    socket = h.sockets[0];
  socket.open();
  await h.clock.advance(60000);
  assert.equal(socket.closeCalls, 0);
  h.document.hidden = false;
  h.document.emit("visibilitychange");
  await h.clock.advance(9000);
  h.window.emit("online");
  h.document.emit("visibilitychange");
  await welcome(h, socket, 500);
  await ready;
  assert.equal(h.transport.state.negotiationMs, null);
  await pong(h, 500);
  assert.equal(h.transport.state.wsRttLatestMs, 500);
  assert.equal(h.sockets.length, 1);
});

test("resume retires a socket that stopped being open and starts recovery immediately", async (t) => {
  const h = harness(t),
    socket = await healthy(h);
  h.document.hidden = true;
  h.document.emit("visibilitychange");
  socket.close();
  h.document.hidden = false;
  h.document.emit("visibilitychange");
  assert.equal(h.transport.state.connected, false);
  assert.equal(h.transport.state.lastOutcome.kind, "socket-unavailable");
  await h.clock.advance(PROFILE.retryFloorMs);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.transport.state.status, "connecting");
});

test("bounded receive queue is released on retirement while restore remains pending", async (t) => {
  const h = harness(t),
    socket = await healthy(h),
    core = new Core();
  let resolveCore;
  h.transport.activate({
    core,
    onResize: () => ({ dispose() {} }),
    onSelectionModeChange: () => ({ dispose() {} }),
    createCore: () =>
      new Promise((resolve) => {
        resolveCore = resolve;
      }),
  });
  const attached = h.transport.attach(metadata, core);
  attached.catch(() => {});
  await flush();
  const attach = await begin(socket, 1);
  const bytes = new Uint8Array(MAX_FRAME_LENGTH - 64);
  for (let i = 0; i < 70; i++) socket.frame(F.CHECKPOINT_CHUNK, bytes, attachmentFields(attach));
  assert.equal(socket.closeCalls, 1);
  assert.equal(h.transport.state.lastOutcome.kind, "receive-overload");
  assert.ok(h.transport.state.lastOutcome.queuedApplicationBytes <= 64 * 1024 * 1024);
  assert.equal(h.transport.state.queuedApplicationBytes, 0);
  const late = new Core();
  resolveCore(late);
  await flush();
  assert.equal(late.disposed, 1);
  assert.equal(socket.frames(F.ACK).length, 0);
  assert.equal(h.errors.length, 0);
});
