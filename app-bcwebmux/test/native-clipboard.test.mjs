import assert from "node:assert/strict";
import test from "node:test";
import { InputController } from "../../wgpuTerminal/src/browser/input/InputController.js";

function setup(selectedText = "selected terminal text") {
  const pasted = [];
  let selectionCleared = false;
  let inputCleared = false;
  const controller = Object.create(InputController.prototype);
  const input = new EventTarget();
  Object.assign(controller, {
    input,
    _listen: (target, type, listener) => {
      target.addEventListener(type, listener);
    },
    getSelectedText: () => selectedText,
    clearActiveSelection: () => {
      selectionCleared = true;
    },
    sendText: (text, paste) => pasted.push({ text, paste }),
    clear: () => {
      inputCleared = true;
    },
  });
  controller._installListeners();
  return {
    input,
    pasted,
    selectionCleared: () => selectionCleared,
    inputCleared: () => inputCleared,
  };
}

function clipboardEvent(type, text = "") {
  const data = new Map([["text/plain", text]]);
  const event = new Event(type, { cancelable: true });
  event.clipboardData = {
    getData: (type) => data.get(type) || "",
    setData: (type, value) => data.set(type, value),
  };
  return event;
}

test("native Copy copies the terminal selection without a keypress", () => {
  const state = setup();
  const event = clipboardEvent("copy");
  state.input.dispatchEvent(event);
  assert.equal(event.clipboardData.getData("text/plain"), "selected terminal text");
  assert.equal(event.defaultPrevented, true);
  assert.equal(state.selectionCleared(), true);
});

test("native Copy without a terminal selection leaves browser behavior alone", () => {
  const state = setup(null);
  const event = clipboardEvent("copy");
  state.input.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
  assert.equal(state.selectionCleared(), false);
});

test("native Paste sends clipboard text as a paste without a keypress", () => {
  const state = setup();
  const event = clipboardEvent("paste", "first line\nsecond line");
  state.input.dispatchEvent(event);
  assert.deepEqual(state.pasted, [{ text: "first line\nsecond line", paste: true }]);
  assert.equal(event.defaultPrevented, true);
  assert.equal(state.inputCleared(), true);
});
