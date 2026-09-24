// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { SessionController } from "../web/SessionController.js";

function metadata(id, revision = 1, name = id) {
  return {
    id,
    generation: `generation-${id}`,
    name,
    title: "",
    state: "running",
    createdAtMs: revision,
    lastActivityMs: revision,
    geometry: { cols: 80, rows: 24, cellWidthPx: 8, cellHeightPx: 16 },
    attachments: 0,
    controller: null,
    exitStatus: null,
    eventSeq: 0,
    outputOffset: 0,
    checkpointEventSeq: 0,
    checkpointBytes: 0,
    revision,
  };
}

class MockCore {
  constructor(owner, id) {
    this.owner = owner;
    this.id = id;
    this.disposed = false;
    owner.live.add(this);
    owner.maxLive = Math.max(owner.maxLive, owner.live.size);
  }

  onTitleChange() { return disposable(); }
  onBell() { return disposable(); }
  onNotification() { return disposable(); }
  onError() { return disposable(); }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.owner.live.delete(this);
  }
}

class MockTerminal {
  constructor() {
    this.live = new Set();
    this.maxLive = 0;
    this.nextCore = 1;
    this.core = new MockCore(this, "host");
    this.cols = 80;
    this.rows = 24;
    this.state = { cols: 80, rows: 24, physicalCellWidth: 8, physicalCellHeight: 16 };
    this.failAttachCore = false;
  }

  async createCore() { return new MockCore(this, `core-${this.nextCore++}`); }
  attachCore(core) {
    if (this.failAttachCore) {
      this.failAttachCore = false;
      throw new Error("injected renderer handoff failure");
    }
    this.core = core;
  }
  commitComposition() {}
  suspendFocus() {}
  resumeFocus() {}
}

class MockTransport {
  constructor() {
    this.state = { connected: true, serverInstance: "contract-server" };
    this.failAttach = false;
    this.active = null;
    this.lastAttachOptions = null;
    this.statusListeners = new Set();
    this.errorListeners = new Set();
    this.attachmentListeners = new Set();
  }

  onStatus(listener) { this.statusListeners.add(listener); return { dispose: () => this.statusListeners.delete(listener) }; }
  onError(listener) { this.errorListeners.add(listener); return { dispose: () => this.errorListeners.delete(listener) }; }
  onAttachmentChanged(listener) { this.attachmentListeners.add(listener); return { dispose: () => this.attachmentListeners.delete(listener) }; }
  emitStatus(label = "ready") {
    this.state.status = label;
    for (const listener of [...this.statusListeners]) listener(label, this.state);
  }
  emitAttachment(record) { for (const listener of [...this.attachmentListeners]) listener(record, this.state); }
  onSessionChanged() { return disposable(); }
  activate() {}
  async connect() {}

  async attach(session, core, options = {}) {
    this.lastAttachOptions = { ...options };
    if (this.failAttach) {
      this.failAttach = false;
      throw new Error("injected attachment failure");
    }
    return {
      active: true,
      live: true,
      controller: true,
      metadata: session,
      core,
      eventSeq: BigInt(session.eventSeq ?? 0),
      outputOffset: BigInt(session.outputOffset ?? 0),
    };
  }

  setActive(record) { this.active = record; }
  detach(record) { record.active = false; if (this.active === record) this.active = null; }
  claimControl() { return true; }
}

class MockApi {
  constructor(values) {
    this.values = new Map(values.map(value => [value.id, { ...value, geometry: { ...value.geometry } }]));
    this.revision = Math.max(1, ...values.map(value => Number(value.revision ?? 0)));
    this.serverInstance = "contract-server";
    this.listOverride = null;
    this.renameOverride = null;
    this.nextId = values.length + 1;
    this.lastCreateOptions = null;
  }

  async info() { return { protocol: "bcw.sessions", serverInstance: this.serverInstance, principal: "contract-user" }; }
  async list() {
    if (this.listOverride) return this.listOverride();
    return { revision: this.revision, sessions: [...this.values.values()].map(value => ({ ...value, geometry: { ...value.geometry }, revision: this.revision })) };
  }
  async get(id) { return this.values.get(id); }
  async create(options) {
    if (this.failCreate) throw new Error("injected session creation failure");
    this.lastCreateOptions = { ...options };
    this.revision += 1;
    const value = metadata(`session-${this.nextId++}`, this.revision, options.name ?? "");
    this.values.set(value.id, value);
    return { ...value };
  }
  async rename(id, name) {
    if (this.renameOverride) return this.renameOverride(id, name);
    this.revision += 1;
    const value = { ...this.values.get(id), name, revision: this.revision };
    this.values.set(id, value);
    return { ...value };
  }
  async terminate(id) { return this.values.get(id); }
  async delete(id) { this.values.delete(id); }
}

function disposable() { return { dispose() {} }; }

