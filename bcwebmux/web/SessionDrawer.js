// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const STORAGE_VERSION = "v1"

function storageFor(value) {
  if (value !== undefined) return value
  try { return globalThis.localStorage } catch { return null }
}

function makeDialog(doc, kind) {
  const destructive = kind === "confirm"
  const dialog = doc.createElement("dialog")
  const title = doc.createElement("h2")
  const message = doc.createElement("p")
  const form = doc.createElement("form")
  const input = destructive ? null : doc.createElement("input")
  const cancel = doc.createElement("button")
  const submit = doc.createElement("button")
  dialog.id = `session-${kind}-dialog`
  dialog.setAttribute("aria-labelledby", `${dialog.id}-title`)
  title.id = `${dialog.id}-title`
  title.textContent = destructive ? "Confirm session removal" : "Rename session"
  message.id = `${dialog.id}-message`
  message.textContent = destructive ? "This action cannot be undone." : "Choose a name for this session."
  form.addEventListener("submit", event => event.preventDefault())
  if (input) {
    input.type = "text"
    input.maxLength = 120
    input.autocomplete = "off"
    input.setAttribute("aria-label", "Session name")
    form.append(input)
  }
  cancel.type = "button"
  cancel.textContent = "Cancel"
  submit.type = "submit"
  submit.textContent = destructive ? "Confirm" : "Save"
  form.append(cancel, submit)
  dialog.append(title, message, form)
  doc.body.append(dialog)
  return { dialog, title, message, form, input, cancel, submit, owned: true }
}

export class SessionDrawer {
  #controller
  #refs
  #storage
  #storageKey = null
  #storageDenied = false
  #preference = null
  #media = null
  #narrow = false
  #open = false
  #initialized = false
  #renderQueued = false
  #disposed = false
  #focusBeforeOpen = null
  #confirm = null
  #dom = []
  #subscriptions = []
  #tabs = new Map()
  #ownedDialogs = []

