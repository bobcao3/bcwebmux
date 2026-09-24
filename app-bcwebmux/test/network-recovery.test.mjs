// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { test } from "node:test";
import { Journal, waitForRestoredController } from "./network-support.mjs";

const state = (connected, usable = connected) => ({ type: "state", state: { connected }, usable });
const start = journal => waitForRestoredController(journal, { after: 0, deadlineAt: performance.now() + 1000, ready: event => event.usable });

test("old suspect authority cannot trigger the one-shot recovery marker", async () => {
  const journal = new Journal();
  let markerAdmissions = 0;
  const waiting = start(journal).then(result => { markerAdmissions++; return result; });
  try {
    journal.add(state(true)); // path restored, old blackholed socket still admits input
    await Promise.resolve();
    assert.equal(markerAdmissions, 0);
    journal.add(state(false));
    journal.add({ type: "welcome", socketId: "new" });
    journal.add(state(false)); // WELCOME is not yet attachment/controller readiness
    const ready = journal.add(state(true)); // renderer notification precedes CDP barrier receipt
    journal.add({ type: "live-barrier", socketId: "old" });
    await Promise.resolve();
    assert.equal(markerAdmissions, 0);
    journal.add({ type: "live-barrier", socketId: "new" });
    const recovered = await waiting;
    assert.equal(markerAdmissions, 1);
    assert.equal(recovered.controller, ready);
    assert.equal(recovered.welcome.socketId, "new");
    assert.equal(journal.waiters.size, 0);
  } finally { journal.close(); }
});

test("a failed intermediate attempt cannot satisfy a later recovery", async () => {
  const journal = new Journal();
  try {
    journal.add(state(false));
    journal.add({ type: "welcome", socketId: "failed" });
    journal.add(state(true));
    journal.add(state(false));
    journal.add({ type: "welcome", socketId: "working" });
    journal.add({ type: "live-barrier", socketId: "failed" });
    journal.add(state(true, false));
    journal.add({ type: "live-barrier", socketId: "working" });
    const ready = journal.add(state(true));
    const recovered = await start(journal);
    assert.equal(recovered.welcome.socketId, "working");
    assert.equal(recovered.controller, ready);
  } finally { journal.close(); }
});

test("recovery uses one absolute observation deadline and cleans waiters", async () => {
  const journal = new Journal();
  try {
    journal.add(state(true));
    await assert.rejects(waitForRestoredController(journal, { after: 0, deadlineAt: performance.now() + 5, ready: event => event.usable }), /deadline exceeded/);
    assert.equal(journal.waiters.size, 0);
    await assert.rejects(waitForRestoredController(journal, { after: 0, deadlineAt: performance.now() - 1, ready: () => true }), /deadline exceeded/);
  } finally { journal.close(); }
});
