// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const NAMED_EVENT_CODES = Object.freeze({
  Enter: "Enter",
  Backspace: "Backspace",
  Tab: "Tab",
  Escape: "Escape",
  Esc: "Escape",
  Delete: "Delete",
  Del: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Shift: "Shift",
  Control: "Control",
  Alt: "Alt",
  Meta: "Meta",
});

const LEGACY_EVENT_CODES = Object.freeze({
  8: "Backspace",
  9: "Tab",
  13: "Enter",
  16: "Shift",
  17: "Control",
  18: "Alt",
  27: "Escape",
  33: "PageUp",
  34: "PageDown",
  35: "End",
  36: "Home",
  37: "ArrowLeft",
  38: "ArrowUp",
  39: "ArrowRight",
  40: "ArrowDown",
  45: "Insert",
  46: "Delete",
});

export function characterCode(character) {
  if (/^[A-Za-z]$/.test(character)) return `Key${character.toUpperCase()}`;
  if (/^[0-9]$/.test(character)) return `Digit${character}`;
  if (character === " ") return "Space";
  return "Unidentified";
}

export function eventCode(event) {
  if (NAMED_EVENT_CODES[event.key]) return NAMED_EVENT_CODES[event.key];
  if (LEGACY_EVENT_CODES[event.keyCode]) return LEGACY_EVENT_CODES[event.keyCode];
  if (event.code && event.code !== "Unidentified") return event.code;
  const codepoint = event.key?.codePointAt(0);
  if (codepoint !== undefined && event.key.length === (codepoint > 0xffff ? 2 : 1)) {
    return characterCode(event.key);
  }
  return LEGACY_EVENT_CODES[event.keyCode] || "Unidentified";
}

export function isImeKeyEvent(event) {
  return event.key === "Process" || event.key === "Dead" ||
    event.keyCode === 229 || eventCode(event) === "Unidentified";
}

export function isModifierCode(code) {
  return /^(Alt|Control|Meta|Shift|CapsLock|NumLock|ScrollLock|Fn)/.test(code);
}

export function modifierBits(event) {
  let bits = 0;
  if (event.shiftKey) bits |= 1;
  if (event.ctrlKey) bits |= 2;
  if (event.altKey) bits |= 4;
  if (event.metaKey) bits |= 8;
  if (event.getModifierState?.("CapsLock")) bits |= 16;
  if (event.getModifierState?.("NumLock")) bits |= 32;
  return bits;
}

class InputDiagnostics {
  constructor(input, elements = {}, enabled = false) {
    this.input = input;
    this.panel = elements.panel;
    this.logElement = elements.log;
    this.clearButton = elements.clear;
    this.copyButton = elements.copy;
    this.enabled = Boolean(enabled);
    this.entries = [];
    this.started = performance.now();
    this._disposers = [];
    if (!this.enabled) return;

    this.panel?.removeAttribute("hidden");
    for (const type of [
      "keydown", "keyup", "keypress", "beforeinput", "input",
      "compositionstart", "compositionupdate", "compositionend",
      "textInput", "focus", "blur",
    ]) {
      const listener = (event) => {
        this.event("event", event);
        queueMicrotask(() => this.event("post", event));
      };
      input.addEventListener(type, listener, { capture: true });
      this._disposers.push(() => input.removeEventListener(type, listener, { capture: true }));
    }
    const clear = () => this.clear();
    const copy = () => this.copy();
    this.clearButton?.addEventListener("click", clear);
    this.copyButton?.addEventListener("click", copy);
    this._disposers.push(() => this.clearButton?.removeEventListener("click", clear));
    this._disposers.push(() => this.copyButton?.removeEventListener("click", copy));
    this._logEnvironment();
  }

  _logEnvironment() {
    this.log("environment", {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      secureContext: window.isSecureContext,
    });
  }

  log(kind, data) {
    if (!this.enabled) return;
    this.entries.push({ t: performance.now() - this.started, kind, data });
    if (this.entries.length > 400) this.entries.splice(0, this.entries.length - 400);
    if (this.logElement) {
      this.logElement.textContent = this.entries.slice(-80).map((entry) => JSON.stringify(entry)).join("\n");
    }
  }

  event(stage, event) {
    if (!this.enabled) return;
    this.log("event", {
      stage,
      type: event.type,
      key: event.key ?? null,
      code: event.code ?? null,
      keyCode: event.keyCode ?? null,
      which: event.which ?? null,
      inputType: event.inputType ?? null,
      data: event.data ?? null,
      isComposing: !!event.isComposing,
      repeat: !!event.repeat,
      cancelable: !!event.cancelable,
      defaultPrevented: !!event.defaultPrevented,
      value: this.input.value,
      selectionStart: this.input.selectionStart,
      selectionEnd: this.input.selectionEnd,
    });
  }

