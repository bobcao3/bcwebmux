// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const STORAGE_VERSION = "v1"
const DEFAULT_CORE_LIMIT = 4

function emitter() {
  const listeners = new Set()
  return { on(listener) { if (typeof listener !== "function") throw new TypeError("listener must be a function"); listeners.add(listener); return { dispose: () => listeners.delete(listener) } }, emit(...args) { for (const listener of [...listeners]) { try { listener(...args) } catch (error) { console.error("session controller listener failed", error) } } }, clear() { listeners.clear() } }
}

function safeStorage(value) { if (value !== undefined) return value; try { return globalThis.localStorage } catch { return null } }

function stringId(value) { const id = value?.id ?? value?.sessionId; return id == null ? "" : String(id) }

function cursor(value) {
  try { const result = BigInt(value ?? 0); return result >= 0n ? result : 0n } catch { return 0n }
}

function copyMetadata(value) {
  const result = { ...value, id: stringId(value) }
  if (!result.id) throw new TypeError("session metadata requires id")
  if (result.generation != null) result.generation = String(result.generation)
  if (result.geometry) result.geometry = { ...result.geometry }
  if (result.state == null) result.state = "running"
  if (result.name == null) result.name = ""
  if (result.title == null) result.title = ""
  return result
}

function activityTime(metadata) { return Number(metadata.lastActivityMs ?? metadata.last_activity_ms ?? 0) || 0 }

function sameObservableMetadata(a, b) {
  if (a === b) return true
  const aGeometry = a?.geometry
  const bGeometry = b?.geometry
  const aController = a?.controller
  const bController = b?.controller
  return (
    Object.is(a?.generation == null ? null : String(a.generation), b?.generation == null ? null : String(b.generation)) &&
    Object.is(a?.name == null ? null : String(a.name), b?.name == null ? null : String(b.name)) &&
    Object.is(a?.title == null ? null : String(a.title), b?.title == null ? null : String(b.title)) &&
    Object.is(a?.state == null ? null : String(a.state), b?.state == null ? null : String(b.state)) &&
    Object.is(Number(a?.createdAtMs ?? 0), Number(b?.createdAtMs ?? 0)) &&
    Object.is(Number(a?.lastActivityMs ?? 0), Number(b?.lastActivityMs ?? 0)) &&
    Object.is(Number(a?.attachments ?? 0), Number(b?.attachments ?? 0)) &&
    Object.is(Number(a?.checkpointBytes ?? 0), Number(b?.checkpointBytes ?? 0)) &&
    Object.is(cursor(a?.eventSeq), cursor(b?.eventSeq)) &&
    Object.is(cursor(a?.outputOffset), cursor(b?.outputOffset)) &&
    Object.is(cursor(a?.checkpointEventSeq), cursor(b?.checkpointEventSeq)) &&
    Object.is(aController?.attachmentId == null ? null : String(aController.attachmentId), bController?.attachmentId == null ? null : String(bController.attachmentId)) &&
    Object.is(aController?.leaseEpoch == null ? null : String(aController.leaseEpoch), bController?.leaseEpoch == null ? null : String(bController.leaseEpoch)) &&
    Object.is(a?.exitStatus, b?.exitStatus) &&
    Object.is(Number(aGeometry?.cols ?? 0), Number(bGeometry?.cols ?? 0)) &&
    Object.is(Number(aGeometry?.rows ?? 0), Number(bGeometry?.rows ?? 0)) &&
    Object.is(Number(aGeometry?.cellWidthPx ?? 0), Number(bGeometry?.cellWidthPx ?? 0)) &&
    Object.is(Number(aGeometry?.cellHeightPx ?? 0), Number(bGeometry?.cellHeightPx ?? 0))
  )
}

export class SessionController {
  #terminal; #api; #transport; #storage; #coreLimit
  #metadata = new Map()
  #removedIds = new Set()
  #cores = new Map()
  #activeId = null; #started = false; #disposed = false; #startPromise = null
  #refreshing = false; #refreshQueued = false; #refreshTimer = 0
  #switchTail = Promise.resolve(); #pendingSwitches = new Map()
  #subscriptions = []
  #events = { change: emitter(), active: emitter(), title: emitter(), bell: emitter(), notification: emitter(), error: emitter(), status: emitter() }
  #serverInfo = null; #storageKey = null; #storageDenied = false; #listRevision = 0

