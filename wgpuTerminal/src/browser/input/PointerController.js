// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { modifierBits } from "./InputController.js";

function mouseButton(button) {
  if (button === 0) return 1;
  if (button === 2) return 2;
  if (button === 1) return 3;
  return 0xff;
}

export class PointerController {
  constructor(options) {
    this.scroll = options.scroll;
    this.screen = options.screen;
    this.getWasm = options.getWasm;
    this.getRenderer = options.getRenderer;
    this.getSelectionMode = options.getSelectionMode;
    this.textView = options.textView;
    this.focusController = options.focusController;
    this.scheduleFrame = options.scheduleFrame;
    this.onLink = options.onLink || (() => {});
    this.strictDecoder = new TextDecoder("utf-8", { fatal: true });
    this.encodedRightClick = false;
    this.activeMouseGesture = null;
    this.suppressNextTerminalClick = false;
    this.scrollbarHideTimer = 0;
    this.touchCandidate = null;
    this.suppressedMousePointerUps = new Set();
    this.touchMoveThreshold = 8;
    this.touchLongPressThreshold = 400;
    this.scrollbarHideDelay = 900;
    this._listeners = [];
    this._installListeners();
  }

  _listen(type, listener, options) {
    this.scroll.addEventListener(type, listener, options);
    this._listeners.push(() => this.scroll.removeEventListener(type, listener, options));
  }

  resetGestures() {
    this.touchCandidate = null;
    this.activeMouseGesture = null;
    this.encodedRightClick = false;
  }

  revealScrollbar() {
    if (this.scroll.scrollHeight <= this.scroll.clientHeight) return;
    this.scroll.classList.add("scrollbar-active");
    clearTimeout(this.scrollbarHideTimer);
    this.scrollbarHideTimer = setTimeout(() => {
      this.scroll.classList.remove("scrollbar-active");
    }, this.scrollbarHideDelay);
  }

  isScrollbarPointer(event) {
    if (event.pointerType === "touch") return false;
    const scrollbarWidth = this.scroll.offsetWidth - this.scroll.clientWidth;
    if (scrollbarWidth <= 0 || this.scroll.scrollHeight <= this.scroll.clientHeight) return false;
    const rect = this.scroll.getBoundingClientRect();
    return event.clientX >= rect.right - scrollbarWidth &&
      event.clientX < rect.right && event.clientY >= rect.top && event.clientY < rect.bottom;
  }

  isTerminalPointer(event) {
    const rect = this.screen.getBoundingClientRect();
    return event.clientX >= rect.left && event.clientX < rect.right &&
      event.clientY >= rect.top && event.clientY < rect.bottom &&
      !this.isScrollbarPointer(event);
  }

  sendMouse(event, action, button, anyButtonPressed = event.buttons !== 0) {
    const renderer = this.getRenderer();
    const wasm = this.getWasm();
    const rect = this.scroll.getBoundingClientRect();
    const x = Math.max(0, event.clientX - rect.left) * renderer.pixelScaleX;
    const y = Math.max(0, event.clientY - rect.top) * renderer.pixelScaleY;
    return wasm.term_mouse(action, button, modifierBits(event), x, y, anyButtonPressed ? 1 : 0) === 1;
  }

  sendSelection(event, action) {
    const renderer = this.getRenderer();
    const wasm = this.getWasm();
    const rect = this.scroll.getBoundingClientRect();
    const x = Math.max(0, event.clientX - rect.left) * renderer.pixelScaleX;
    const y = Math.max(0, event.clientY - rect.top) * renderer.pixelScaleY;
    const handled = wasm.term_selection(action, x, y) === 1;
    if (handled) this.scheduleFrame(true);
    return handled;
  }

