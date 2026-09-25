// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const SAMPLE_WINDOW_MS = 100;
const MOMENTUM_DECAY_MS = 325;
const MINIMUM_MOMENTUM_PX_PER_MS = 0.02;
const MAXIMUM_MOMENTUM_PX_PER_MS = 4;

function now() {
  return performance.now();
}

/** Converts wheel and touch gestures into whole-row input without owning viewport state. */
export class ScrollGestureController {
  constructor(options) {
    this.getCellHeight = options.getCellHeight;
    this.getPageSize = options.getPageSize;
    this.onRows = options.onRows;
    this.shouldStopMomentum = options.shouldStopMomentum || (() => false);
    this.rowRemainder = 0;
    this.touchActive = false;
    this.touchSamples = [];
    this.momentumFrame = null;
    this.momentumVelocity = 0;
    this.momentumContext = null;
    this.momentumTime = 0;
    this.momentumRoute = null;
  }

  _consumeRows(rows, context) {
    if (!Number.isFinite(rows) || rows === 0) return false;
    this.rowRemainder += rows;
    const wholeRows = Math.trunc(this.rowRemainder);
    if (wholeRows === 0) return true;
    this.rowRemainder -= wholeRows;
    const route = this.onRows(wholeRows, context);
    if (this.momentumFrame !== null) this.momentumRoute = route;
    if (this.momentumFrame !== null && this.shouldStopMomentum(wholeRows, route)) {
      this.cancelMomentum();
    }
    return route !== 0;
  }

  wheel(event, context) {
    if (!event || !Number.isFinite(event.deltaY) || event.deltaY === 0) return false;
    this.cancelMomentum();
    if (event.deltaMode === 1) return this._consumeRows(event.deltaY, context);
    if (event.deltaMode === 2) {
      return this._consumeRows(event.deltaY * Math.max(1, this.getPageSize()), context);
    }
    return this._consumeRows(event.deltaY / Math.max(1, this.getCellHeight()), context);
  }

  beginTouch(y, time = now()) {
    this.cancelMomentum();
    this.touchActive = true;
    this.touchSamples.length = 0;
    this.touchSamples.push({ time, y });
  }

  moveTouch(y, context, time = now()) {
    if (!this.touchActive || !Number.isFinite(y)) return false;
    const previous = this.touchSamples[this.touchSamples.length - 1];
    this._recordTouch(y, time);
    if (!previous) return false;
    return this._consumeRows((previous.y - y) / Math.max(1, this.getCellHeight()), context);
  }

  endTouch(y, context, time = now()) {
    if (!this.touchActive) return false;
    this._recordTouch(y, time);
    this.touchActive = false;
    const samples = this.touchSamples;
    this.touchSamples = [];
    if (samples.length < 2 || globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      return false;
    }
    const first = samples[0];
    const last = samples[samples.length - 1];
    const elapsed = last.time - first.time;
    if (!(elapsed >= 8)) return false;
    const velocity = Math.max(
      -MAXIMUM_MOMENTUM_PX_PER_MS,
      Math.min(MAXIMUM_MOMENTUM_PX_PER_MS, (first.y - last.y) / elapsed),
    );
    if (Math.abs(velocity) < MINIMUM_MOMENTUM_PX_PER_MS) return false;
    this.momentumVelocity = velocity;
    this.momentumContext = context;
    this.momentumTime = time;
    this.momentumFrame = requestAnimationFrame((frameTime) => this._tickMomentum(frameTime));
    return true;
  }

  cancelTouch() {
    this.touchActive = false;
    this.touchSamples.length = 0;
  }

  cancelMomentum() {
    if (this.momentumFrame !== null) cancelAnimationFrame(this.momentumFrame);
    this.momentumFrame = null;
    this.momentumVelocity = 0;
    this.momentumContext = null;
    this.momentumTime = 0;
    this.momentumRoute = null;
  }

  viewportChanged(mode) {
    if (this.momentumRoute !== 1) return;
    if (
      (this.momentumVelocity < 0 && mode === "top") ||
      (this.momentumVelocity > 0 && mode === "active")
    ) {
      this.cancelMomentum();
    }
  }

  cancel() {
    this.cancelTouch();
    this.cancelMomentum();
  }

  _recordTouch(y, time) {
    const samples = this.touchSamples;
    const normalizedTime = Number.isFinite(time) ? time : now();
    samples.push({ time: normalizedTime, y });
    const cutoff = normalizedTime - SAMPLE_WINDOW_MS;
    while (samples.length > 2 && samples[1].time < cutoff) samples.shift();
  }

  _tickMomentum(frameTime) {
    if (this.momentumFrame === null) return;
    const rawElapsed = Math.max(0, frameTime - this.momentumTime);
    const elapsed = Math.min(34, rawElapsed);
    this.momentumTime = frameTime;
    if (elapsed > 0) {
      this._consumeRows(
        (this.momentumVelocity * elapsed) / Math.max(1, this.getCellHeight()),
        this.momentumContext,
      );
      if (this.momentumFrame === null) return;
      this.momentumVelocity *= Math.exp(-rawElapsed / MOMENTUM_DECAY_MS);
    }
    if (Math.abs(this.momentumVelocity) < MINIMUM_MOMENTUM_PX_PER_MS) {
      this.cancelMomentum();
      return;
    }
    this.momentumFrame = requestAnimationFrame((nextTime) => this._tickMomentum(nextTime));
  }

  dispose() {
    this.cancel();
  }
}