  clear() {
    if (!this.enabled) return;
    this.entries = [];
    this._logEnvironment();
  }

  text() {
    if (!this.enabled) return "";
    return this.entries.map((entry) => JSON.stringify(entry)).join("\n");
  }

  async copy() {
    if (!this.enabled) return;
    try {
      await navigator.clipboard.writeText(`bcwebmux input diagnostics\n${this.text()}`);
      if (this.copyButton) this.copyButton.textContent = "COPIED";
    } catch {
      if (this.copyButton) this.copyButton.textContent = "COPY FAILED";
    }
    setTimeout(() => {
      if (this.copyButton) this.copyButton.textContent = "COPY";
    }, 1200);
  }

  dispose() {
    for (const dispose of this._disposers.splice(0)) dispose();
  }
}

export class InputController {
  constructor(options) {
    this.input = options.input;
    this.compositionView = options.compositionView;
    this.coarsePointer = options.coarsePointer;
    this.getRenderer = options.getRenderer;
    this.getState = options.getState;
    this.getCellMetrics = options.getCellMetrics;
    this.sendCommittedInput = options.sendCommittedInput;
    this.sendKey = options.sendKey;
    this.sendSoftKey = options.sendSoftKey;
    this.sendText = options.sendText;
    this.getSelectedText = options.getSelectedText;
    this.clearActiveSelection = options.clearActiveSelection;
    this.onFocus = options.onFocus || (() => {});
    this.onBlur = options.onBlur || (() => {});
    this.isComposing = false;
    this.isSendingComposition = false;
    this.pendingComposition = "";
    this.commitTimer = 0;
    this.manualCommit = false;
    this.heldHardwareModifiers = 0;
    this.suppressedShortcutKeyUps = new Set();
    this._listeners = [];
    this.diagnostics = new InputDiagnostics(
      this.input,
      options.debugElements,
      options.inputDebug,
    );
    this.clear();
    this._installListeners();
  }

  _listen(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    this._listeners.push(() => target.removeEventListener(type, listener, options));
  }

  _installListeners() {
    this._listen(this.input, "keydown", async (event) => {
      if (!this.keyDown(event)) return;
      const code = eventCode(event);
      if (code === "KeyC" && ((event.ctrlKey && event.shiftKey) || event.metaKey)) {
        const selectedText = this.getSelectedText();
        if (selectedText !== null) {
          event.preventDefault();
          this.suppressedShortcutKeyUps.add(code);
          try {
            await navigator.clipboard.writeText(selectedText);
            this.clearActiveSelection();
          } catch (error) {
            console.error("clipboard copy failed", error);
          }
          return;
        }
      }
      if (event.ctrlKey && event.shiftKey && event.code === "KeyV") {
        event.preventDefault();
        this.suppressedShortcutKeyUps.add(code);
        this.sendText(await navigator.clipboard.readText(), true);
        return;
      }
      event.preventDefault();
      this.sendKey(event, event.repeat ? 2 : 1);
      if (code === "Enter" || (event.ctrlKey && code === "KeyC")) this.clear();
    });
    this._listen(this.input, "keyup", (event) => {
      this.keyUp(event);
      const code = eventCode(event);
      if (this.suppressedShortcutKeyUps.delete(code)) return;
      if (event.isComposing || isImeKeyEvent(event)) return;
      this.sendKey(event, 0);
    });
    this._listen(this.input, "beforeinput", (event) => this.beforeInput(event));
    this._listen(this.input, "compositionstart", () => this.compositionStart());
    this._listen(this.input, "compositionupdate", (event) => this.compositionUpdate(event));
    this._listen(this.input, "compositionend", (event) => this.compositionEnd(event));
    this._listen(this.input, "input", (event) => this.inputEvent(event));
    this._listen(this.input, "paste", (event) => {
      event.preventDefault();
      this.sendText(event.clipboardData.getData("text/plain"), true);
      this.clear();
    });
    this._listen(this.input, "copy", (event) => {
      const text = this.getSelectedText();
      if (text === null) return;
      event.clipboardData.setData("text/plain", text);
      event.preventDefault();
      this.clearActiveSelection();
    });
    this._listen(this.input, "focus", () => {
      this.sync();
      this.onFocus();
    });
    this._listen(this.input, "blur", () => {
      this.releaseModifiers();
      this.onBlur();
    });
  }

