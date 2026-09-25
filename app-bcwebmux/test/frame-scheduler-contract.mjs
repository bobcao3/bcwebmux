// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { FrameScheduler } from "../../wgpuTerminal/src/browser/FrameScheduler.js";

let now = 120;
let id = 0;
const frames = new Map(),
  timers = new Map();
const document = { hidden: false };
let consumed = 0,
  presented = 0,
  blinking = false;
const host = {
  _renderer: { presentationOpportunityMs: null },
  _renderFrame() {
    consumed++;
    return 1;
  },
  _presenter: {
    present() {
      presented++;
    },
    nextAnimationDeadline(time) {
      return blinking ? (Math.floor(time / 500) + 1) * 500 : null;
    },
  },
};
const scheduler = new FrameScheduler(host, {
  now: () => now,
  document,
  requestAnimationFrame(fn) {
    frames.set(++id, fn);
    return id;
  },
  cancelAnimationFrame(key) {
    frames.delete(key);
  },
  setTimeout(fn, delay) {
    timers.set(++id, { fn, at: now + delay });
    return id;
  },
  clearTimeout(key) {
    timers.delete(key);
  },
});
function frame() {
  assert.equal(frames.size, 1);
  const [key, fn] = frames.entries().next().value;
  frames.delete(key);
  fn();
}
assert.equal(frames.size + timers.size, 0, "idle has no wakeups");
scheduler.requestPresentation();
scheduler.requestPresentation();
frame();
assert.equal(consumed, 0);
assert.equal(presented, 1);
assert.equal(
  host._renderer.presentationOpportunityMs,
  0,
  "scheduler owns presentation-opportunity sampling",
);
scheduler.schedule();
scheduler.schedule();
scheduler.requestPresentation();
frame();
assert.equal(consumed, 1);
assert.equal(presented, 2);
assert.equal(frames.size + timers.size, 0);
// A prior submission consumes the immediate budget until the next display opportunity.
scheduler.schedule(true);
scheduler.schedule(true);
assert.equal(consumed, 1);
frame();
assert.equal(consumed, 2);
scheduler.suspend();
scheduler.resume();
frame();
scheduler.suspend();
scheduler.resume();
// Cancelled opportunity resets the immediate budget, still with only one pending callback.
scheduler.schedule(true);
scheduler.schedule(true);
assert.equal(frames.size, 1);
frame();
blinking = true;
scheduler.requestPresentation();
frame();
assert.equal(timers.size, 1);
const [key, timer] = timers.entries().next().value;
assert.equal(timer.at, 500);
now = 500;
timers.delete(key);
timer.fn();
const before = consumed;
frame();
assert.equal(consumed, before, "blink does not consume core");
assert.equal(timers.values().next().value.at, 1000);
document.hidden = true;
scheduler.suspend();
assert.equal(frames.size + timers.size, 0);
scheduler.schedule();
scheduler.requestPresentation();
assert.equal(frames.size + timers.size, 0);
document.hidden = false;
scheduler.resume();
frame();
assert.equal(consumed, before + 1);
host._renderer.error = "device lost";
scheduler.requestPresentation();
assert.equal(frames.size + timers.size, 0, "errors cancel pending animation");
assert.equal(scheduler.presentationDirty, true);
host._renderer.error = null;
scheduler.resume();
frame();
scheduler.dispose();
assert.equal(frames.size + timers.size, 0);
scheduler.schedule(true);
scheduler.resume();
scheduler.requestPresentation();
assert.equal(frames.size + timers.size, 0);
console.log("frame scheduler contract passed");
