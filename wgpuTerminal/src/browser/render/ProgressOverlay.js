// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const STATES = new Set(["idle", "working", "done", "blocked", "error"]);

export class ProgressOverlay {
  constructor() {
    this.status = null;
    this.startedAt = 0;
    this.reducedMotion = false;
    this.lastPresentedAt = null;
    this.data = new Float32Array(8);
  }

  get visible() {
    return this.status !== null && this.status.state !== "idle";
  }

  get animated() {
    return (
      this.visible && this.status.state === "working" && !this.status.paused && !this.reducedMotion
    );
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
    this.data.set([
      renderer.canvas.width,
      renderer.canvas.height,
      renderer.physicalCellWidth,
      renderer.physicalCellHeight,
      this.status?.progress == null ? -1 : this.status.progress / 100,
      Math.max(0, (now - this.startedAt) / 1000) % 120,
      this.animated ? 1 : 0,
      shutter,
    ]);
    return this.data;
  }
}
