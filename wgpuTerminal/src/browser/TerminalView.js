// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

export const TERMINAL_VIEW_ROLE_ATTRIBUTE = "data-terminal-role";
export const TERMINAL_VIEW_CLASS = "wgpu-terminal";
export const TERMINAL_VIEW_ROLES = Object.freeze({
  viewport: "viewport",
  scroll: "scroll",
  spacer: "spacer",
  textView: "text-view",
  input: "input",
  screen: "screen",
  composition: "composition",
});

const ELEMENT_NAMES = Object.freeze(["viewport", "scroll", "spacer", "textView", "input", "screen", "composition"]);
const CHILD_NAMES = Object.freeze(["scroll", "input", "screen", "composition"]);
function isNode(value, tagName = null) {
  return value !== null && typeof value === "object" && value.nodeType === 1 &&
    (!tagName || String(value.tagName).toLowerCase() === tagName);
}

function assertNode(value, name, tagName) {
  if (!isNode(value, tagName)) throw new TypeError(`terminal ${name} element is required`);
  return value;
}

function assertElements(elements) {
  if (!elements || typeof elements !== "object" || Array.isArray(elements)) {
    throw new TypeError("terminal elements are required");
  }
  const tags = { viewport: "section", scroll: "div", spacer: "div", textView: "div",
    input: "textarea", screen: "canvas", composition: "div" };
  for (const name of ELEMENT_NAMES) assertNode(elements[name], name, tags[name]);
  const { viewport, scroll, spacer, textView } = elements;
  if (!CHILD_NAMES.every((name) => Array.from(viewport.children).includes(elements[name])) ||
      scroll.children.length !== 1 || scroll.children[0] !== spacer ||
      spacer.children.length !== 1 || spacer.children[0] !== textView) {
    throw new Error("terminal elements have an invalid structure");
  }
  return elements;
}

function documentFor(parent, supplied) {
  const doc = supplied || parent?.ownerDocument || globalThis.document;
  if (!doc || typeof doc.createElement !== "function") throw new TypeError("terminal document is required");
  return doc;
}

function mark(element, roleName, viewport = false) {
  element.setAttribute(TERMINAL_VIEW_ROLE_ATTRIBUTE, roleName);
  if (viewport) element.classList.add(TERMINAL_VIEW_CLASS);
  return element;
}

export class TerminalView {
  constructor(options = {}) {
    if (!options || typeof options !== "object") throw new TypeError("terminal options are required");
    const hasElements = options.elements !== undefined;
    const hasParent = options.parent !== undefined;
    if (hasElements === hasParent) throw new TypeError("exactly one of terminal elements or parent is required");
    this.disposed = false;
    this.generated = false;

    if (hasElements) {
      this.elements = Object.freeze({ ...assertElements(options.elements) });
    } else {
      const parent = assertNode(options.parent, "parent");
      const doc = documentFor(parent, options.document);
      this.generated = true;
      const create = (tag, name) => mark(doc.createElement(tag), TERMINAL_VIEW_ROLES[name], name === "viewport");
      this.viewport = create("section", "viewport");
      this.viewport.setAttribute("role", "application");
      this.viewport.setAttribute("aria-label", "Terminal");
      this.scroll = create("div", "scroll");
      this.spacer = create("div", "spacer");
      this.textView = create("div", "textView");
      this.textView.setAttribute("aria-hidden", "true");
      this.input = create("textarea", "input");
      this.input.setAttribute("aria-label", "Terminal input");
      this.input.setAttribute("aria-multiline", "false");
      this.input.autocapitalize = "off";
      this.input.autocomplete = "off";
      this.input.setAttribute("autocorrect", "off");
      this.input.spellcheck = false;
      this.input.inputMode = "text";
      this.input.enterKeyHint = "enter";
      this.input.rows = 1;
      this.screen = create("canvas", "screen");
      this.screen.setAttribute("role", "img");
      this.screen.setAttribute("aria-label", "Terminal screen");
      this.composition = create("div", "composition");
      this.composition.setAttribute("aria-hidden", "true");
      this.spacer.append(this.textView);
      this.scroll.append(this.spacer);
      this.viewport.append(this.scroll, this.input, this.screen, this.composition);
      parent.append(this.viewport);
      this.elements = Object.freeze(Object.fromEntries(ELEMENT_NAMES.map((name) => [name, this[name]])));
    }
    for (const name of ELEMENT_NAMES) this[name] = this.elements[name];
    if (!this.generated) {
      for (const name of ELEMENT_NAMES) mark(this[name], TERMINAL_VIEW_ROLES[name], name === "viewport");
    }
  }

  static create(parent, options = {}) {
    return new TerminalView({ ...options, parent });
  }

  static hydrate(elements) {
    return new TerminalView({ elements });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.generated) this.viewport.remove();
  }
}