  hyperlinkAtEvent(event) {
    const renderer = this.getRenderer();
    const wasm = this.getWasm();
    const rect = this.scroll.getBoundingClientRect();
    const x = Math.max(0, event.clientX - rect.left) * renderer.pixelScaleX;
    const y = Math.max(0, event.clientY - rect.top) * renderer.pixelScaleY;
    const status = wasm.term_hyperlink_at(x, y);
    if (status < 0) throw new Error(`WASM hyperlink lookup failed: ${status}`);
    if (status !== 1) return null;
    const ptr = wasm.term_hyperlink_ptr();
    const len = wasm.term_hyperlink_len();
    const bytes = new Uint8Array(wasm.memory.buffer, ptr, len).slice();
    try {
      return this.strictDecoder.decode(bytes);
    } catch (error) {
      console.warn("invalid hyperlink URI encoding", error);
      return null;
    }
  }

  finishMouseGesture(event, cancelled = false) {
    const gesture = this.activeMouseGesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return false;
    this.activeMouseGesture = null;
    if (cancelled) this.suppressedMousePointerUps.add(gesture.pointerId);
    if (gesture.owner === "hyperlink") {
      this.suppressNextTerminalClick = true;
      setTimeout(() => {
        this.suppressNextTerminalClick = false;
      }, 0);
      if (!cancelled && !gesture.moved) this.onLink({ uri: gesture.uri, event });
    } else if (gesture.owner === "terminal") {
      this.sendMouse(event, 1, gesture.button);
    } else {
      this.sendSelection(event, cancelled ? 3 : 1);
    }
    if (this.scroll.hasPointerCapture(event.pointerId)) this.scroll.releasePointerCapture(event.pointerId);
    return true;
  }

  _installListeners() {
    this._listen("scroll", () => this.revealScrollbar(), { passive: true });
    this._listen("pointerdown", (event) => {
      if (this.getSelectionMode()) return;
      if (event.pointerType !== "touch") this.suppressedMousePointerUps.delete(event.pointerId);
      if (event.pointerType === "touch") {
        if (this.isTerminalPointer(event)) {
          this.touchCandidate = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            startedAt: Date.now(),
            moved: false,
            ended: false,
            duration: 0,
            suppress: false,
          };
        }
        return;
      }
      if (!this.isTerminalPointer(event)) {
        this.encodedRightClick = false;
        return;
      }
      if (event.button === 0 && !event.shiftKey) {
        const uri = this.hyperlinkAtEvent(event);
        if (uri) {
          event.preventDefault();
          this.activeMouseGesture = {
            pointerId: event.pointerId,
            owner: "hyperlink",
            uri,
            startX: event.clientX,
            startY: event.clientY,
            moved: false,
          };
          this.scroll.setPointerCapture(event.pointerId);
          return;
        }
      }
      if (this.textView.hasSelection()) this.textView.clearBrowserSelection(true);
      this.focusController.focus();
      if (this.activeMouseGesture) {
        event.preventDefault();
        return;
      }
      if (event.button === 0 && event.shiftKey) {
        this.encodedRightClick = false;
        if (this.sendSelection(event, 0)) {
          event.preventDefault();
          this.activeMouseGesture = { pointerId: event.pointerId, button: 1, owner: "selection" };
          this.scroll.setPointerCapture(event.pointerId);
        }
        return;
      }
      const button = mouseButton(event.button);
      const encoded = this.sendMouse(event, 0, button);
      this.encodedRightClick = button === 2 && encoded;
      if (encoded) {
        this.activeMouseGesture = { pointerId: event.pointerId, button, owner: "terminal" };
        event.preventDefault();
        this.scroll.setPointerCapture(event.pointerId);
      } else if (event.button === 0 && this.sendSelection(event, 0)) {
        this.activeMouseGesture = { pointerId: event.pointerId, button: 1, owner: "selection" };
        event.preventDefault();
        this.scroll.setPointerCapture(event.pointerId);
      }
    }, { passive: false });

