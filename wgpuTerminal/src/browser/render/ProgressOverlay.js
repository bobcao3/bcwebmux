// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { packedColor } from "../../TerminalOptions.js";

const STATES = new Set(["idle", "working", "done", "blocked", "error"]);
const BELL_HOLD_MS = 80;
const BELL_FADE_MS = 100;
const BELL_DECAY_SCALE_MS = 10;

export class ProgressOverlay {
  constructor() {
    this.status = null;
    this.bell = false;
    this.bellStartedAt = 0;
    this.bellColor = [0, 0, 0];
    this.startedAt = 0;
    this.reducedMotion = false;
    this.lastPresentedAt = null;
    this.data = new Float32Array(16);
  }

  get visible() {
    return this.bell || (this.status !== null && this.status.state !== "idle");
  }

  get animated() {
    return this.status?.state === "working" && !this.status.paused && !this.reducedMotion;
  }

  setBell(active, color) {
    if (typeof active !== "boolean") throw new TypeError("invalid progress bell state");
    if (!active && !this.bell) return false;
    if (active) {
      const rgb = packedColor(color);
      this.bellColor = [16, 8, 0].map((shift) => ((rgb >>> shift) & 255) / 255);
      this.bellStartedAt = performance.now();
    }
    this.bell = active;
    return true;
  }

  bellOpacity(now) {
    if (!this.bell) return 0;
    const elapsed = Math.max(0, now - this.bellStartedAt - BELL_HOLD_MS);
    if (elapsed >= BELL_FADE_MS) return 0;
    const cutoff = 1 / Math.sqrt(1 + BELL_FADE_MS / BELL_DECAY_SCALE_MS);
    return (1 / Math.sqrt(1 + elapsed / BELL_DECAY_SCALE_MS) - cutoff) / (1 - cutoff);
  }

  advance(now) {
    if (this.bell && now - this.bellStartedAt >= BELL_HOLD_MS + BELL_FADE_MS) this.bell = false;
  }

  set(status) {
    let next = null;
    if (status !== null) {
      if (!status || !STATES.has(status.state)) throw new TypeError("invalid progress state");
      const progress = status.progress ?? null;
      if (progress !== null && (!Number.isInteger(progress) || progress < 0 || progress > 100))
        throw new TypeError("invalid progress percentage");
      if (status.paused !== undefined && typeof status.paused !== "boolean")
        throw new TypeError("invalid progress pause state");
      next = Object.freeze({
        state: status.state,
        progress: status.state === "done" ? 100 : progress,
        paused: status.paused ?? false,
      });
    }
    const previous = this.status;
    if (
      previous?.state === next?.state &&
      previous?.progress === next?.progress &&
      previous?.paused === next?.paused
    )
      return false;
    if (
      previous?.state !== next?.state ||
      (previous?.progress === null) !== (next?.progress === null) ||
      previous?.paused !== next?.paused
    ) {
      this.startedAt = performance.now();
      this.lastPresentedAt = null;
    }
    this.status = next;
    return true;
  }

  uniforms(now, renderer) {
    const interval = this.lastPresentedAt === null ? 1 / 60 : (now - this.lastPresentedAt) / 1000;
    const shutter = this.animated ? 0.5 * Math.max(0, interval) : 0;
    this.lastPresentedAt = this.animated ? now : null;
    const blockWidth = Math.max(1, Math.round(2 * renderer.pixelScaleX));
    const blockHeight = Math.max(1, Math.round(2 * renderer.pixelScaleY));
    const barHeight =
      2 *
      blockHeight *
      Math.max(1, Math.round((0.2 * renderer.physicalCellHeight) / (2 * blockHeight)));
    this.data.set([
      renderer.canvas.width,
      renderer.canvas.height,
      blockWidth,
      blockHeight,
      this.status?.progress == null ? -1 : this.status.progress / 100,
      Math.max(0, (now - this.startedAt) / 1000) % 120,
      this.animated ? 1 : 0,
      shutter,
      barHeight,
      this.status?.state === "done" ? 1 : 0,
      this.bellOpacity(now),
      this.status !== null && this.status.state !== "idle" ? 1 : 0,
      ...this.bellColor,
      0,
    ]);
    return this.data;
  }
}
