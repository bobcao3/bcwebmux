// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { programStatusLabel, sessionStatus } from "./SessionStatus.js";
import { html, nothing, render } from "./lib/lit-html/lit-html.js";
import { repeat } from "./lib/lit-html/directives/repeat.js";

const STORAGE_VERSION = "v1";
const LONG_PRESS_MS = 550;
const LONG_PRESS_MOVE_PX = 10;

function lifecycleAction(metadata) {
  return metadata?.state === "creating" ||
    metadata?.state === "running" ||
    metadata?.state === "terminating"
    ? "terminate"
    : "delete";
}

function storageFor(value) {
  if (value !== undefined) return value;
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function makeDialog(doc, kind) {
  const destructive = kind === "confirm";
  const dialogId = `session-${kind}-dialog`;
  const mount = doc.createElement("div");
  render(
    html`<dialog id=${dialogId} aria-labelledby=${`${dialogId}-title`}>
      <h2 id=${`${dialogId}-title`}>
        ${destructive ? "Confirm session removal" : "Rename session"}
      </h2>
      <p id=${`${dialogId}-message`}>
        ${
          destructive
            ? "This action cannot be undone."
            : "Set a name, or leave it empty to use the terminal title."
        }
      </p>
      <form>
        ${
          destructive
            ? nothing
            : html`<input
                type="text"
                maxlength="80"
                autocomplete="off"
                aria-label="Session name"
              />`
        }<button type="button">Cancel</button
        ><button type="submit">${destructive ? "Confirm" : "Save"}</button>
      </form>
    </dialog>`,
    mount,
  );
  const dialog = mount.querySelector("dialog");
  dialog.ownerDocument.body.append(dialog);
  const form = dialog.querySelector("form");
  form.addEventListener("submit", (event) => event.preventDefault());
  const buttons = [...dialog.querySelectorAll("form > button")];
  return {
    dialog,
    title: dialog.querySelector("h2"),
    message: dialog.querySelector("p"),
    form,
    input: dialog.querySelector("input"),
    cancel: buttons[0],
    submit: buttons[1],
    owned: true,
  };
}

export class SessionDrawer {
  #controller;
  #refs;
  #storage;
  #onError;
  #storageKey = null;
  #storageDenied = false;
  #preference = null;
  #media = null;
  #narrow = false;
  #open = false;
  #initialized = false;
  #renderQueued = false;
  #disposed = false;
  #focusBeforeOpen = null;
  #confirm = null;
  #longPress = null;
  #suppressedClick = null;
  #contextSessionId = null;
  #listenerController = new AbortController();
  #subscriptions = [];
  #tabs = new Map();
  #workspaceFor = null;
  #ownedDialogs = [];

  constructor(controllerOrOptions, refs = {}) {
    const options = controllerOrOptions?.controller
      ? controllerOrOptions
      : { controller: controllerOrOptions, refs };
    this.#controller = options.controller;
    this.#onError = typeof options.onError === "function" ? options.onError : null;
    const source =
      options.elements ??
      options.refs ??
      (controllerOrOptions?.controller ? controllerOrOptions : refs);
    this.#refs = {
      drawer: source.drawer ?? source.element,
      shell: source.shell ?? source.appShell ?? source.drawer?.parentElement,
      tabs: source.tabs ?? source.tablist ?? source.sessionTabs,
      newButton: source.newButton ?? source.createButton,
      toggleButton: source.toggleButton ?? source.hamburger,
      workspace: source.workspace ?? source.terminal,
      backdrop: source.backdrop,
      liveRegion: source.liveRegion ?? source.status,
      renameDialog: source.renameDialog,
      renameInput: source.renameInput,
      renameForm: source.renameForm,
      renameCancel: source.renameCancel,
      renameSubmit: source.renameSubmit ?? source.renameSave,
      confirmDialog: source.confirmDialog ?? source.actionDialog,
      confirmMessage: source.confirmMessage ?? source.actionMessage,
      confirmForm: source.confirmForm ?? source.actionForm,
      confirmCancel: source.confirmCancel ?? source.actionCancel,
      confirmSubmit: source.confirmSubmit ?? source.actionConfirm,
    };
    this.#storage = storageFor(options.storage);
    if (options.storageScope) this.setStorageScope(options.storageScope);
  }

  init() {
    if (this.#disposed) throw new Error("session drawer is disposed");
    if (this.#initialized) return this;
    if (!this.#controller || !this.#refs.drawer || !this.#refs.tabs)
      throw new TypeError("SessionDrawer requires controller, drawer, and tabs");
    const doc = this.#refs.drawer.ownerDocument ?? document;
    this.#media = globalThis.matchMedia?.("(max-width: 720px)") ?? { matches: false };
    this.#narrow = Boolean(this.#media.matches);
    this.#refs.tabs.setAttribute("role", "tablist");
    this.#refs.tabs.setAttribute("aria-orientation", "vertical");
    if (this.#refs.drawer.id) this.#refs.tabs.setAttribute("aria-label", "Sessions");
    this.#ensureContextMenu(doc);
    this.#ensureDialogs(doc);
    this.#add(this.#refs.newButton, "click", () => this.#create());
    this.#add(this.#refs.toggleButton, "click", () => this.toggle());
    this.#add(this.#refs.backdrop, "click", () => this.close());
    this.#add(this.#refs.tabs, "pointerdown", (event) => this.#startLongPress(event));
    this.#add(this.#refs.tabs, "pointermove", (event) => this.#moveLongPress(event));
    this.#add(this.#refs.tabs, "pointerup", () => this.#cancelLongPress());
    this.#add(this.#refs.tabs, "pointercancel", () => this.#cancelLongPress());
    this.#add(this.#refs.tabs, "contextmenu", (event) => this.#openPointerContextMenu(event));
    this.#add(this.#refs.tabs, "scroll", () => this.#closeContextMenu());
    this.#add(this.#refs.tabs, "keydown", (event) => this.#tabKey(event));
    this.#add(this.#refs.tabs, "click", (event) => this.#onTabsClick(event));
    this.#add(this.#refs.renameForm, "submit", (event) => {
      event.preventDefault();
      if (event.submitter === this.#refs.renameCancel)
        return this.#closeDialog(this.#refs.renameDialog);
      this.#rename();
    });
    if (
      this.#refs.renameCancel &&
      (this.#refs.renameCancel.type !== "submit" ||
        this.#refs.renameCancel.form !== this.#refs.renameForm)
    ) {
      this.#add(this.#refs.renameCancel, "click", () => this.#closeDialog(this.#refs.renameDialog));
    }
    this.#add(this.#refs.confirmForm, "submit", (event) => {
      event.preventDefault();
      this.#confirmAction();
    });
    if (
      this.#refs.confirmSubmit &&
      (!this.#refs.confirmForm || this.#refs.confirmSubmit.form !== this.#refs.confirmForm)
    ) {
      this.#add(this.#refs.confirmSubmit, "click", () => this.#confirmAction());
    }
    this.#add(this.#refs.confirmCancel, "click", () => this.#closeDialog(this.#refs.confirmDialog));
    this.#add(this.#refs.contextRename, "click", () => {
      const id = this.#contextSessionId;
      if (!id) return;
      this.#closeContextMenu();
      this.#tabs.get(id)?.focus();
      this.#showRename(id);
    });
    this.#add(this.#refs.contextLifecycle, "click", () => {
      const id = this.#contextSessionId;
      if (!id) return;
      const action = lifecycleAction(this.#controller.get(id));
      this.#closeContextMenu();
      this.#tabs.get(id)?.focus();
      this.#showConfirm(id, action);
    });
    this.#add(this.#refs.contextMenu, "keydown", (event) => this.#contextMenuKey(event));
    this.#add(doc, "pointerdown", (event) => {
      if (!this.#refs.contextMenu.hidden && !this.#refs.contextMenu.contains(event.target))
        this.#closeContextMenu();
    });
    this.#add(globalThis, "resize", () => this.#closeContextMenu());
    this.#add(this.#refs.renameDialog, "cancel", (event) => {
      event.preventDefault();
      this.#closeDialog(this.#refs.renameDialog);
    });
    this.#add(this.#refs.confirmDialog, "cancel", (event) => {
      event.preventDefault();
      this.#closeDialog(this.#refs.confirmDialog);
    });
    this.#add(globalThis, "keydown", (event) => {
      if (event.key === "Escape" && !this.#refs.contextMenu.hidden) {
        event.preventDefault();
        this.#closeContextMenu(true);
        return;
      }
      if (
        event.key === "Escape" &&
        this.#narrow &&
        this.#open &&
        !this.#refs.renameDialog?.open &&
        !this.#refs.confirmDialog?.open
      ) {
        event.preventDefault();
        this.close();
      }
    });
    this.#add(this.#media, "change", (event) => {
      this.#narrow = Boolean(event.matches);
      this.#apply(this.#desiredOpen(), false);
    });
    for (const name of ["onChange", "onActiveChange"]) {
      const subscribe = this.#controller[name];
      if (typeof subscribe === "function")
        this.#subscriptions.push(
          subscribe.call(this.#controller, () => {
            if (name === "onActiveChange" && this.#narrow && this.#open) {
              this.#apply(false, false);
              this.#restoreFocus();
            }
            this.#scheduleRender();
          }),
        );
    }
    if (typeof this.#controller.onError === "function")
      this.#subscriptions.push(
        this.#controller.onError((error) => this.#announce(error?.message || String(error))),
      );
    this.#initialized = true;
    this.#apply(this.#desiredOpen(), false);
    this.render();
    return this;
  }

  setStorageScope(scope, principal) {
    const server = typeof scope === "object" ? (scope?.serverInstance ?? scope?.server) : scope;
    const user = typeof scope === "object" ? scope?.principal : principal;
    if (!server || !user) {
      this.#storageKey = null;
      this.#preference = null;
      return this;
    }
    this.#storageKey = `bcwebmux.drawer:${STORAGE_VERSION}:${encodeURIComponent(String(server))}:${encodeURIComponent(String(user))}`;
    this.#preference = null;
    if (this.#storage) {
      try {
        const value = this.#storage.getItem(this.#storageKey);
        this.#preference = value === "open" || value === "closed" ? value === "open" : null;
      } catch {
        this.#storageDenied = true;
      }
    }
    if (this.#initialized) this.#apply(this.#desiredOpen(), false);
    return this;
  }

  #scheduleRender() {
    if (this.#renderQueued || this.#disposed) return;
    this.#renderQueued = true;
    queueMicrotask(() => {
      this.#renderQueued = false;
      if (!this.#disposed) this.render();
    });
  }

  render() {
    if (!this.#initialized) return this;
    const tabs = this.#refs.tabs;
    const doc = tabs.ownerDocument;
    const focusedElement = doc.activeElement;
    const focusedInside = Boolean(
      focusedElement && focusedElement !== tabs && tabs.contains(focusedElement),
    );
    const focusedRowId = focusedInside
      ? focusedElement.closest?.(".session-row")?.dataset?.sessionId
      : undefined;
    const focusedControl = focusedInside
      ? ["session-tab", "session-lifecycle"].find((className) =>
          focusedElement.closest?.(`.${className}`),
        )
      : undefined;
    const activeId =
      this.#controller.activeSessionId == null ? "" : String(this.#controller.activeSessionId);
    const sessions = this.#controller.sessions ?? [];
    const focusId =
      focusedControl === "session-tab" &&
      sessions.some((metadata) => String(metadata.id) === focusedRowId)
        ? focusedRowId
        : sessions.some((metadata) => String(metadata.id) === activeId)
          ? activeId
          : sessions[0]
            ? String(sessions[0].id)
            : "";
    this.#renderRows(sessions, activeId, focusId);
    if (this.#refs.workspace) {
      if (activeId && activeId !== this.#workspaceFor) {
        const tab = this.#tabs.get(activeId);
        if (tab) {
          this.#refs.workspace.setAttribute("role", "tabpanel");
          this.#refs.workspace.setAttribute("aria-labelledby", tab.id);
          this.#workspaceFor = activeId;
        }
      } else if (!activeId) this.#workspaceFor = null;
    }
    // Rows persist across renders, so a press in flight keeps its target and
    // focus never moves while its element is still connected. Only a removed
    // row needs a replacement focus target.
    if (focusedInside && focusedElement && !focusedElement.isConnected && focusId) {
      const targetRow = this.#tabs.get(focusId)?.closest(".session-row") ?? null;
      const sameControl =
        targetRow && focusedControl ? targetRow.querySelector(`.${focusedControl}`) : null;
      if (sameControl && !sameControl.disabled) sameControl.focus();
      else this.#tabs.get(focusId)?.focus();
    }
    return this;
  }

  // Keyed row list: repeat() keeps row elements stable across renders (so
  // clicks and focus survive reorder-free updates) and writes only the
  // bindings whose values changed, which is what makes title, status, and
  // unread ticks cheap.
  #renderRows(sessions, activeId, focusId) {
    const tabs = this.#refs.tabs;
    const workspaceId = this.#refs.workspace?.id ?? "";
    render(
      html`${repeat(
        sessions,
        (metadata) => String(metadata.id),
        (metadata) => {
          const id = String(metadata.id);
          const label = String(metadata.name || metadata.title || "Untitled terminal");
          const attached = Boolean(this.#controller.isAttached?.(id));
          const disconnected = id === activeId && !attached;
          const action = lifecycleAction(metadata);
          const status = sessionStatus(metadata);
          const statusLabel = programStatusLabel(status);
          const detailText = [
            metadata.state === "running" ? "" : metadata.state || "unknown",
            statusLabel,
            disconnected ? "disconnected" : "",
          ]
            .filter(Boolean)
            .join(" · ");
          const active = id === activeId;
          const rowClass = [
            "session-row",
            active ? "is-active" : "",
            metadata.unread ? "is-unread" : "",
            metadata.unreadBell ? "is-unread-bell" : "",
          ]
            .filter(Boolean)
            .join(" ");
          const progress = status?.state === "done" ? 100 : status?.progress;
          const tabId = `session-tab-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
          const tabLabel = metadata.unreadBell
            ? `${label} · unread bell · unread activity`
            : metadata.unread
              ? `${label} · unread activity`
              : label;
          const lifecycleLabel = `${action === "terminate" ? "Terminate" : "Remove"} ${label}`;
          return html`<div
            class=${rowClass}
            data-session-id=${id}
            data-state=${String(metadata.state || "unknown")}
            data-program-status=${status?.state ?? nothing}
            data-progress=${progress ?? nothing}
          >
            <button
              type="button"
              class="session-tab"
              role="tab"
              data-session-id=${id}
              id=${tabId}
              .tabIndex=${id === focusId ? 0 : -1}
              aria-selected=${String(active)}
              aria-label=${tabLabel}
              aria-haspopup="menu"
              aria-controls=${workspaceId || nothing}
              aria-describedby=${detailText ? `${tabId}-detail` : nothing}
            ></button>
            <div class="session-copy">
              <span class="session-name">${label}</span
              ><span
                class="session-detail"
                id=${`${tabId}-detail`}
                title=${detailText}
                ?hidden=${!detailText}
                >${detailText}</span
              >
            </div>
            <button
              type="button"
              class="session-lifecycle"
              aria-label=${lifecycleLabel}
              title=${lifecycleLabel}
              .disabled=${metadata.state === "creating" || metadata.state === "terminating"}
            >
              <span class="session-lifecycle-icon" aria-hidden="true"
                >${action === "terminate" ? "■" : "×"}</span
              ><svg class="session-bell-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
              </svg>
            </button>
          </div>`;
        },
      )}`,
      tabs,
    );
    this.#tabs.clear();
    for (const row of tabs.children) {
      if (row.dataset?.sessionId == null) continue;
      const tab = row.querySelector(".session-tab");
      if (tab) this.#tabs.set(row.dataset.sessionId, tab);
      // The progress custom property goes through CSSOM, not a style
      // binding: style-src 'self' blocks style attributes but exempts
      // element.style sets, matching the old manual row builder.
      const progressStyle = row.dataset.progress ? `${row.dataset.progress}%` : "";
      if (row.style.getPropertyValue("--session-progress") !== progressStyle) {
        if (progressStyle) row.style.setProperty("--session-progress", progressStyle);
        else row.style.removeProperty("--session-progress");
      }
    }
  }

  open() {
    this.#rememberFocus();
    this.#apply(true, true);
    this.#focusActive();
    return this;
  }
  close() {
    this.#apply(false, true);
    this.#restoreFocus();
    return this;
  }
  toggle() {
    return this.#open ? this.close() : this.open();
  }
  resetPreference() {
    this.#preference = null;
    if (this.#storage && this.#storageKey) {
      try {
        this.#storage.removeItem(this.#storageKey);
      } catch {
        this.#storageDenied = true;
      }
    }
    this.#apply(this.#desiredOpen(), false);
    return this;
  }

  get isOpen() {
    return this.#open;
  }
  get narrow() {
    return this.#narrow;
  }
  get preference() {
    return this.#preference;
  }
  get storageDenied() {
    return this.#storageDenied;
  }
  get state() {
    return {
      open: this.#open,
      narrow: this.#narrow,
      preference: this.#preference,
      storageDenied: this.#storageDenied,
    };
  }

  #desiredOpen() {
    return this.#preference ?? !this.#narrow;
  }

  #apply(open, persist) {
    this.#open = Boolean(open);
    if (!this.#open) this.#closeContextMenu();
    if (persist) {
      this.#preference = this.#open;
      if (this.#storage && this.#storageKey) {
        try {
          this.#storage.setItem(this.#storageKey, this.#open ? "open" : "closed");
        } catch {
          this.#storageDenied = true;
        }
      }
    }
    const { drawer, shell, toggleButton, backdrop, workspace } = this.#refs;
    drawer.dataset.open = String(this.#open);
    drawer.classList.toggle("is-open", this.#open);
    shell?.classList.toggle("drawer-open", this.#open);
    shell?.classList.toggle("drawer-closed", !this.#open);
    drawer.hidden = this.#narrow && !this.#open;
    drawer.setAttribute("aria-hidden", String(this.#narrow && !this.#open));
    if (backdrop) backdrop.hidden = !this.#narrow || !this.#open;
    const covered = this.#narrow && this.#open;
    if (workspace) {
      workspace.inert = false;
      workspace.toggleAttribute("inert", false);
      workspace.dataset.covered = String(covered);
      const doc = workspace.ownerDocument;
      for (const element of [
        doc.getElementById("terminal-viewport"),
        doc.getElementById("softkeys"),
      ]) {
        if (!element) continue;
        element.inert = covered;
        element.toggleAttribute("inert", covered);
      }
      const controls = doc.getElementById("terminal-controls");
      if (controls)
        for (const child of controls.querySelectorAll("button, [role='status']")) {
          if (child === toggleButton) continue;
          child.inert = covered;
          child.toggleAttribute("inert", covered);
        }
    }
    if (toggleButton) {
      toggleButton.setAttribute("aria-expanded", String(this.#open));
      toggleButton.setAttribute("aria-label", this.#open ? "Close sessions" : "Open sessions");
      toggleButton.setAttribute("title", this.#open ? "Close sessions" : "Open sessions");
      if (drawer.id) toggleButton.setAttribute("aria-controls", drawer.id);
    }
  }

  #rememberFocus() {
    if (!this.#narrow || this.#open) return;
    const active = this.#refs.drawer.ownerDocument.activeElement;
    if (active && active !== this.#refs.drawer && !this.#refs.drawer.contains(active))
      this.#focusBeforeOpen = active;
  }

  #restoreFocus() {
    const target = this.#focusBeforeOpen;
    this.#focusBeforeOpen = null;
    if (this.#narrow && target?.focus) target.focus();
  }

  #focusActive() {
    this.#tabs.get(String(this.#controller.activeSessionId))?.focus();
  }

  #onTabsClick(event) {
    const lifecycle = event.target.closest(".session-lifecycle");
    if (lifecycle && this.#refs.tabs.contains(lifecycle)) {
      event.stopPropagation();
      const id = lifecycle.closest(".session-row")?.dataset?.sessionId;
      if (!id) return;
      const action = lifecycleAction(this.#controller.get(id));
      this.#showConfirm(id, action);
      return;
    }
    const tab = event.target.closest(".session-tab");
    if (!tab || !this.#refs.tabs.contains(tab)) return;
    const id = tab.closest(".session-row")?.dataset?.sessionId ?? tab.dataset.sessionId;
    if (!id) return;
    const suppressed = this.#suppressedClick;
    if (suppressed?.id === id && suppressed.until > performance.now()) {
      event.preventDefault();
      event.stopPropagation();
      this.#suppressedClick = null;
      return;
    }
    this.#suppressedClick = null;
    this.#closeContextMenu();
    this.#select(id);
  }

  #select(id) {
    if (this.#narrow && this.#open) {
      this.#apply(false, false);
      this.#restoreFocus();
    }
    Promise.resolve(this.#controller.switchTo(id)).catch((error) => this.#report(error));
  }

  #tabKey(event) {
    const tabs = [...this.#tabs.values()];
    const currentTab = event.target.closest(".session-tab");
    if (!currentTab || !this.#refs.tabs.contains(currentTab)) return;
    const current = tabs.indexOf(currentTab);
    if (current < 0) return;
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      const rect = currentTab.getBoundingClientRect();
      this.#showContextMenu(currentTab.dataset.sessionId, rect.left + 16, rect.top + 16);
      return;
    }
    let next = current;
    if (event.key === "ArrowUp") next = (current + tabs.length - 1) % tabs.length;
    else if (event.key === "ArrowDown") next = (current + 1) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else if (event.key === "Enter" || event.key === " ")
      return (event.preventDefault(), this.#select(currentTab.dataset.sessionId));
    else return;
    event.preventDefault();
    tabs.forEach((tab, index) => {
      tab.tabIndex = index === next ? 0 : -1;
    });
    tabs[next]?.focus();
  }

  #startLongPress(event) {
    this.#cancelLongPress();
    if (event.pointerType === "mouse" || !event.isPrimary || event.button !== 0) return;
    const row = event.target.closest(".session-row");
    if (!row || !this.#refs.tabs.contains(row) || event.target.closest(".session-lifecycle"))
      return;
    const id = String(row.dataset.sessionId);
    const press = {
      pointerId: event.pointerId,
      id,
      x: event.clientX,
      y: event.clientY,
      timeout: null,
    };
    press.timeout = globalThis.setTimeout(() => {
      if (this.#longPress !== press) return;
      this.#longPress = null;
      this.#suppressedClick = { id, until: performance.now() + 1000 };
      this.#showContextMenu(id, press.x, press.y);
    }, LONG_PRESS_MS);
    this.#longPress = press;
  }

  #moveLongPress(event) {
    const press = this.#longPress;
    if (!press || press.pointerId !== event.pointerId) return;
    if (
      Math.abs(event.clientX - press.x) > LONG_PRESS_MOVE_PX ||
      Math.abs(event.clientY - press.y) > LONG_PRESS_MOVE_PX
    )
      this.#cancelLongPress();
  }

  #cancelLongPress() {
    if (!this.#longPress) return;
    globalThis.clearTimeout(this.#longPress.timeout);
    this.#longPress = null;
  }

  #openPointerContextMenu(event) {
    const row = event.target.closest(".session-row");
    if (!row || !this.#refs.tabs.contains(row)) return;
    event.preventDefault();
    this.#cancelLongPress();
    const id = String(row.dataset.sessionId);
    if (event.pointerType !== "mouse")
      this.#suppressedClick = { id, until: performance.now() + 1000 };
    this.#showContextMenu(id, event.clientX, event.clientY);
  }

  #showContextMenu(id, x, y) {
    const metadata = this.#controller.get(id);
    const menu = this.#refs.contextMenu;
    if (!metadata || !menu) return;
    this.#closeContextMenu();
    const sessionId = String(id);
    const action = lifecycleAction(metadata);
    const label = String(metadata.name || metadata.title || id);
    this.#contextSessionId = sessionId;
    this.#refs.contextRename.textContent = "RENAME";
    this.#refs.contextRename.setAttribute("aria-label", `Rename ${label}`);
    this.#refs.contextLifecycle.textContent = action === "terminate" ? "TERMINATE" : "REMOVE";
    this.#refs.contextLifecycle.setAttribute(
      "aria-label",
      `${action === "terminate" ? "Terminate" : "Remove"} ${label}`,
    );
    this.#refs.contextLifecycle.disabled =
      metadata.state === "creating" || metadata.state === "terminating";
    menu.hidden = false;
    this.#tabs.get(sessionId)?.setAttribute("aria-expanded", "true");
    menu.style.position = "fixed";
    menu.style.left = "0px";
    menu.style.top = "0px";
    const rect = menu.getBoundingClientRect();
    const viewportWidth = menu.ownerDocument.defaultView?.innerWidth ?? globalThis.innerWidth;
    const viewportHeight = menu.ownerDocument.defaultView?.innerHeight ?? globalThis.innerHeight;
    const left = Math.max(8, Math.min(x, viewportWidth - rect.width - 8));
    const top = Math.max(
      8,
      Math.min(
        y + rect.height > viewportHeight ? y - rect.height : y,
        viewportHeight - rect.height - 8,
      ),
    );
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    this.#refs.contextRename.focus({ preventScroll: true });
  }

  #closeContextMenu(restoreFocus = false) {
    const menu = this.#refs.contextMenu;
    if (!menu) return;
    const id = this.#contextSessionId;
    this.#tabs.get(id)?.removeAttribute("aria-expanded");
    menu.hidden = true;
    menu.style.removeProperty("left");
    menu.style.removeProperty("top");
    this.#contextSessionId = null;
    if (restoreFocus) this.#tabs.get(id)?.focus({ preventScroll: true });
  }

  #contextMenuKey(event) {
    const menu = this.#refs.contextMenu;
    const buttons = [...menu.querySelectorAll('button[role="menuitem"]:not(:disabled)')];
    if (!buttons.length) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.#closeContextMenu(true);
      return;
    }
    if (event.key === "Tab") {
      this.#closeContextMenu();
      return;
    }
    let next;
    const current = buttons.indexOf(event.target.closest('button[role="menuitem"]'));
    if (event.key === "ArrowDown") next = (current + 1 + buttons.length) % buttons.length;
    else if (event.key === "ArrowUp") next = (current - 1 + buttons.length) % buttons.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else return;
    event.preventDefault();
    buttons[next]?.focus({ preventScroll: true });
  }

  #showRename(id) {
    const metadata = this.#controller.get(id);
    if (!metadata) return;
    this.#refs.renameInput.value = String(metadata.name ?? "");
    this.#refs.renameDialog.dataset.sessionId = id;
    this.#refs.renameDialog.hidden = false;
    try {
      this.#refs.renameDialog.showModal?.();
    } catch {}
    this.#refs.renameInput.focus();
  }

  async #rename() {
    const id = this.#refs.renameDialog.dataset.sessionId;
    if (!id) return;
    const value = this.#refs.renameInput.value.trim();
    this.#closeDialog(this.#refs.renameDialog);
    try {
      await this.#controller.rename(id, value);
      this.#announce(value ? "Session renamed" : "Session name cleared");
    } catch (error) {
      this.#report(error);
    }
  }

  #showConfirm(id, action) {
    const metadata = this.#controller.get(id);
    if (!metadata) return;
    this.#confirm = { id, action };
    this.#refs.confirmDialog.dataset.sessionId = id;
    this.#refs.confirmDialog.dataset.action = action;
    this.#refs.confirmMessage.textContent = `${action === "terminate" ? "Terminate" : "Remove"} ${String(metadata.name || metadata.title || id)}? This action cannot be undone.`;
    this.#refs.confirmSubmit.textContent = action === "terminate" ? "TERMINATE" : "REMOVE";
    this.#refs.confirmDialog.hidden = false;
    try {
      this.#refs.confirmDialog.showModal?.();
    } catch {}
    this.#refs.confirmCancel.focus();
  }

  async #confirmAction() {
    if (!this.#confirm) return;
    const { id, action } = this.#confirm;
    this.#confirm = null;
    this.#closeDialog(this.#refs.confirmDialog);
    try {
      if (action === "terminate") await this.#controller.terminate(id);
      else {
        await this.#controller.delete(id);
        const activeId = this.#controller.activeSessionId;
        if (activeId != null) this.#tabs.get(String(activeId))?.focus();
      }
      this.#announce(action === "terminate" ? "Session termination requested" : "Session removed");
    } catch (error) {
      this.#report(error);
    }
  }

  async #create() {
    if (this.#narrow) this.close();
    try {
      await this.#controller.create();
      this.#announce("Session created");
    } catch (error) {
      this.#report(error);
    }
  }

  #ensureContextMenu(doc) {
    const mount = doc.createElement("div");
    render(
      html`<div id="session-context-menu" role="menu" aria-label="Session actions" hidden>
        <button type="button" role="menuitem" class="session-context-rename"></button
        ><button type="button" role="menuitem" class="session-context-lifecycle"></button>
      </div>`,
      mount,
    );
    const menu = mount.querySelector("#session-context-menu");
    doc.body.append(menu);
    this.#ownedDialogs.push(menu);
    Object.assign(this.#refs, {
      contextMenu: menu,
      contextRename: menu.querySelector(".session-context-rename"),
      contextLifecycle: menu.querySelector(".session-context-lifecycle"),
    });
  }

  #ensureDialogs(doc) {
    if (!this.#refs.renameDialog) {
      const value = makeDialog(doc, "rename");
      this.#ownedDialogs.push(value.dialog);
      Object.assign(this.#refs, {
        renameDialog: value.dialog,
        renameInput: value.input,
        renameForm: value.form,
        renameCancel: value.cancel,
        renameSubmit: value.submit,
      });
    }
    if (!this.#refs.confirmDialog) {
      const value = makeDialog(doc, "confirm");
      this.#ownedDialogs.push(value.dialog);
      Object.assign(this.#refs, {
        confirmDialog: value.dialog,
        confirmMessage: value.message,
        confirmForm: value.form,
        confirmCancel: value.cancel,
        confirmSubmit: value.submit,
      });
    }
    this.#refs.renameDialog.dataset.sessionId = "";
    this.#refs.confirmMessage ??= this.#refs.confirmDialog.querySelector("p");
    this.#refs.confirmForm ??= this.#refs.confirmDialog.querySelector("form");
    this.#refs.confirmCancel ??= this.#refs.confirmForm?.querySelector("button");
    this.#refs.confirmSubmit ??= this.#refs.confirmForm?.querySelector("button[type=submit]");
    this.#refs.renameInput ??= this.#refs.renameDialog.querySelector("input");
    this.#refs.renameForm ??= this.#refs.renameDialog.querySelector("form");
    this.#refs.renameCancel ??= this.#refs.renameForm?.querySelector("button");
    this.#refs.renameSubmit ??= this.#refs.renameForm?.querySelector("button[type=submit]");
  }

  #closeDialog(dialog) {
    if (!dialog) return;
    try {
      dialog.close?.();
    } catch {}
    dialog.hidden = true;
  }

  #report(error) {
    const message = error?.message || String(error ?? "session error");
    this.#announce(message);
    this.#onError?.(error);
  }

  #announce(message) {
    if (this.#refs.liveRegion) this.#refs.liveRegion.textContent = String(message);
  }

  #add(target, type, listener) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, listener, { signal: this.#listenerController.signal });
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelLongPress();
    this.#closeContextMenu();
    this.#renderQueued = false;
    this.#listenerController.abort();
    for (const subscription of this.#subscriptions.splice(0)) subscription?.dispose?.();
    for (const dialog of this.#ownedDialogs.splice(0)) dialog.remove();
    this.#tabs.clear();
  }
}