    this._listen("pointerup", (event) => {
      if (this.getSelectionMode()) return;
      if (event.pointerType === "touch") {
        const candidate = this.touchCandidate;
        if (candidate?.pointerId === event.pointerId) {
          candidate.ended = true;
          candidate.duration = Date.now() - candidate.startedAt;
          candidate.suppress = candidate.moved || candidate.duration >= this.touchLongPressThreshold;
        }
        return;
      }
      if (this.suppressedMousePointerUps.has(event.pointerId)) {
        this.suppressedMousePointerUps.delete(event.pointerId);
        event.preventDefault();
        return;
      }
      if (this.finishMouseGesture(event)) {
        event.preventDefault();
        return;
      }
      if (!this.isTerminalPointer(event)) return;
      const encoded = this.sendMouse(event, 1, mouseButton(event.button));
      if (encoded) event.preventDefault();
    }, { passive: false });

    this._listen("pointermove", (event) => {
      if (event.pointerType !== "touch" && this.scroll.scrollHeight > this.scroll.clientHeight &&
          event.clientX >= this.scroll.getBoundingClientRect().right - 12) this.revealScrollbar();
      if (this.getSelectionMode()) return;
      if (event.pointerType === "touch") {
        if (this.touchCandidate?.pointerId === event.pointerId) {
          const dx = event.clientX - this.touchCandidate.startX;
          const dy = event.clientY - this.touchCandidate.startY;
          if (Math.hypot(dx, dy) > this.touchMoveThreshold) this.touchCandidate.moved = true;
        }
        return;
      }
      if (this.activeMouseGesture && this.activeMouseGesture.pointerId === event.pointerId) {
        if (this.activeMouseGesture.owner === "terminal") {
          this.sendMouse(event, 2, this.activeMouseGesture.button);
        } else if (this.activeMouseGesture.owner === "hyperlink") {
          const dx = event.clientX - this.activeMouseGesture.startX;
          const dy = event.clientY - this.activeMouseGesture.startY;
          if (Math.hypot(dx, dy) > this.touchMoveThreshold) this.activeMouseGesture.moved = true;
        } else {
          this.sendSelection(event, 2);
        }
        event.preventDefault();
        return;
      }
      if (!this.isTerminalPointer(event)) return;
      const encoded = this.sendMouse(event, 2, 0xff);
      if (encoded) event.preventDefault();
    }, { passive: false });

    this._listen("pointercancel", (event) => {
      if (this.getSelectionMode()) return;
      if (event.pointerType === "touch") {
        if (this.touchCandidate?.pointerId === event.pointerId) this.touchCandidate = null;
        return;
      }
      if (this.finishMouseGesture(event, true)) event.preventDefault();
    }, { passive: false });
    this._listen("lostpointercapture", (event) => this.finishMouseGesture(event, true));
    this._listen("wheel", (event) => {
      if (this.getSelectionMode() || !this.isTerminalPointer(event) || event.deltaY === 0) return;
      if (this.sendMouse(event, 0, event.deltaY < 0 ? 4 : 5)) event.preventDefault();
    }, { passive: false });
    this._listen("contextmenu", (event) => {
      if (this.getSelectionMode() || !this.encodedRightClick) return;
      this.encodedRightClick = false;
      event.preventDefault();
    });
    this._listen("click", (event) => {
      if (this.getSelectionMode()) return;
      if (this.suppressNextTerminalClick) {
        this.suppressNextTerminalClick = false;
        return;
      }
      if (this.textView.hasSelection()) {
        this.touchCandidate = null;
        return;
      }
      if (!this.isTerminalPointer(event)) return;
      if (!event.shiftKey) {
        const uri = this.hyperlinkAtEvent(event);
        if (uri) {
          this.touchCandidate = null;
          event.preventDefault();
          this.onLink({ uri, event });
          return;
        }
      }
      if (this.touchCandidate?.ended) {
        const suppress = this.touchCandidate.suppress;
        this.touchCandidate = null;
        if (suppress) return;
        this.sendMouse(event, 0, 1, true);
        this.sendMouse(event, 1, 1, false);
      }
      event.preventDefault();
      this.focusController.focus();
    });
  }

  dispose() {
    clearTimeout(this.scrollbarHideTimer);
    for (const dispose of this._listeners.splice(0)) dispose();
    this.resetGestures();
  }
}
