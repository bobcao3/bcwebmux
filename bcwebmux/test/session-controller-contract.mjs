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
    this.state = { connected: true };
    this.failAttach = false;
    this.active = null;
    this.lastAttachOptions = null;
  }

  onStatus() { return disposable(); }
  onError() { return disposable(); }
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
    this.listOverride = null;
    this.renameOverride = null;
    this.nextId = values.length + 1;
  }

  async info() { return { protocol: "bcw.sessions", serverInstance: "contract-server", principal: "contract-user" }; }
  async list() {
    if (this.listOverride) return this.listOverride();
    return { revision: this.revision, sessions: [...this.values.values()].map(value => ({ ...value, geometry: { ...value.geometry }, revision: this.revision })) };
  }
  async get(id) { return this.values.get(id); }
  async create(options) {
    this.revision += 1;
    const value = metadata(`session-${this.nextId++}`, this.revision, options.name ?? "Shell");
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

console.log(JSON.stringify({ sessionControllerContract: "ok" }));