  constructor(options = {}) {
    this.#terminal = options.terminal ?? options.host
    this.#api = options.api ?? options.sessionApi
    this.#transport = options.transport
    this.#storage = safeStorage(options.storage)
    const coreLimit = Number(options.coreLimit ?? DEFAULT_CORE_LIMIT)
    this.#coreLimit = Number.isFinite(coreLimit) ? Math.max(1, Math.floor(coreLimit)) : DEFAULT_CORE_LIMIT
    if (!this.#terminal || !this.#api || !this.#transport) throw new TypeError("SessionController requires terminal, api, and transport")
    this.#subscriptions.push(this.#transport.onStatus?.((label, state) => {
      this.#events.status.emit(label, state)
      this.#events.change.emit({ type: "status", label, state, controller: this })
      this.#syncPointers()
    }))
    this.#subscriptions.push(this.#transport.onError?.(error => this.#reportError(error, true)))
    this.#subscriptions.push(this.#transport.onSessionChanged?.(revision => {
      if (!this.#started || !this.#serverInfo) return
      const incomingRevision = Number(revision)
      if (Number.isFinite(incomingRevision)) this.#listRevision = Math.max(this.#listRevision, incomingRevision)
      if (this.#refreshing) this.#refreshQueued = true
      else this.refresh().catch(error => this.#reportError(error, true))
    }))
  }

  onChange(listener) { return this.#events.change.on(listener) } onActiveChange(listener) { return this.#events.active.on(listener) } onTitleChange(listener) { return this.#events.title.on(listener) } onBell(listener) { return this.#events.bell.on(listener) }
  onNotification(listener) { return this.#events.notification.on(listener) } onError(listener) { return this.#events.error.on(listener) } onStatus(listener) { return this.#events.status.on(listener) } on(event, listener) { return this.#events[event]?.on(listener) ?? (() => { throw new Error(`unknown controller event: ${event}`) })() }

  get metadata() { return this.#metadata } get sessions() { return [...this.#metadata.values()] } get activeSession() { return this.#activeId ? this.#metadata.get(this.#activeId) ?? null : null } get active() { return this.activeSession } get activeSessionId() { return this.#activeId } get activeAttachment() { this.#syncPointers(); return this.#activeId ? this.#cores.get(this.#activeId)?.attachment ?? null : null }
  get activeCore() { this.#syncPointers(); return this.#activeId ? this.#cores.get(this.#activeId)?.core ?? null : null } get pendingSwitches() { return [...this.#pendingSwitches.keys()] } get coreCount() { return this.#cores.size } get coreLimit() { return this.#coreLimit } get serverInfo() { return this.#serverInfo } get storageKey() { return this.#storageKey } get storageDenied() { return this.#storageDenied }
  get storageScope() {
    return this.#serverInfo ? {
      serverInstance: this.#serverInfo.serverInstance,
      principal: this.#serverInfo.principal,
    } : null
  }
  get state() {
    return {
      activeSessionId: this.#activeId,
      pendingSwitches: this.pendingSwitches,
      coreCount: this.#cores.size,
      started: this.#started,
      storageDenied: this.#storageDenied,
      transport: this.#transport.state,
    }
  }

  get(id) { return this.#metadata.get(String(id)) ?? null } isAttached(id) { const attachment = this.#cores.get(String(id))?.attachment; return Boolean(attachment?.active && attachment?.live) }
  isController(id) { return Boolean(this.#cores.get(String(id))?.attachment?.controller) }

  start() {
    if (this.#disposed) return Promise.reject(new Error("session controller is disposed")); if (this.#startPromise) return this.#startPromise
    this.#started = true
    this.#startPromise = this.#start().catch(error => {
      this.#reportError(error, true)
      throw error
    })
    return this.#startPromise
  }

  initialize() { return this.start() }

  async #start() {
    this.#transport.activate?.(this.#terminal)
    const [info, list] = await Promise.all([this.#api.info(), this.#api.list(), this.#transport.connect()])
    this.#serverInfo = info ?? {}
    if (info?.protocol !== "bcw.sessions") throw new Error("unsupported session protocol")
    this.#setStorageScope(this.#serverInfo.serverInstance ?? this.#serverInfo.server_instance ?? "server", this.#serverInfo.principal ?? "principal")
    this.#replaceList(list)
    let selected = this.#readLastSession()
    if (!selected || !this.#metadata.has(selected)) selected = this.sessions.filter(item => item.state === "running").sort((a, b) => activityTime(b) - activityTime(a))[0]?.id
    if (!selected) {
      const created = await this.create({ activate: false })
      selected = created.id
    }
    await this.switchTo(selected)
    this.#writeLastSession(selected)
    this.#events.change.emit({ type: "started", controller: this })
    if (!this.#refreshTimer) this.#refreshTimer = setInterval(() => {
      if (globalThis.document?.hidden === true) return
      if (!this.sessions.some(session => !this.isAttached(session.id))) return
      this.refresh().catch(error => this.#reportError(error, false))
    }, 3000)
    return this.activeSession
  }

  async refresh() {
    if (this.#disposed) throw new Error("session controller is disposed")
    if (this.#refreshing) return this.sessions
    this.#refreshing = true
    try {
      const requestedAtRevision = this.#listRevision
      const list = await this.#api.list()
      this.#replaceList(list, requestedAtRevision)
      this.#syncPointers()
      return this.sessions
    } finally {
      this.#refreshing = false
      if (this.#refreshQueued) {
        this.#refreshQueued = false
        queueMicrotask(() => this.refresh().catch(error => this.#reportError(error, false)))
      }
    }
  }

  async switchTo(id) {
    const key = String(id)
    if (!this.#metadata.has(key)) throw new Error(`unknown session: ${key}`)
    const entry = this.#cores.get(key)
    if (this.#activeId === key && entry?.attachment?.active) {
      if (entry.attachment.live) return this.activeSession
      return this.#waitForLive(key, entry)
    }
    if (this.#activeId === key && entry?.attachment && !entry.attachment.active) entry.attachment = null
    const existing = this.#pendingSwitches.get(key)
    if (existing) return existing
    const operation = this.#switchTail.then(() => this.#switchNow(key))
    this.#switchTail = operation.catch(() => {})
    this.#pendingSwitches.set(key, operation)
    operation.then(() => this.#pendingSwitches.delete(key), () => this.#pendingSwitches.delete(key)); return operation
  }

  select(id) { return this.switchTo(id) }

  async #switchNow(key) {
    if (this.#disposed) throw new Error("session controller is disposed")
    const target = this.#metadata.get(key)
    const oldKey = this.#activeId
    const old = oldKey ? this.#cores.get(oldKey) : null
    this.#syncPointers()
    const entry = await this.#ensureEntry(target)
    let record
    try {
      record = await this.#attach(entry, target, entry === old)
      this.#syncEntry(entry, record)
      if (record.live === false) throw new Error("session attachment did not reach the live barrier")
    } catch (error) {
      this.#syncEntry(entry, record)
      if (entry !== old) this.#closeEntry(entry)
      else this.#detach(entry)
      this.#reportError(error, false)
      throw error
    }
    const oldRecord = old?.attachment ?? null
    const oldCore = old?.core ?? this.#terminal.core ?? null
    const rendererHandoff = Boolean(oldCore && this.#terminal.core !== entry.core)
    try {
      if (rendererHandoff) {
        this.#terminal.commitComposition()
        this.#terminal.suspendFocus()
      }
      if (this.#terminal.core !== entry.core) this.#terminal.attachCore(entry.core)
      this.#transport.setActive(record)
      this.#activeId = key
      this.#terminal.resumeFocus?.({ focus: true })
      target.unread = false
      this.#events.title.emit(target.title, target, this)
      this.#touch(entry)
      this.#writeLastSession(key)
      this.#events.active.emit(target, this)
      this.#events.change.emit({ type: "active", session: target, controller: this })
      if (old && oldKey !== key && oldRecord) this.#detach(old)
      this.#evict()
      return target
    } catch (error) {
      try {
        if (oldCore && this.#terminal.core !== oldCore) this.#terminal.attachCore(oldCore)
        if (oldRecord?.active) this.#transport.setActive(oldRecord)
      } catch (rollbackError) {
        this.#reportError(rollbackError, true)
      }
      this.#activeId = oldKey
      if (entry !== old) this.#closeEntry(entry)
      else this.#detach(entry)
      if (rendererHandoff) this.#terminal.resumeFocus({ focus: true })
      this.#reportError(error, false)
      throw error
    }
  }

  async #attach(entry, metadata, preserveCore) {
    const record = await this.#transport.attach(metadata, entry.core, {
      eventSeq: entry.eventSeq,
      outputOffset: entry.outputOffset,
      preserveCore,
    })
    this.#syncEntry(entry, record); return record
  }

  async #waitForLive(key, entry) {
    const attachment = entry.attachment
    const started = Date.now()
    while (Date.now() - started < 3000) {
      if (this.#activeId !== key) throw new Error("session switch was superseded")
      if (this.#activeId === key && entry.attachment === attachment && attachment.active && attachment.live) return this.activeSession
      if (entry.attachment === attachment && !attachment.active) {
        entry.attachment = null
        return this.switchTo(key)
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error("session attachment is reconnecting")
  }

  async #waitForDetach(id, previousCount) {
    const started = Date.now()
    while (Date.now() - started < 1000) {
      const result = await this.#api.get(id)
      if (Number(result?.attachments ?? 0) < previousCount) return
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }

  async #ensureEntry(metadata) {
    let entry = this.#cores.get(metadata.id)
    if (entry && entry.generation && metadata.generation && entry.generation !== String(metadata.generation)) {
      this.#closeEntry(entry)
      entry = null
    }
    if (!entry) {
      this.#makeCoreRoom()
      entry = {
        id: metadata.id,
        generation: metadata.generation ? String(metadata.generation) : "",
        core: null,
        attachment: null,
        eventSeq: 0n,
        outputOffset: 0n,
        listeners: [],
        used: 0,
      }
      this.#cores.set(metadata.id, entry)
    }
    if (!entry.core || entry.core.disposed) {
      const hostCore = this.#terminal.core
      const inUse = [...this.#cores.values()].some(item => item !== entry && item.core === hostCore)
      entry.core = !inUse && hostCore ? hostCore : await this.#terminal.createCore()
      this.#bindCore(entry, metadata)
    }
    this.#touch(entry)
    return entry
  }

  #bindCore(entry, metadata) {
    for (const disposable of entry.listeners.splice(0)) disposable?.dispose?.()
    const bind = (name, handler) => {
      if (typeof entry.core?.[name] === "function") entry.listeners.push(entry.core[name](handler))
    }
    bind("onTitleChange", title => {
      metadata.title = String(title ?? "")
      this.#events.change.emit({ type: "title", session: metadata, controller: this })
      if (this.#activeId === entry.id) this.#events.title.emit(metadata.title, metadata, this)
    })
    bind("onBell", () => {
      if (this.#activeId === entry.id) this.#events.bell.emit(metadata, this)
      else metadata.unread = true
      this.#events.change.emit({ type: "bell", session: metadata, controller: this })
    })
    bind("onNotification", notification => {
      metadata.lastNotification = { title: String(notification?.title ?? ""), body: String(notification?.body ?? "") }
      const active = this.#activeId === entry.id
      if (!active) metadata.unread = true
      this.#events.notification.emit(metadata.lastNotification, metadata, active, this)
      this.#events.change.emit({ type: "notification", session: metadata, controller: this })
    })
    bind("onError", error => {
      metadata.error = error?.message || String(error)
      this.#events.change.emit({ type: "core-error", session: metadata, controller: this })
      if (this.#activeId === entry.id) this.#reportError(error, false)
    })
  }

  #syncEntry(entry, record) {
    if (!record) return
    entry.attachment = record
    if (record.core && record.core !== entry.core) {
      entry.core = record.core
      this.#bindCore(entry, this.#metadata.get(entry.id))
    }
    entry.eventSeq = cursor(record.eventSeq ?? entry.eventSeq)
    entry.outputOffset = cursor(record.outputOffset ?? entry.outputOffset)
    const metadata = this.#metadata.get(entry.id)
    if (metadata) {
      metadata.eventSeq = entry.eventSeq.toString()
      metadata.outputOffset = entry.outputOffset.toString()
    }
    if (record.metadata && record.metadata !== metadata) {
      record.metadata = metadata
    }
    if (typeof record.generation === "string") entry.generation = record.generation
  }

  #syncPointers() { for (const entry of this.#cores.values()) if (entry.attachment) this.#syncEntry(entry, entry.attachment) }

  #detach(entry) {
    if (!entry) return
    this.#syncEntry(entry, entry.attachment)
    if (entry.attachment) {
      try { this.#transport.detach(entry.attachment) } catch (error) { this.#reportError(error, true) }
      entry.attachment = null
    }
    this.#touch(entry)
    this.#events.change.emit({ type: "detached", session: this.#metadata.get(entry.id), controller: this })
  }

  #closeEntry(entry) {
    this.#detach(entry)
    for (const disposable of entry.listeners.splice(0)) disposable?.dispose?.()
    entry.core?.dispose?.()
    entry.core = null
    this.#cores.delete(entry.id)
  }

  #touch(entry) { entry.used = Date.now(); if (this.#cores.get(entry.id) === entry) { this.#cores.delete(entry.id); this.#cores.set(entry.id, entry) } }

  #makeCoreRoom() {
    while (this.#cores.size >= this.#coreLimit) {
      const candidate = [...this.#cores.values()].find(entry => entry.id !== this.#activeId && !entry.attachment)
      if (!candidate) throw new Error("terminal core limit is fully occupied")
      this.#closeEntry(candidate)
    }
  }

  #evict() { while (this.#cores.size > this.#coreLimit) { const candidate = [...this.#cores.values()].find(entry => entry.id !== this.#activeId && !this.#pendingSwitches.has(entry.id) && !entry.attachment); if (!candidate) return; this.#closeEntry(candidate) } }

  #replaceList(payload, requestedAtRevision = null) {
    const values = Array.isArray(payload) ? payload : payload?.sessions ?? []
    const incomingRevision = Number(payload?.revision ?? 0)
    if (incomingRevision > 0 && incomingRevision < this.#listRevision) return
    if (incomingRevision > 0 && requestedAtRevision != null && this.#listRevision > requestedAtRevision && incomingRevision <= this.#listRevision) return
    if (Number.isFinite(incomingRevision)) this.#listRevision = Math.max(this.#listRevision, incomingRevision)
    const seen = new Set()
    let changed = false
    for (const value of values) {
      const metadata = copyMetadata(value)
      if (this.#removedIds.has(metadata.id)) continue
      const previous = this.#metadata.get(metadata.id)
      const unread = previous?.unread ?? false
      const hasNewActivity = Boolean(previous && metadata.id !== this.#activeId && cursor(metadata.outputOffset) > cursor(previous.outputOffset))
      const error = previous?.error ?? null
      const observableChanged = Boolean(previous && !sameObservableMetadata(previous, metadata))
      if (previous) Object.assign(previous, metadata)
      else {
        this.#metadata.set(metadata.id, metadata)
        changed = true
      }
      const current = this.#metadata.get(metadata.id)
      current.unread = (metadata.unread ?? unread) || hasNewActivity
      current.error = metadata.error ?? error
      if (observableChanged) changed = true
      if (previous && unread !== current.unread) changed = true
      if (previous && error !== current.error) changed = true
      seen.add(metadata.id)
    }
    for (const [id, entry] of [...this.#cores]) if (!seen.has(id) && id !== this.#activeId && !this.#pendingSwitches.has(id)) { this.#closeEntry(entry); changed = true }
    for (const id of [...this.#metadata.keys()]) if (!seen.has(id) && id !== this.#activeId && !this.#pendingSwitches.has(id)) { this.#metadata.delete(id); changed = true }
    if (changed) this.#events.change.emit({ type: "list", controller: this, revision: this.#listRevision })
  }

  #setStorageScope(serverInstance, principal) { const server = encodeURIComponent(String(serverInstance || "server")); const user = encodeURIComponent(String(principal || "principal")); this.#storageKey = `bcwebmux.last-session:${STORAGE_VERSION}:${server}:${user}`; this.#storageDenied = false }

  #readLastSession() { if (!this.#storage || !this.#storageKey) return null; try { return this.#storage.getItem(this.#storageKey) || null } catch { this.#storageDenied = true; return null } }

  #writeLastSession(id) { if (!this.#storage || !this.#storageKey) return; try { this.#storage.setItem(this.#storageKey, String(id)) } catch { this.#storageDenied = true } }

  #reportError(error, global) { const value = error instanceof Error ? error : new Error(String(error ?? "session error")); this.#events.error.emit(value, global, this); this.#events.change.emit({ type: "error", error: value, global, controller: this }) }

  async create(options = {}) {
    const state = this.#terminal.state ?? {}
    const geometry = options.geometry ?? {
      cols: this.#terminal.cols || state.cols || 80,
      rows: this.#terminal.rows || state.rows || 24,
      cellWidthPx: Math.round(state.physicalCellWidth || 8),
      cellHeightPx: Math.round(state.physicalCellHeight || 16),
    }
    const created = await this.#api.create({
      profile: options.profile ?? "shell",
      name: options.name == null ? "" : String(options.name),
      geometry,
    })
    const metadata = this.#putMetadata(created)
    this.#events.change.emit({ type: "created", session: metadata, controller: this })
    if (options.activate !== false) await this.switchTo(metadata.id)
    return metadata
  }

  newSession(options) { return this.create(options) }

  async rename(id, name) { const key = String(id); const result = await this.#api.rename(key, String(name)); const metadata = this.#putMetadata(result ?? this.#metadata.get(key)); this.#events.change.emit({ type: "renamed", session: metadata, controller: this }); return metadata }

  async terminate(id) { const key = String(id); const result = await this.#api.terminate(key); const metadata = this.#putMetadata(result ?? this.#metadata.get(key)); this.#events.change.emit({ type: "terminated", session: metadata, controller: this }); return metadata }

  async delete(id) {
    const key = String(id)
    const metadata = this.#metadata.get(key)
    if (!metadata) throw new Error(`unknown session: ${key}`)
    const attachedBefore = Math.max(1, Number(metadata.attachments ?? 1))
    const wasActive = this.#activeId === key
    const fallback = wasActive ? this.#fallback(key) : null
    const preservedEntry = wasActive && !fallback ? this.#cores.get(key) : null
    if (wasActive) {
      if (fallback) await this.switchTo(fallback.id)
      else {
        const entry = this.#cores.get(key)
        this.#detach(entry)
        this.#activeId = null
        this.#events.active.emit(null, this)
      }
    }
    if (wasActive) await this.#waitForDetach(key, attachedBefore)
    try {
      await this.#api.delete(key)
    } catch (error) {
      if (wasActive && !this.#activeId) await this.switchTo(key).catch(rollbackError => this.#reportError(rollbackError, true))
      throw error
    }
    this.#removedIds.add(key)
    if (this.#removedIds.size > 64) this.#removedIds.delete(this.#removedIds.values().next().value)
    const entry = this.#cores.get(key)
    if (entry && !preservedEntry) this.#closeEntry(entry)
    this.#metadata.delete(key)
    this.#events.change.emit({ type: "deleted", id: key, controller: this })
    if (wasActive && !this.#activeId) {
      try {
        await this.create()
        if (preservedEntry) this.#closeEntry(preservedEntry)
      } catch (error) { this.#reportError(error, true) }
    }
    return true
  }

  #fallback(exclude) { return this.sessions.filter(item => item.id !== exclude).sort((a, b) => { const running = Number(b.state === "running") - Number(a.state === "running"); return running || activityTime(b) - activityTime(a) })[0] ?? null }

  async claim(id = this.#activeId) { const key = String(id); if (this.#activeId !== key) await this.switchTo(key); const attachment = this.#cores.get(key)?.attachment; if (!attachment?.active || !attachment.live) throw new Error("session attachment is reconnecting"); const result = this.#transport.claimControl(attachment); if (result === false) throw new Error("session attachment is reconnecting"); this.#events.change.emit({ type: "claim", session: this.#metadata.get(key), controller: this }); return result }

  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    clearInterval(this.#refreshTimer)
    this.#refreshTimer = 0
    for (const entry of [...this.#cores.values()]) this.#closeEntry(entry)
    for (const subscription of this.#subscriptions.splice(0)) subscription?.dispose?.()
    for (const event of Object.values(this.#events)) event.clear()
    this.#metadata.clear()
    this.#removedIds.clear()
    this.#activeId = null
  }

  #putMetadata(value) {
    const metadata = copyMetadata(value)
    const revision = Number(metadata.revision ?? 0)
    const current = this.#metadata.get(metadata.id)
    if (current) {
      if (revision > 0 && Number.isFinite(revision) && revision < Number(current.revision ?? 0)) return current
      if (Number.isFinite(revision)) this.#listRevision = Math.max(this.#listRevision, revision)
      const unread = current.unread ?? false
      Object.assign(current, metadata)
      current.unread = metadata.unread ?? unread
      return current
    }
    if (Number.isFinite(revision)) this.#listRevision = Math.max(this.#listRevision, revision)
    this.#metadata.set(metadata.id, metadata)
    return metadata
  }
}
