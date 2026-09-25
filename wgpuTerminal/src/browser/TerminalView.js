// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

export const TERMINAL_VIEW_ROLE_ATTRIBUTE = "data-terminal-role";
export const TERMINAL_VIEW_CLASS = "wgpu-terminal";
export const TERMINAL_VIEW_ROLES = Object.freeze({
  viewport: "viewport",
  surface: "surface",
  textView: "text-view",
  input: "input",
  screen: "screen",
  composition: "composition",
  scrollbar: "scrollbar",
  scrollbarThumb: "scrollbar-thumb",
});

const ELEMENT_NAMES = Object.freeze([
  "viewport",
  "surface",
  "textView",
  "input",
  "screen",
  "composition",
  "scrollbar",
  "scrollbarThumb",
]);
const CHILD_NAMES = Object.freeze(["surface", "input", "screen", "composition", "scrollbar"]);
function isNode(value, tagName = null) {
  return (
    value !== null &&
    typeof value === "object" &&
    value.nodeType === 1 &&
    (!tagName || String(value.tagName).toLowerCase() === tagName)
  );
}

function assertNode(value, name, tagName) {
  if (!isNode(value, tagName)) throw new TypeError(`terminal ${name} element is required`);
  return value;
}

function assertElements(elements) {
  if (!elements || typeof elements !== "object" || Array.isArray(elements)) {
    throw new TypeError("terminal elements are required");
  }
  const tags = {
    viewport: "section",
    surface: "div",
    textView: "div",
    input: "textarea",
    screen: "canvas",
    composition: "div",
    scrollbar: "div",
    scrollbarThumb: "div",
  };
  for (const name of ELEMENT_NAMES) assertNode(elements[name], name, tags[name]);
  const { viewport, surface, textView, scrollbar, scrollbarThumb } = elements;
  if (
    !CHILD_NAMES.every((name) => Array.from(viewport.children).includes(elements[name])) ||
    surface.children.length !== 1 ||
    surface.children[0] !== textView ||
    scrollbar.children.length !== 1 ||
    scrollbar.children[0] !== scrollbarThumb
  ) {
    throw new Error("terminal elements have an invalid structure");
  }
  return elements;
}

function documentFor(parent, supplied) {
  const doc = supplied || parent?.ownerDocument || globalThis.document;
  if (!doc || typeof doc.createElement !== "function")
    throw new TypeError("terminal document is required");
  return doc;
}

function mark(element, roleName, viewport = false) {
  element.setAttribute(TERMINAL_VIEW_ROLE_ATTRIBUTE, roleName);
  if (viewport) element.classList.add(TERMINAL_VIEW_CLASS);
  return element;
}

export class TerminalView {
  constructor(options = {}) {
    if (!options || typeof options !== "object")
      throw new TypeError("terminal options are required");
    const hasElements = options.elements !== undefined;
    const hasParent = options.parent !== undefined;
    if (hasElements === hasParent)
      throw new TypeError("exactly one of terminal elements or parent is required");
    this.disposed = false;
    this.generated = false;

    if (hasElements) {
      this.elements = Object.freeze({ ...assertElements(options.elements) });
    } else {
      const parent = assertNode(options.parent, "parent");
      const doc = documentFor(parent, options.document);
      this.generated = true;
      const create = (tag, name) =>
        mark(doc.createElement(tag), TERMINAL_VIEW_ROLES[name], name === "viewport");
      this.viewport = create("section", "viewport");
      this.viewport.setAttribute("role", "application");
      this.viewport.setAttribute("aria-label", "Terminal");
      this.surface = create("div", "surface");
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
      this.scrollbar = create("div", "scrollbar");
      this.scrollbar.setAttribute("role", "scrollbar");
      this.scrollbar.setAttribute("aria-label", "Terminal scrollback");
      this.scrollbar.setAttribute("aria-orientation", "vertical");
      this.scrollbar.setAttribute("tabindex", "0");
      this.scrollbar.hidden = true;
      this.scrollbarThumb = create("div", "scrollbarThumb");
      this.scrollbarThumb.setAttribute("aria-hidden", "true");
      this.surface.append(this.textView);
      this.scrollbar.append(this.scrollbarThumb);
      this.viewport.append(this.surface, this.input, this.screen, this.composition, this.scrollbar);
      parent.append(this.viewport);
      this.elements = Object.freeze(
        Object.fromEntries(ELEMENT_NAMES.map((name) => [name, this[name]])),
      );
    }
    for (const name of ELEMENT_NAMES) this[name] = this.elements[name];
    if (!this.generated) {
      for (const name of ELEMENT_NAMES)
        mark(this[name], TERMINAL_VIEW_ROLES[name], name === "viewport");
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
