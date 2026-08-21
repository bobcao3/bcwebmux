// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const MINIMUM_THUMB_PX = 20;
const AUTOHIDE_DELAY_MS = 5000;

export class SemanticScrollbar {
  constructor(options) {
    this.element = options.element;
    this.thumb = options.thumb;
    this.onRow = options.onRow;
    this.onDelta = options.onDelta;
    this.onWheel = options.onWheel;
    this.onInteraction = options.onInteraction || (() => {});
    this.adjustment = null;
    this.drag = null;
    this.scrollable = false;
    this.autohideTimer = null;
    this.metrics = { track: 0, thumb: 0, travel: 0, top: 0 };
    this._listeners = [];
    this._installListeners();
  }

  _listen(type, listener, options) {
    this.element.addEventListener(type, listener, options);
    this._listeners.push(() => this.element.removeEventListener(type, listener, options));
  }

  render(adjustment = this.adjustment) {
    if (!adjustment) return;
    this.adjustment = adjustment;
    const maximum = adjustment.maximum;
    if (maximum > 0) this.element.hidden = false;
    const track = this.element.clientHeight;
    const scrollable = maximum > 0 && track > 0;
    this.element.hidden = !scrollable;
    this.element.setAttribute("aria-disabled", scrollable ? "false" : "true");
    this.element.setAttribute("aria-valuemin", "0");
    this.element.setAttribute("aria-valuemax", String(maximum));
    this.element.setAttribute("aria-valuenow", String(adjustment.value));
    this.element.setAttribute("aria-valuetext", `${adjustment.mode}, row ${adjustment.value} of ${maximum}`);
    if (!scrollable) {
      this._resetAutohide();
      this.metrics = { track, thumb: track, travel: 0, top: 0 };
      this.thumb.style.height = "100%";
      this.thumb.style.transform = "translateY(0)";
      return;
    }
    const becameScrollable = !this.scrollable;
    this.scrollable = true;
    if (becameScrollable) this.reveal();
    const ratio = adjustment.upper > 0 ? adjustment.pageSize / adjustment.upper : 1;
    const thumb = Math.min(track, Math.max(MINIMUM_THUMB_PX, track * ratio));
    const travel = Math.max(0, track - thumb);
    const top = travel * adjustment.value / maximum;
    this.metrics = { track, thumb, travel, top };
    this.thumb.style.height = `${thumb}px`;
    this.thumb.style.transform = `translateY(${top}px)`;
  }

  reveal() {
    this.element.removeAttribute("data-autohidden");
    if (this.scrollable) this._scheduleAutohide();
  }

  _scheduleAutohide() {
    clearTimeout(this.autohideTimer);
    this.autohideTimer = null;
    if (!this.scrollable) return;
    this.autohideTimer = setTimeout(() => {
      this.autohideTimer = null;
      if (this.drag || this.element.matches(":hover") || this.element.matches(":focus-within")) {
        this._scheduleAutohide();
        return;
      }
      this.element.setAttribute("data-autohidden", "true");
    }, AUTOHIDE_DELAY_MS);
  }

  _resetAutohide() {
    clearTimeout(this.autohideTimer);
    this.autohideTimer = null;
    this.element.removeAttribute("data-autohidden");
    this.scrollable = false;
  }

  _rowAt(clientY, grabOffset) {
    const adjustment = this.adjustment;
    if (!adjustment || adjustment.maximum === 0 || this.metrics.travel === 0) return 0;
    const rect = this.element.getBoundingClientRect();
    const thumbTop = Math.max(0, Math.min(this.metrics.travel, clientY - rect.top - grabOffset));
    return Math.round(thumbTop / this.metrics.travel * adjustment.maximum);
  }

  _installListeners() {
    this._listen("pointerdown", (event) => {
      this.reveal();
      if (event.button !== 0 || !this.adjustment || this.adjustment.maximum === 0) return;
      this.onInteraction();
      event.preventDefault();
      event.stopPropagation();
      const rect = this.element.getBoundingClientRect();
      if (event.target === this.thumb) {
        this.drag = {
          pointerId: event.pointerId,
          grabOffset: event.clientY - rect.top - this.metrics.top,
        };
        this.element.setPointerCapture(event.pointerId);
        return;
      }
      const position = event.clientY - rect.top;
      this.onDelta(position < this.metrics.top ? -this.adjustment.pageSize : this.adjustment.pageSize);
    }, { passive: false });

    this._listen("pointermove", (event) => {
      if (!this.drag || this.drag.pointerId !== event.pointerId) return;
      this.reveal();
      event.preventDefault();
      this.onRow(this._rowAt(event.clientY, this.drag.grabOffset));
    }, { passive: false });

    const finishDrag = (event) => {
      if (!this.drag || this.drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      this.onRow(this._rowAt(event.clientY, this.drag.grabOffset));
      this.drag = null;
      if (this.element.hasPointerCapture(event.pointerId)) {
        this.element.releasePointerCapture(event.pointerId);
      }
      this.reveal();
    };
    this._listen("pointerup", finishDrag, { passive: false });
    this._listen("pointercancel", (event) => {
      if (!this.drag || this.drag.pointerId !== event.pointerId) return;
      this.drag = null;
      this.reveal();
    });
    this._listen("lostpointercapture", () => {
      if (!this.drag) return;
      this.drag = null;
      this.reveal();
    });

    this._listen("wheel", (event) => {
      this.reveal();
      this.onInteraction();
      if (!this.onWheel(event)) return;
      event.preventDefault();
      event.stopPropagation();
    }, { passive: false });

    this._listen("keydown", (event) => {
      if (!this.adjustment || this.adjustment.maximum === 0) return;
      let handled = true;
      switch (event.key) {
        case "ArrowUp": this.onDelta(-1); break;
        case "ArrowDown": this.onDelta(1); break;
        case "PageUp": this.onDelta(-this.adjustment.pageSize); break;
        case "PageDown": this.onDelta(this.adjustment.pageSize); break;
        case "Home": this.onRow(0); break;
        case "End": this.onRow(this.adjustment.maximum); break;
        default: handled = false;
      }
      if (handled) {
        this.reveal();
        this.onInteraction();
        event.preventDefault();
      }
    });

    this._listen("pointerenter", () => {
      this.reveal();
    });
    this._listen("pointerleave", () => {
      this._scheduleAutohide();
    });
    this._listen("focusin", () => {
      this.reveal();
    });
    this._listen("focusout", () => {
      this._scheduleAutohide();
    });
  }

  dispose() {
    for (const dispose of this._listeners.splice(0)) dispose();
    this.drag = null;
    this._resetAutohide();
    this.adjustment = null;
  }
}