  resetGeometry() {
    if (this.coarsePointer.matches) {
      for (const property of [
        "left", "top", "right", "bottom", "width", "height", "line-height",
        "padding", "padding-left", "padding-top", "padding-right", "padding-bottom",
      ]) this.input.style.removeProperty(property);
    } else {
      this.input.style.left = "0px";
      this.input.style.top = "0px";
      this.input.style.width = "1px";
      this.input.style.height = "1px";
      this.input.style.lineHeight = "1px";
    }
  }

  emit(text) {
    if (this.diagnostics.enabled) this.diagnostics.log("ime_emit", { text });
    if (text) this.sendCommittedInput(text);
  }

  clear() {
    clearTimeout(this.commitTimer);
    this.commitTimer = 0;
    this.isComposing = false;
    this.isSendingComposition = false;
    this.input.value = "";
    this.pendingComposition = "";
    this.compositionView.textContent = "";
    this.compositionView.classList.remove("active");
    this.resetGeometry();
  }

  discardBufferedComposition() {
    clearTimeout(this.commitTimer);
    this.commitTimer = 0;
    this.isComposing = false;
    this.isSendingComposition = false;
    this.manualCommit = false;
    this.pendingComposition = "";
    this.input.value = "";
    this.compositionView.textContent = "";
    this.compositionView.classList.remove("active");
    this.resetGeometry();
  }

  updateHardwareModifiers(event) {
    const modifiers = modifierBits(event) & 0x0e;
    const wasHeld = this.heldHardwareModifiers !== 0;
    const isHeld = modifiers !== 0;
    if (isHeld && !wasHeld) this.discardBufferedComposition();
    if (isHeld !== wasHeld) this.input.inputMode = isHeld ? "none" : "text";
    this.heldHardwareModifiers = modifiers;
  }

  releaseModifiers() {
    this.heldHardwareModifiers = 0;
    this.input.inputMode = "text";
  }

  sync() {
    if (!this.isComposing) return;
    const renderer = this.getRenderer();
    const state = this.getState();
    const cell = this.getCellMetrics();
    const x = Math.max(0, renderer.cursorX === 0xffff ? 0 : renderer.cursorX) * cell.width;
    const y = Math.max(0, renderer.cursorY === 0xffff ? 0 : renderer.cursorY) * cell.height;
    if (this.coarsePointer.matches) {
      this.input.style.paddingLeft = `${x}px`;
      this.input.style.paddingTop = `${y}px`;
      this.input.style.lineHeight = `${cell.height}px`;
    } else {
      this.input.style.left = `${x}px`;
      this.input.style.top = `${y}px`;
      this.input.style.width = `${Math.max(1, cell.width)}px`;
      this.input.style.height = `${Math.max(1, cell.height)}px`;
      this.input.style.lineHeight = `${cell.height}px`;
    }
    this.compositionView.style.left = `${x}px`;
    this.compositionView.style.top = `${y}px`;
    this.compositionView.style.width = `${Math.max(1, Math.min(state.cols || 1, this.compositionView.textContent.length || 1)) * cell.width}px`;
    this.compositionView.style.height = `${Math.max(1, cell.height)}px`;
    this.compositionView.style.maxWidth = `${Math.max(1, (state.cols || 1) - Math.floor(x / cell.width)) * cell.width}px`;
    this.compositionView.style.lineHeight = `${cell.height}px`;
  }

  compositionStart() {
    if (this.heldHardwareModifiers) {
      this.discardBufferedComposition();
      return;
    }
    this.clear();
    this.isComposing = true;
    this.isSendingComposition = false;
    this.manualCommit = false;
    this.compositionView.classList.add("active");
    this.sync();
  }

  compositionUpdate(event) {
    if (this.heldHardwareModifiers || !this.isComposing) {
      this.discardBufferedComposition();
      return;
    }
    if (this.diagnostics.enabled) {
      this.diagnostics.log("ime_composition_update", {
        data: event.data || "",
        value: this.input.value,
        selectionStart: this.input.selectionStart,
        selectionEnd: this.input.selectionEnd,
      });
    }
    this.pendingComposition = event.data || "";
    this.compositionView.textContent = `\u200e${event.data || ""}\u200e`;
    this.sync();
  }