function waitForController(controller, condition) {
  return new Promise((resolve, reject) => {
    let listener;
    const timeout = setTimeout(() => { listener.dispose(); reject(new Error("controller transition did not complete")); }, 5000);
    const check = () => {
      if (!condition()) return;
      clearTimeout(timeout);
      listener.dispose();
      resolve();
    };
    listener = controller.onChange(check);
    check();
  });
}

async function harness(values, coreLimit = 4) {
  const terminal = new MockTerminal();
  const transport = new MockTransport();
  const api = new MockApi(values);
  const controller = new SessionController({ terminal, transport, api, coreLimit, storage: null });
  await controller.start();
  return { controller, terminal, transport, api };
}

{
  const { controller, terminal } = await harness([metadata("a")]);
  for (const name of ["b", "c", "d", "e"]) await controller.create({ name });
  assert.ok(terminal.maxLive <= 4, `transient live core count reached ${terminal.maxLive}`);
  assert.ok(controller.coreCount <= 4);
  controller.dispose();
}

{
  const { controller, api } = await harness([]);
  const session = await controller.create({});
  assert.equal(session.name, "");
  assert.equal(api.lastCreateOptions.name, "");
  controller.dispose();
}

{
  const { controller, terminal, transport } = await harness([metadata("a"), metadata("b")]);
  const oldCore = terminal.core;
  terminal.failAttachCore = true;
  await assert.rejects(controller.switchTo("b"), /injected renderer handoff failure/);
  assert.equal(transport.lastAttachOptions.preserveCore, false);
  assert.equal(controller.activeSessionId, "a");
  assert.equal(controller.activeCore, oldCore);
  assert.equal(controller.coreCount, 1);
  assert.equal(oldCore.disposed, false);
  controller.dispose();
}

{
  const { controller, terminal, transport } = await harness([metadata("a"), metadata("b")]);
  const oldAttachment = controller.activeAttachment;
  const oldCore = controller.activeCore;
  oldAttachment.live = false;
  terminal.failAttachCore = true;
  await assert.rejects(controller.switchTo("b"), /injected renderer handoff failure/);
  assert.equal(controller.activeSessionId, "a");
  assert.equal(controller.activeCore, oldCore);
  assert.equal(transport.active, oldAttachment);
  controller.dispose();
}

{
  const { controller, transport } = await harness([metadata("a")]);
  const retainedCore = controller.activeCore;
  controller.activeAttachment.active = false;
  transport.failAttach = true;
  await assert.rejects(controller.switchTo("a"), /injected attachment failure/);
  assert.equal(transport.lastAttachOptions.preserveCore, true);
  assert.equal(controller.activeSessionId, "a");
  assert.equal(controller.activeCore, retainedCore);
  assert.equal(retainedCore.disposed, false);
  assert.equal(controller.activeAttachment, null);
  controller.dispose();
}

{
  const { controller, api } = await harness([metadata("a")]);
  const events = [];
  const subscription = controller.onChange(event => events.push(event.type));
  await controller.refresh();
  assert.deepEqual(events, []);
  api.values.set("a", { ...api.values.get("a"), name: "Changed" });
  api.revision += 1;
  await controller.refresh();
  subscription.dispose();
  assert.deepEqual(events, ["list"]);
  controller.dispose();
}

{
  const { controller, api } = await harness([metadata("a", 1, "Original")]);
  let releaseList;
  api.listOverride = () => new Promise(resolve => { releaseList = resolve; });
  const delayedRefresh = controller.refresh();
  await Promise.resolve();
  const renamed = await controller.rename("a", "Current");
  assert.equal(renamed.name, "Current");
  releaseList({ revision: 2, sessions: [metadata("a", 2, "Original")] });
  await delayedRefresh;
  assert.equal(controller.get("a").name, "Current");

  api.renameOverride = async () => metadata("a", 1, "Stale mutation");
  await controller.rename("a", "ignored");
  assert.equal(controller.get("a").name, "Current");
  controller.dispose();
}

{
  const terminal = new MockTerminal();
  const transport = new MockTransport();
  const api = new MockApi([metadata("a")]);
  const failure = new Error("metadata temporarily unavailable");
  api.listOverride = async () => { throw failure; };
  const controller = new SessionController({ terminal, transport, api, storage: null });
  const errors = [];
  controller.onError(error => errors.push(error));
  const first = controller.start();
  assert.equal(controller.start(), first, "concurrent callers share startup");
  await assert.rejects(first, error => error === failure);
  assert.deepEqual(errors, [], "operation failure belongs to caller, not another emitter");
  assert.equal(controller.state.started, false);
  api.listOverride = null;
  await controller.start();
  assert.equal(controller.activeSessionId, "a", "failed startup may be explicitly retried");
  controller.dispose();
}

