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
    this.surface = options.surface;
    this.screen = options.screen;
    this.getCore = options.getCore;
    this.getRenderer = options.getRenderer;
    this.getSelectionMode = options.getSelectionMode;
    this.textView = options.textView;
    this.focusController = options.focusController;
    this.scheduleFrame = options.scheduleFrame;
    this.scrollWheel = options.scrollWheel;
    this.beginTouchScroll = options.beginTouchScroll;
    this.updateTouchScroll = options.updateTouchScroll;
    this.endTouchScroll = options.endTouchScroll;
    this.cancelTouchScroll = options.cancelTouchScroll;
    this.cancelScrollGesture = options.cancelScrollGesture;
    this.enterSelectionMode = options.enterSelectionMode || (() => false);
    this.onLink = options.onLink || (() => {});
    this.strictDecoder = new TextDecoder("utf-8", { fatal: true });
    this.encodedRightClick = false;
    this.activeMouseGesture = null;
    this.suppressNextTerminalClick = false;
    this.touchCandidate = null;
    this.suppressedMousePointerUps = new Set();
    this.touchMoveThreshold = 8;
    this.touchLongPressThreshold = 400;
    this._listenerController = new AbortController();
    this._installListeners();
  }

  _listen(type, listener, options) {
    this.surface.addEventListener(type, listener, { ...options, signal: this._listenerController.signal });
  }

  resetGestures() {
    this.cancelScrollGesture();
    this.clearTouchCandidate();
    this.activeMouseGesture = null;
    this.encodedRightClick = false;
  }

  clearTouchCandidate() {
    if (this.touchCandidate?.longPressTimer != null) {
      clearTimeout(this.touchCandidate.longPressTimer);
    }
    this.touchCandidate = null;
  }

  isTerminalPointer(event) {
    const rect = this.screen.getBoundingClientRect();
    return event.clientX >= rect.left && event.clientX < rect.right &&
      event.clientY >= rect.top && event.clientY < rect.bottom;
  }

  scrollContext(event) {
    const renderer = this.getRenderer();
    const rect = this.surface.getBoundingClientRect();
    return {
      mods: modifierBits(event),
      x: Math.max(0, event.clientX - rect.left) * renderer.pixelScaleX,
      y: Math.max(0, event.clientY - rect.top) * renderer.pixelScaleY,
    };
  }

  sendMouse(event, action, button, anyButtonPressed = event.buttons !== 0) {
    const renderer = this.getRenderer();
    const core = this.getCore();
    const rect = this.surface.getBoundingClientRect();
    const x = Math.max(0, event.clientX - rect.left) * renderer.pixelScaleX;
    const y = Math.max(0, event.clientY - rect.top) * renderer.pixelScaleY;
    return core.mouse(action, button, modifierBits(event), x, y, anyButtonPressed ? 1 : 0) === 1;
  }

  sendSelection(event, action) {
    const renderer = this.getRenderer();
    const core = this.getCore();
    const rect = this.surface.getBoundingClientRect();
    const x = Math.max(0, event.clientX - rect.left) * renderer.pixelScaleX;
    const y = Math.max(0, event.clientY - rect.top) * renderer.pixelScaleY;
    const handled = core.selection(action, x, y) === 1;
    if (handled) this.scheduleFrame(true);
    return handled;
  }

  hyperlinkAtEvent(event) {
    const renderer = this.getRenderer();
    const core = this.getCore();
    const rect = this.surface.getBoundingClientRect();
    const x = Math.max(0, event.clientX - rect.left) * renderer.pixelScaleX;
    const y = Math.max(0, event.clientY - rect.top) * renderer.pixelScaleY;
    return core.hyperlinkAt(x, y);
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
    if (this.surface.hasPointerCapture(event.pointerId)) this.surface.releasePointerCapture(event.pointerId);
    return true;
  }

  _installListeners() {
    this._listen("pointerdown", (event) => {
      if (this.getSelectionMode()) {
        if (event.pointerType === "touch") {
          const target = event.target;
          const exactTextCell = target instanceof Element &&
            target.matches(".text-cell") &&
            this.textView.element.contains(target) &&
            target.textContent?.trim().length > 0;
          if (!exactTextCell) {
            this.textView.selectWordAtPoint(event.clientX, event.clientY, { nearest: true });
          }
        }
        return;
      }
      if (event.pointerType !== "touch") this.suppressedMousePointerUps.delete(event.pointerId);
      if (event.pointerType === "touch") {
        if (this.isTerminalPointer(event)) {
          this.clearTouchCandidate();
          const candidate = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            startedAt: Date.now(),
            moved: false,
            ended: false,
            duration: 0,
            suppress: false,
            longPressTimer: null,
          };
          this.touchCandidate = candidate;
          candidate.longPressTimer = setTimeout(() => {
            if (this.touchCandidate !== candidate || candidate.moved || candidate.ended) return;
            candidate.longPressTimer = null;
            candidate.suppress = true;
            if (this.enterSelectionMode(candidate.startX, candidate.startY) &&
                this.surface.hasPointerCapture(candidate.pointerId)) {
              this.surface.releasePointerCapture(candidate.pointerId);
            }
          }, this.touchLongPressThreshold);
          this.beginTouchScroll(event.clientY);
          try {
            this.surface.setPointerCapture(event.pointerId);
          } catch {}
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
          this.surface.setPointerCapture(event.pointerId);
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
          this.surface.setPointerCapture(event.pointerId);
        }
        return;
      }
      const button = mouseButton(event.button);
      const encoded = this.sendMouse(event, 0, button);
      this.encodedRightClick = button === 2 && encoded;
      if (encoded) {
        this.activeMouseGesture = { pointerId: event.pointerId, button, owner: "terminal" };
        event.preventDefault();
        this.surface.setPointerCapture(event.pointerId);
      } else if (event.button === 0 && this.sendSelection(event, 0)) {
        this.activeMouseGesture = { pointerId: event.pointerId, button: 1, owner: "selection" };
        event.preventDefault();
        this.surface.setPointerCapture(event.pointerId);
      }
    }, { passive: false });

    this._listen("pointerup", (event) => {
      if (this.getSelectionMode()) return;
      if (event.pointerType === "touch") {
        const candidate = this.touchCandidate;
        if (candidate?.pointerId === event.pointerId) {
          clearTimeout(candidate.longPressTimer);
          candidate.longPressTimer = null;
          candidate.ended = true;
          candidate.duration = Date.now() - candidate.startedAt;
          candidate.suppress = candidate.moved || candidate.duration >= this.touchLongPressThreshold;
          if (candidate.moved) {
            this.endTouchScroll(event.clientY, this.scrollContext(event));
          } else {
            this.cancelTouchScroll();
          }
          if (this.surface.hasPointerCapture(event.pointerId)) this.surface.releasePointerCapture(event.pointerId);
          if (candidate.moved) event.preventDefault();
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
      if (this.getSelectionMode()) return;
      if (event.pointerType === "touch") {
        const candidate = this.touchCandidate;
        if (candidate?.pointerId === event.pointerId) {
          const dx = event.clientX - candidate.startX;
          const dy = event.clientY - candidate.startY;
          if (!candidate.moved && Math.hypot(dx, dy) > this.touchMoveThreshold) {
            candidate.moved = true;
            clearTimeout(candidate.longPressTimer);
            candidate.longPressTimer = null;
          }
          if (candidate.moved) {
            if (this.updateTouchScroll(event.clientY, this.scrollContext(event))) {
              event.preventDefault();
            }
          }
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
        if (this.touchCandidate?.pointerId === event.pointerId) {
          this.cancelTouchScroll();
          this.clearTouchCandidate();
          if (this.surface.hasPointerCapture(event.pointerId)) {
            this.surface.releasePointerCapture(event.pointerId);
          }
        }
        return;
      }
      if (this.finishMouseGesture(event, true)) event.preventDefault();
    }, { passive: false });
    this._listen("lostpointercapture", (event) => this.finishMouseGesture(event, true));
    this._listen("wheel", (event) => {
      if (this.getSelectionMode() || !this.isTerminalPointer(event) || event.deltaY === 0) return;
      if (this.scrollWheel(event, this.scrollContext(event))) {
        event.preventDefault();
      }
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
        this.clearTouchCandidate();
        return;
      }
      if (!this.isTerminalPointer(event)) return;
      if (!event.shiftKey) {
        const uri = this.hyperlinkAtEvent(event);
        if (uri) {
          this.clearTouchCandidate();
          event.preventDefault();
          this.onLink({ uri, event });
          return;
        }
      }
      if (this.touchCandidate?.ended) {
        const suppress = this.touchCandidate.suppress;
        this.clearTouchCandidate();
        if (suppress) return;
        this.sendMouse(event, 0, 1, true);
        this.sendMouse(event, 1, 1, false);
      }
      event.preventDefault();
      this.focusController.focus();
    });
  }

  dispose() {
    this._listenerController.abort();
    this.resetGestures();
  }
}
