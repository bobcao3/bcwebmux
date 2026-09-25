// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

export class FrameScheduler {
  constructor(terminal, options = {}) {
    this._terminal = terminal;
    this._now = options.now ?? (() => performance.now());
    this._raf = options.requestAnimationFrame ?? ((fn) => requestAnimationFrame(fn));
    this._cancelRaf = options.cancelAnimationFrame ?? ((id) => cancelAnimationFrame(id));
    this._setTimeout = options.setTimeout ?? ((fn, delay) => setTimeout(fn, delay));
    this._clearTimeout = options.clearTimeout ?? ((id) => clearTimeout(id));
    this._document = options.document ?? document;
    this.coreDirty = false;
    this.presentationDirty = false;
    this._frame = null;
    this._requestedAt = null;
    this._deadline = null;
    this._submitted = false;
    this._submittedAt = -Infinity;
    this._suspended = false;
    this._disposed = false;
  }

  get blocked() {
    return (
      this._disposed ||
      this._suspended ||
      this._document.hidden ||
      this._terminal?._opened === false ||
      this._terminal?._recovering ||
      this._terminal?._renderer?.error
    );
  }

  schedule(immediate = false) {
    if (this._disposed) return;
    this.coreDirty = true;
    if (this.blocked) {
      this._cancel();
      return;
    }
    if (immediate && (!this._submitted || this._now() - this._submittedAt >= 1000 / 60))
      this._flush();
    this._request();
  }

  requestPresentation() {
    if (this._disposed) return;
    this.presentationDirty = true;
    if (this.blocked) {
      this._cancel();
      return;
    }
    this._request();
  }

  // Attach transactions need synchronous validation, but still share presentation authority.
  flushImmediate() {
    this.coreDirty = true;
    if (this._terminal?._recovering) throw new Error("renderer recovery in progress");
    if (this._disposed) return 0;
    if (this._document.hidden) {
      this._cancel();
      return 1;
    }
    this._suspended = false;
    const result = this._flush();
    this._request();
    return result;
  }

  suspend() {
    this._suspended = true;
    this._cancel();
  }
  recover() {
    if (this._disposed) return;
    this._suspended = false;
    this.schedule();
  }
  resume() {
    if (this._disposed) return;
    this._suspended = false;
    this.schedule();
  }
  dispose() {
    this._disposed = true;
    this._cancel();
    this._terminal = null;
  }

  _cancel() {
    if (this._frame !== null) this._cancelRaf(this._frame);
    if (this._deadline !== null) this._clearTimeout(this._deadline);
    this._frame = this._deadline = null;
    this._requestedAt = null;
    this._submitted = false;
  }

  _flush() {
    let result = 0;
    try {
      if (this.coreDirty) {
        this.coreDirty = false;
        result = this._terminal._renderFrame();
        this.presentationDirty = true;
      }
      if (this.blocked) {
        this.coreDirty = true;
        this._cancel();
        return result;
      }
      if (this.presentationDirty) {
        this.presentationDirty = false;
        this._terminal._presenter.present(this._now());
        this._submitted = true;
        this._submittedAt = this._now();
      }
      this._armDeadline();
      return result;
    } catch (error) {
      this.coreDirty = this.presentationDirty = true;
      this.suspend();
      throw error;
    }
  }

  _armDeadline() {
    if (this._deadline !== null) this._clearTimeout(this._deadline);
    this._deadline = null;
    if (this.blocked) return;
    const next = this._terminal._presenter.nextAnimationDeadline(this._now());
    if (next == null) return;
    this._deadline = this._setTimeout(
      () => {
        this._deadline = null;
        this.requestPresentation();
      },
      Math.max(0, next - this._now()),
    );
  }

  _request() {
    if (this.blocked || this._frame !== null) return;
    this._requestedAt = this._now();
    this._frame = this._raf(() => {
      const requestedAt = this._requestedAt;
      this._frame = null;
      this._requestedAt = null;
      this._submitted = false;
      if (this.blocked) {
        this._cancel();
        return;
      }
      const backend = this._terminal?._renderer;
      const opportunity = requestedAt === null ? null : Math.max(0, this._now() - requestedAt);
      if (backend && opportunity !== null && Number.isFinite(opportunity)) {
        backend.presentationOpportunityMs =
          backend.presentationOpportunityMs === null
            ? opportunity
            : backend.presentationOpportunityMs * 0.8 + opportunity * 0.2;
      }
      if (this.coreDirty || this.presentationDirty) this._flush();
    });
  }
}