{
  const { controller, terminal, transport } = await harness([metadata("a"), metadata("b")]);
  const errors = [];
  controller.onError(error => errors.push(error));
  terminal.failAttachCore = true;
  await assert.rejects(controller.switchTo("b"), /renderer handoff failure/);
  assert.deepEqual(errors, [], "switch rollback does not also emit its caller-owned failure");
  const statusCount = transport.statusListeners.size;
  const errorCount = transport.errorListeners.size;
  controller.activeAttachment.live = false;
  const waiting = controller.switchTo("a");
  controller.activeAttachment.live = true;
  transport.emitAttachment(controller.activeAttachment);
  await waiting;
  assert.equal(transport.statusListeners.size, statusCount);
  assert.equal(transport.errorListeners.size, errorCount);
  controller.activeAttachment.live = false;
  const canceled = controller.switchTo("a");
  controller.dispose();
  await assert.rejects(canceled, /disposed/);
  assert.equal(transport.statusListeners.size, 0);
  assert.equal(transport.errorListeners.size, 0);
  assert.equal(transport.attachmentListeners.size, 0);
}

{
  const { controller, terminal } = await harness([metadata("a"), metadata("b")]);
  let entered, release;
  const creating = new Promise(resolve => { entered = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  terminal.createCore = async () => {
    entered();
    await delayed;
    return new MockCore(terminal, "late-core");
  };
  const switching = controller.switchTo("b");
  await creating;
  controller.dispose();
  release();
  await assert.rejects(switching, /core creation was canceled/);
  assert.equal(terminal.live.size, 0, "late owned core is disposed, not published after cancellation");
  assert.equal(controller.coreCount, 0);
}

{
  const { controller, terminal, transport } = await harness([metadata("a"), metadata("b")]);
  let entered;
  const attaching = new Promise(resolve => { entered = resolve; });
  let operationSignal;
  transport.attach = (_metadata, _core, options) => new Promise((_, reject) => {
    operationSignal = options.signal;
    operationSignal.addEventListener("abort", () => reject(operationSignal.reason), { once: true });
    entered();
  });
  const switching = controller.switchTo("b");
  await attaching;
  controller.dispose();
  await assert.rejects(switching, /attachment operation canceled/);
  assert.equal(operationSignal.aborted, true);
  assert.equal(terminal.live.size, 0);
  assert.equal(controller.coreCount, 0);
}

{
  const terminal = new MockTerminal();
  const transport = new MockTransport();
  transport.connect = ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const controller = new SessionController({ terminal, transport, api: new MockApi([metadata("a")]), storage: null });
  const starting = controller.start();
  controller.dispose();
  await assert.rejects(starting, /controller is disposed/);
  assert.equal(controller.coreCount, 0);
  assert.equal(controller.activeSessionId, null);
}


{
  const { controller, terminal, transport, api } = await harness([metadata("vanished", 90)]);
  const oldCore = controller.activeCore;
  let resolveOldList;
  api.listOverride = () => new Promise(resolve => { resolveOldList = resolve; });
  const oldRefresh = controller.refresh();
  assert.equal(typeof resolveOldList, "function");
  api.listOverride = null;
  api.values.clear();
  api.values.set("replacement", metadata("replacement", 1));
  api.revision = 1;
  api.serverInstance = transport.state.serverInstance = "replacement-server";
  const recovered = waitForController(controller, () => controller.activeSessionId === "replacement" && controller.get("vanished") === null);
  transport.emitStatus("ready");
  await recovered;
  assert.equal(controller.get("vanished"), null);
  assert.equal(oldCore.disposed, true);
  assert.equal(controller.coreCount, 1);
  assert.equal(terminal.core, controller.activeCore);
  assert.ok(controller.storageKey.includes("replacement-server"));
  resolveOldList({ revision: 91, sessions: [metadata("vanished", 91)] });
  await oldRefresh;
  assert.equal(controller.get("vanished"), null, "old in-flight list restored a vanished session");
  controller.dispose();
}

{
  const { controller, transport, api } = await harness([metadata("vanished", 90)]);
  api.values.clear();
  api.revision = 1;
  api.serverInstance = transport.state.serverInstance = "empty-new-server";
  const recovered = waitForController(controller, () => controller.activeSessionId !== "vanished" && controller.activeSessionId != null && controller.get("vanished") === null);
  transport.emitStatus("ready");
  await recovered;
  assert.equal(controller.get("vanished"), null);
  assert.ok(api.values.has(controller.activeSessionId));
  controller.dispose();
}

{
  const { controller, transport, api } = await harness([metadata("vanished", 90)]);
  api.values.clear();
  api.revision = 1;
  api.failCreate = true;
  api.serverInstance = transport.state.serverInstance = "empty-unavailable-server";
  const cleared = waitForController(controller, () => controller.get("vanished") === null && controller.activeSessionId === null);
  transport.emitStatus("ready");
  await cleared;
  api.failCreate = false;
  const recovered = await controller.create();
  assert.equal(controller.activeSessionId, recovered.id);
  await controller.refresh();
  assert.equal(controller.get("vanished"), null);
  controller.dispose();
}

console.log(JSON.stringify({ sessionControllerContract: "ok" }));