  compositionEnd(event) {
    if (this.heldHardwareModifiers) {
      this.discardBufferedComposition();
      return;
    }
    if (this.diagnostics.enabled) {
      this.diagnostics.log("ime_composition_end", {
        isComposing: this.isComposing,
        isSendingComposition: this.isSendingComposition,
        value: this.input.value,
      });
    }
    if (this.manualCommit) {
      this.manualCommit = false;
      return;
    }
    if (!this.isComposing) {
      this.discardBufferedComposition();
      return;
    }
    this.isComposing = false;
    this.isSendingComposition = true;
    this.pendingComposition = event.data || this.pendingComposition;
    this.compositionView.classList.remove("active");
    this.commitTimer = setTimeout(() => this.finishComposition(), 0);
  }

  keyDown(event) {
    this.updateHardwareModifiers(event);
    const code = eventCode(event);
    if (this.diagnostics.enabled) {
      this.diagnostics.log("ime_keydown", {
        key: event.key,
        code,
        keyCode: event.keyCode,
        composing: this.isComposing,
        sending: this.isSendingComposition,
      });
    }
    if (this.heldHardwareModifiers) {
      this.discardBufferedComposition();
      return true;
    }
    if (this.commitTimer) this.finishComposition();
    if (this.isComposing) {
      if (code === "Enter") {
        this.commit(true);
        return true;
      }
      return false;
    }
    if (isImeKeyEvent(event)) return false;
    return true;
  }

  keyUp(event) {
    this.updateHardwareModifiers(event);
  }

  beforeInput(event) {
    const compositionEvent = event.isComposing || event.inputType?.includes("Composition");
    if (this.heldHardwareModifiers || (compositionEvent && !this.isComposing && !this.isSendingComposition)) {
      if (event.cancelable) event.preventDefault();
      this.discardBufferedComposition();
    }
  }

  inputEvent(event) {
    const compositionEvent = event.isComposing || event.inputType?.includes("Composition");
    if (this.heldHardwareModifiers || (compositionEvent && !this.isComposing && !this.isSendingComposition)) {
      this.discardBufferedComposition();
      return;
    }
    if (this.diagnostics.enabled) {
      this.diagnostics.log("ime_input", {
        inputType: event.inputType,
        data: event.data,
        composing: this.isComposing,
        sending: this.isSendingComposition,
      });
    }
    if (this.isComposing || this.isSendingComposition) return;
    if (event.inputType?.endsWith("Backward")) {
      this.sendSoftKey("Backspace", "Backspace");
    } else if (event.inputType?.endsWith("Forward")) {
      this.sendSoftKey("Delete", "Delete");
    } else if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") {
      this.sendSoftKey("Enter", "Enter");
    } else {
      this.emit(event.data || this.input.value);
    }
    this.clear();
  }

  commit(manual = false) {
    if (this.isComposing) {
      this.manualCommit = manual;
      this.pendingComposition = this.input.value || this.pendingComposition;
      this.isComposing = false;
      this.isSendingComposition = true;
    }
    this.finishComposition();
  }

  finishComposition() {
    clearTimeout(this.commitTimer);
    this.commitTimer = 0;
    if (!this.isSendingComposition) return;
    this.isSendingComposition = false;
    this.emit(this.input.value || this.pendingComposition);
    this.clear();
  }

  clearShortcutState() {
    this.suppressedShortcutKeyUps.clear();
  }

  get trace() {
    return this.diagnostics.text();
  }

  dispose() {
    clearTimeout(this.commitTimer);
    for (const dispose of this._listeners.splice(0)) dispose();
    this.diagnostics.dispose();
  }
}

export class FocusController {
  constructor(options) {
    this.input = options.input;
    this.inputController = options.inputController;
    this.textView = options.textView;
    this.getWasm = options.getWasm;
    this.suspended = false;
  }

  focus() {
    if (this.suspended || document.hidden || this.textView.hasSelection()) return;
    this.input.focus({ preventScroll: true });
    this.inputController.sync();
    const wasm = this.getWasm();
    if (wasm && document.hasFocus()) wasm.term_focus(1);
  }

  restore() {
    if (this.textView.hasSelection()) return;
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active !== this.input && active !== document.body && active !== document.documentElement) return;
      this.focus();
    });
  }

  suspend() {
    this.suspended = true;
    if (document.activeElement === this.input) this.input.blur();
    const wasm = this.getWasm();
    if (wasm) wasm.term_focus(0);
  }

  resume() {
    this.suspended = false;
    const wasm = this.getWasm();
    if (wasm) wasm.term_focus(document.hasFocus() ? 1 : 0);
  }

  windowFocus() {
    const wasm = this.getWasm();
    if (wasm) wasm.term_focus(this.suspended ? 0 : 1);
    this.restore();
  }

  windowBlur() {
    this.inputController.releaseModifiers();
    const wasm = this.getWasm();
    if (wasm) wasm.term_focus(0);
  }
}