  constructor(controllerOrOptions, refs = {}) {
    const options = controllerOrOptions?.controller ? controllerOrOptions : { controller: controllerOrOptions, refs }
    this.#controller = options.controller
    const source = options.elements ?? options.refs ?? (controllerOrOptions?.controller ? controllerOrOptions : refs)
    this.#refs = {
      drawer: source.drawer ?? source.element,
      shell: source.shell ?? source.appShell ?? source.drawer?.parentElement,
      tabs: source.tabs ?? source.tablist ?? source.sessionTabs,
      newButton: source.newButton ?? source.createButton,
      toggleButton: source.toggleButton ?? source.hamburger,
      controlButton: source.controlButton ?? source.sessionControl,
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
    }
    this.#storage = storageFor(options.storage)
    if (options.storageScope) this.setStorageScope(options.storageScope)
  }

  init() {
    if (this.#disposed) throw new Error("session drawer is disposed")
    if (this.#initialized) return this
    if (!this.#controller || !this.#refs.drawer || !this.#refs.tabs) throw new TypeError("SessionDrawer requires controller, drawer, and tabs")
    const doc = this.#refs.drawer.ownerDocument ?? document
    this.#media = globalThis.matchMedia?.("(max-width: 720px)") ?? { matches: false }
    this.#narrow = Boolean(this.#media.matches)
    this.#refs.tabs.setAttribute("role", "tablist")
    this.#refs.tabs.setAttribute("aria-orientation", "vertical")
    if (this.#refs.drawer.id) this.#refs.tabs.setAttribute("aria-label", "Sessions")
    this.#ensureDialogs(doc)
    this.#add(this.#refs.newButton, "click", () => this.#create())
    this.#add(this.#refs.toggleButton, "click", () => this.toggle())
    if (!this.#refs.controlButton?.form) this.#add(this.#refs.controlButton, "click", () => {
        const id = this.#controller.activeSessionId
        if (id == null) return
        Promise.resolve(this.#controller.claim(id)).catch(error => this.#announce(error?.message || String(error)))
      })
    this.#add(this.#refs.backdrop, "click", () => this.close())
    this.#add(this.#refs.tabs, "keydown", event => this.#tabKey(event))
    this.#add(this.#refs.renameForm, "submit", event => {
      event.preventDefault()
      if (event.submitter === this.#refs.renameCancel) return this.#closeDialog(this.#refs.renameDialog)
      this.#rename()
    })
    if (this.#refs.renameCancel && (this.#refs.renameCancel.type !== "submit" || this.#refs.renameCancel.form !== this.#refs.renameForm)) {
      this.#add(this.#refs.renameCancel, "click", () => this.#closeDialog(this.#refs.renameDialog))
    }
    this.#add(this.#refs.confirmForm, "submit", event => {
      event.preventDefault()
      this.#confirmAction()
    })
    if (this.#refs.confirmSubmit && (!this.#refs.confirmForm || this.#refs.confirmSubmit.form !== this.#refs.confirmForm)) {
      this.#add(this.#refs.confirmSubmit, "click", () => this.#confirmAction())
    }
    this.#add(this.#refs.confirmCancel, "click", () => this.#closeDialog(this.#refs.confirmDialog))
    this.#add(this.#refs.renameDialog, "cancel", event => { event.preventDefault(); this.#closeDialog(this.#refs.renameDialog) })
    this.#add(this.#refs.confirmDialog, "cancel", event => { event.preventDefault(); this.#closeDialog(this.#refs.confirmDialog) })
    this.#add(globalThis, "keydown", event => {
      if (event.key === "Escape" && this.#narrow && this.#open && !this.#refs.renameDialog?.open && !this.#refs.confirmDialog?.open) {
        event.preventDefault()
        this.close()
      }
    })
    this.#add(this.#media, "change", event => {
      this.#narrow = Boolean(event.matches)
      this.#apply(this.#desiredOpen(), false)
    })
    for (const name of ["onChange", "onActiveChange"]) {
      const subscribe = this.#controller[name]
      if (typeof subscribe === "function") this.#subscriptions.push(subscribe.call(this.#controller, () => {
        if (name === "onActiveChange" && this.#narrow && this.#open) {
          this.#apply(false, false)
          this.#restoreFocus()
        }
        this.#scheduleRender()
      }))
    }
    if (typeof this.#controller.onError === "function") this.#subscriptions.push(this.#controller.onError(error => this.#announce(error?.message || String(error))))
    this.#initialized = true
    this.#apply(this.#desiredOpen(), false)
    this.render()
    return this
  }

  setStorageScope(scope, principal) {
    const server = typeof scope === "object" ? scope?.serverInstance ?? scope?.server : scope
    const user = typeof scope === "object" ? scope?.principal : principal
    if (!server || !user) {
      this.#storageKey = null
      this.#preference = null
      return this
    }
    this.#storageKey = `bcwebmux.drawer:${STORAGE_VERSION}:${encodeURIComponent(String(server))}:${encodeURIComponent(String(user))}`
    this.#preference = null
    if (this.#storage) {
      try {
        const value = this.#storage.getItem(this.#storageKey)
        this.#preference = value === "open" || value === "closed" ? value === "open" : null
      } catch { this.#storageDenied = true }
    }
    if (this.#initialized) this.#apply(this.#desiredOpen(), false)
    return this
  }

  #scheduleRender() {
    if (this.#renderQueued || this.#disposed) return
    this.#renderQueued = true
    queueMicrotask(() => {
      this.#renderQueued = false
      if (!this.#disposed) this.render()
    })
  }

  render() {
    if (!this.#initialized) return this
    const tabs = this.#refs.tabs
    const focusedElement = tabs.ownerDocument.activeElement
    const focusedRowId = focusedElement?.closest?.(".session-row")?.dataset?.sessionId
    const focusedControl = ["session-tab", "session-viewer", "session-rename", "session-lifecycle"].find(className => focusedElement?.closest?.(`.${className}`))
    const activeId = this.#controller.activeSessionId == null ? "" : String(this.#controller.activeSessionId)
    this.#tabs.clear()
    tabs.replaceChildren()
    const sessions = this.#controller.sessions ?? []
    const focusId = focusedControl === "session-tab" && sessions.some(metadata => String(metadata.id) === focusedRowId) ? focusedRowId : (sessions.some(metadata => String(metadata.id) === activeId) ? activeId : (sessions[0] ? String(sessions[0].id) : ""))
    for (const metadata of sessions) {
      const id = String(metadata.id), row = tabs.ownerDocument.createElement("div"), tab = tabs.ownerDocument.createElement("button"), name = tabs.ownerDocument.createElement("span"), detail = tabs.ownerDocument.createElement("span"), unread = tabs.ownerDocument.createElement("span"), viewer = tabs.ownerDocument.createElement("button"), rename = tabs.ownerDocument.createElement("button"), remove = tabs.ownerDocument.createElement("button")
      const label = String(metadata.title || metadata.name || `Session ${id.slice(0, 8)}`), attached = Boolean(this.#controller.isAttached?.(id)), controller = Boolean(this.#controller.isController?.(id)), disconnected = id === activeId && !attached, terminate = metadata.state === "running" || metadata.state === "terminating" || metadata.state === "creating"
      row.className = "session-row"; row.dataset.sessionId = id; row.dataset.state = String(metadata.state || "unknown"); if (viewer) row.style.gridTemplateColumns = "1fr auto auto auto"
      tab.type = "button"; tab.className = "session-tab"; tab.role = "tab"; tab.dataset.sessionId = id; tab.id = `session-tab-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`; tab.tabIndex = id === focusId ? 0 : -1; tab.setAttribute("aria-selected", String(id === activeId)); tab.setAttribute("aria-label", label)
      if (this.#refs.workspace?.id) tab.setAttribute("aria-controls", this.#refs.workspace.id)
      name.className = "session-name"; name.textContent = label; detail.className = "session-detail"; detail.textContent = `${metadata.state || "unknown"}${disconnected ? " · disconnected" : ""}${attached ? controller ? " · controller" : " · viewer" : ""}`; unread.className = metadata.unread ? "session-unread is-unread" : "session-unread"; unread.textContent = ""; unread.setAttribute("aria-label", metadata.unread ? "Unread activity" : "No unread activity"); tab.append(name, detail, unread)
      viewer.type = "button"; viewer.className = "session-viewer"; viewer.style.minWidth = "44px"; viewer.style.minHeight = "44px"; viewer.textContent = disconnected ? "…" : controller ? "●" : attached ? "↯" : "›"; viewer.setAttribute("aria-label", disconnected ? `Reconnect ${label}` : controller ? `Controlling ${label}` : attached ? `Take control of ${label}` : `View ${label}`); viewer.disabled = controller
      rename.type = "button"; rename.className = "session-rename"; rename.style.minWidth = "44px"; rename.style.minHeight = "44px"; rename.textContent = "✎"; rename.setAttribute("aria-label", `Rename ${label}`)
      remove.type = "button"; remove.className = "session-lifecycle"; remove.style.minWidth = "44px"; remove.style.minHeight = "44px"; remove.textContent = terminate ? "■" : "×"; remove.setAttribute("aria-label", `${terminate ? "Terminate" : "Remove"} ${label}`); remove.disabled = metadata.state === "creating" || metadata.state === "terminating"
      row.append(tab, viewer, rename, remove); tabs.append(row); this.#tabs.set(id, tab); tab.addEventListener("click", () => this.#select(id)); viewer.addEventListener("click", event => { event.stopPropagation(); this.#view(id, !disconnected && attached && !controller) }); rename.addEventListener("click", event => { event.stopPropagation(); this.#showRename(id) }); remove.addEventListener("click", event => { event.stopPropagation(); this.#showConfirm(id, terminate ? "terminate" : "delete") })
    }
    if (this.#refs.controlButton) {
      const active = sessions.find(metadata => String(metadata.id) === activeId)
      const attached = active && Boolean(this.#controller.isAttached?.(activeId))
      const controller = attached && Boolean(this.#controller.isController?.(activeId))
      const controlLabel = controller ? "CONTROLLER" : attached ? "TAKE CONTROL" : "RECONNECT"
      this.#refs.controlButton.textContent = controlLabel
      this.#refs.controlButton.setAttribute("aria-label", controlLabel)
      this.#refs.controlButton.dataset.controller = String(controller)
      this.#refs.controlButton.disabled = !active || controller
    }
    if (this.#refs.workspace && activeId) {
      const tab = this.#tabs.get(activeId)
      if (tab) {
        this.#refs.workspace.setAttribute("role", "tabpanel")
        this.#refs.workspace.setAttribute("aria-labelledby", tab.id)
      }
    }
    const focusedRow = focusedRowId && [...tabs.children].find(row => row.dataset.sessionId === focusedRowId)
    const replacement = focusedRow && focusedControl && focusedRow.querySelector(`.${focusedControl}`)
    if (replacement && !replacement.disabled) replacement.focus()
    else if (focusedRowId && this.#tabs.has(focusedRowId)) this.#tabs.get(focusedRowId).focus()
    else if (focusedRowId) this.#tabs.get(focusId)?.focus()
    return this
  }

  open() { this.#rememberFocus(); this.#apply(true, true); this.#focusActive(); return this }
  close() { this.#apply(false, true); this.#restoreFocus(); return this }
  toggle() { return this.#open ? this.close() : this.open() }
  resetPreference() {
    this.#preference = null
    if (this.#storage && this.#storageKey) {
      try { this.#storage.removeItem(this.#storageKey) } catch { this.#storageDenied = true }
    }
    this.#apply(this.#desiredOpen(), false)
    return this
  }

  get isOpen() { return this.#open }
  get narrow() { return this.#narrow }
  get preference() { return this.#preference }
  get storageDenied() { return this.#storageDenied }
  get state() { return { open: this.#open, narrow: this.#narrow, preference: this.#preference, storageDenied: this.#storageDenied } }

  #desiredOpen() { return this.#preference ?? !this.#narrow }

  #apply(open, persist) {
    this.#open = Boolean(open)
    if (persist) {
      this.#preference = this.#open
      if (this.#storage && this.#storageKey) {
        try { this.#storage.setItem(this.#storageKey, this.#open ? "open" : "closed") } catch { this.#storageDenied = true }
      }
    }
    const { drawer, shell, toggleButton, backdrop, workspace } = this.#refs
    drawer.dataset.open = String(this.#open)
    drawer.classList.toggle("is-open", this.#open)
    shell?.classList.toggle("drawer-open", this.#open)
    shell?.classList.toggle("drawer-closed", !this.#open)
    drawer.hidden = this.#narrow && !this.#open
    drawer.setAttribute("aria-hidden", String(this.#narrow && !this.#open))
    if (backdrop) backdrop.hidden = !this.#narrow || !this.#open
    const covered = this.#narrow && this.#open
    if (workspace) {
      workspace.inert = false
      workspace.toggleAttribute("inert", false)
      workspace.dataset.covered = String(covered)
      const doc = workspace.ownerDocument
      for (const element of [doc.getElementById("terminal-viewport"), doc.getElementById("softkeys")]) {
        if (!element) continue
        element.inert = covered
        element.toggleAttribute("inert", covered)
      }
      const controls = doc.getElementById("terminal-controls")
      if (controls) for (const child of controls.children) {
        if (child === toggleButton) continue
        child.inert = covered
        child.toggleAttribute("inert", covered)
      }
    }
    if (toggleButton) {
      toggleButton.setAttribute("aria-expanded", String(this.#open))
      toggleButton.setAttribute("aria-label", this.#open ? "Close sessions" : "Open sessions")
      toggleButton.setAttribute("title", this.#open ? "Close sessions" : "Open sessions")
      if (drawer.id) toggleButton.setAttribute("aria-controls", drawer.id)
    }
  }

  #rememberFocus() {
    if (!this.#narrow || this.#open) return
    const active = this.#refs.drawer.ownerDocument.activeElement
    if (active && active !== this.#refs.drawer && !this.#refs.drawer.contains(active)) this.#focusBeforeOpen = active
  }

  #restoreFocus() {
    const target = this.#focusBeforeOpen
    this.#focusBeforeOpen = null
    if (this.#narrow && target?.focus) target.focus()
  }

  #focusActive() { this.#tabs.get(String(this.#controller.activeSessionId))?.focus() }

  #select(id) {
    if (this.#narrow && this.#open) { this.#apply(false, false); this.#restoreFocus() }
    Promise.resolve(this.#controller.switchTo(id)).catch(error => this.#announce(error?.message || String(error)))
  }

  #view(id, takeControl) {
    if (this.#narrow && this.#open) { this.#apply(false, false); this.#restoreFocus() }
    const operation = takeControl ? this.#controller.claim(id) : this.#controller.switchTo(id)
    Promise.resolve(operation).catch(error => this.#announce(error?.message || String(error)))
  }

  #tabKey(event) {
    const tabs = [...this.#tabs.values()]
    const currentTab = event.target.closest(".session-tab")
    if (!currentTab || !this.#refs.tabs.contains(currentTab)) return
    const current = tabs.indexOf(currentTab)
    if (current < 0) return
    let next = current
    if (event.key === "ArrowUp") next = (current + tabs.length - 1) % tabs.length
    else if (event.key === "ArrowDown") next = (current + 1) % tabs.length
    else if (event.key === "Home") next = 0
    else if (event.key === "End") next = tabs.length - 1
    else if (event.key === "Enter" || event.key === " ") return event.preventDefault(), this.#select(currentTab.dataset.sessionId)
    else return
    event.preventDefault()
    tabs.forEach((tab, index) => { tab.tabIndex = index === next ? 0 : -1 })
    tabs[next]?.focus()
  }

  #showRename(id) {
    const metadata = this.#controller.get(id)
    if (!metadata) return
    this.#refs.renameInput.value = String(metadata.name || metadata.title || "")
    this.#refs.renameDialog.dataset.sessionId = id
    this.#refs.renameDialog.hidden = false
    try { this.#refs.renameDialog.showModal?.() } catch {}
    this.#refs.renameInput.focus()
  }

  async #rename() {
    const id = this.#refs.renameDialog.dataset.sessionId
    if (!id) return
    const value = this.#refs.renameInput.value.trim()
    if (!value) return this.#announce("A session name is required")
    this.#closeDialog(this.#refs.renameDialog)
    try { await this.#controller.rename(id, value); this.#announce("Session renamed") }
    catch (error) { this.#announce(error?.message || String(error)) }
  }

  #showConfirm(id, action) {
    const metadata = this.#controller.get(id)
    if (!metadata) return
    this.#confirm = { id, action }
    this.#refs.confirmDialog.dataset.sessionId = id
    this.#refs.confirmDialog.dataset.action = action
    this.#refs.confirmMessage.textContent = `${action === "terminate" ? "Terminate" : "Remove"} ${String(metadata.title || metadata.name || id)}? This action cannot be undone.`
    this.#refs.confirmSubmit.textContent = action === "terminate" ? "TERMINATE" : "REMOVE"
    this.#refs.confirmDialog.hidden = false
    try { this.#refs.confirmDialog.showModal?.() } catch {}
    this.#refs.confirmCancel.focus()
  }

  async #confirmAction() {
    if (!this.#confirm) return
    const { id, action } = this.#confirm
    this.#confirm = null
    this.#closeDialog(this.#refs.confirmDialog)
    try {
      if (action === "terminate") await this.#controller.terminate(id)
      else {
        await this.#controller.delete(id)
        const activeId = this.#controller.activeSessionId
        if (activeId != null) this.#tabs.get(String(activeId))?.focus()
      }
      this.#announce(action === "terminate" ? "Session termination requested" : "Session removed")
    } catch (error) { this.#announce(error?.message || String(error)) }
  }

  async #create() {
    if (this.#narrow) this.close()
    try { await this.#controller.create(); this.#announce("Session created") }
    catch (error) { this.#announce(error?.message || String(error)) }
  }

  #ensureDialogs(doc) {
    if (!this.#refs.renameDialog) {
      const value = makeDialog(doc, "rename")
      this.#ownedDialogs.push(value.dialog)
      Object.assign(this.#refs, { renameDialog: value.dialog, renameInput: value.input, renameForm: value.form, renameCancel: value.cancel, renameSubmit: value.submit })
    }
    if (!this.#refs.confirmDialog) {
      const value = makeDialog(doc, "confirm")
      this.#ownedDialogs.push(value.dialog)
      Object.assign(this.#refs, { confirmDialog: value.dialog, confirmMessage: value.message, confirmForm: value.form, confirmCancel: value.cancel, confirmSubmit: value.submit })
    }
    this.#refs.renameDialog.dataset.sessionId = ""
    this.#refs.confirmMessage ??= this.#refs.confirmDialog.querySelector("p")
    this.#refs.confirmForm ??= this.#refs.confirmDialog.querySelector("form")
    this.#refs.confirmCancel ??= this.#refs.confirmForm?.querySelector("button")
    this.#refs.confirmSubmit ??= this.#refs.confirmForm?.querySelector("button[type=submit]")
    this.#refs.renameInput ??= this.#refs.renameDialog.querySelector("input")
    this.#refs.renameForm ??= this.#refs.renameDialog.querySelector("form")
    this.#refs.renameCancel ??= this.#refs.renameForm?.querySelector("button")
    this.#refs.renameSubmit ??= this.#refs.renameForm?.querySelector("button[type=submit]")
  }

  #closeDialog(dialog) {
    if (!dialog) return
    try { dialog.close?.() } catch {}
    dialog.hidden = true
  }

  #announce(message) { if (this.#refs.liveRegion) this.#refs.liveRegion.textContent = String(message) }

  #add(target, type, listener) {
    if (!target?.addEventListener) return
    target.addEventListener(type, listener)
    this.#dom.push({ target, type, listener })
  }

  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    this.#renderQueued = false
    for (const item of this.#dom.splice(0)) item.target.removeEventListener?.(item.type, item.listener)
    for (const subscription of this.#subscriptions.splice(0)) subscription?.dispose?.()
    for (const dialog of this.#ownedDialogs.splice(0)) dialog.remove()
    this.#tabs.clear()
  }
}
