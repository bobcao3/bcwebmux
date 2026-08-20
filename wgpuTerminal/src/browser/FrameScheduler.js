// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

export class FrameScheduler {
  constructor(terminal) {
    this._terminal = terminal;
    this._pending = false;
    this._dirty = false;
    this._submittedSinceAnimationFrame = false;
    this._disposed = false;
  }

  schedule(immediate = false) {
    if (this._disposed) return;
    this._dirty = true;
    if (document.hidden) return;
    if (immediate && !this._submittedSinceAnimationFrame) {
      this._renderNow();
      this._submittedSinceAnimationFrame = true;
    }
    this._requestDisplayFrame();
  }

  resume() {
    if (!this._disposed && this._dirty) this._requestDisplayFrame();
  }

  dispose() {
    this._disposed = true;
    this._dirty = false;
    this._terminal = null;
  }

  _renderNow() {
    this._dirty = false;
    this._terminal._renderFrame();
  }

  _requestDisplayFrame() {
    if (this._disposed || document.hidden || this._pending) return;
    this._pending = true;
    requestAnimationFrame(() => {
      this._pending = false;
      this._submittedSinceAnimationFrame = false;
      if (this._disposed || document.hidden || !this._dirty) return;
      this._renderNow();
      this._submittedSinceAnimationFrame = true;
      requestAnimationFrame(() => {
        this._submittedSinceAnimationFrame = false;
      });
    });
  }
}
