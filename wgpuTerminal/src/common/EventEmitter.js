// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

export class EventEmitter {
  constructor(options = {}) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("event emitter options must be an object");
    }
    if (options.onListenerError !== undefined && typeof options.onListenerError !== "function") {
      throw new TypeError("onListenerError must be a function");
    }
    this._listeners = [];
    this._size = 0;
    this._emitting = 0;
    this._needsCompact = false;
    this._disposed = false;
    this._onListenerError = options.onListenerError;
    this.event = this.addListener.bind(this);
  }

  get size() {
    return this._size;
  }

  addListener(listener) {
    if (this._disposed) return { dispose() {} };
    if (typeof listener !== "function") throw new TypeError("event listener must be a function");
    const entry = { listener, active: true };
    this._listeners.push(entry);
    this._size++;
    return {
      dispose: () => {
        if (!entry.active) return;
        entry.active = false;
        this._size--;
        if (this._emitting) {
          this._needsCompact = true;
        } else {
          const index = this._listeners.indexOf(entry);
          if (index !== -1) this._listeners.splice(index, 1);
        }
      },
    };
  }

  emit(value) {
    if (this._disposed || this._size === 0) return false;
    let invoked = false;
    const initialLength = this._listeners.length;
    this._emitting++;
    try {
      for (let i = 0; i < initialLength; i++) {
        const entry = this._listeners[i];
        if (!entry || !entry.active) continue;
        invoked = true;
        try {
          const result = entry.listener(value);
          if (result !== null && result !== undefined && typeof result.then === "function") {
            Promise.resolve(result).catch((error) => {
              if (this._onListenerError) {
                try {
                  this._onListenerError(error);
                } catch (handlerError) {
                  queueMicrotask(() => { throw handlerError; });
                }
              } else {
                queueMicrotask(() => { throw error; });
              }
            });
          }
        } catch (error) {
          if (this._onListenerError) {
            try {
              this._onListenerError(error);
            } catch (handlerError) {
              queueMicrotask(() => { throw handlerError; });
            }
          } else {
            queueMicrotask(() => { throw error; });
          }
        }
      }
    } finally {
      this._emitting--;
      if (this._emitting === 0 && this._needsCompact) {
        let write = 0;
        for (let read = 0; read < this._listeners.length; read++) {
          const entry = this._listeners[read];
          if (entry.active) this._listeners[write++] = entry;
        }
        this._listeners.length = write;
        this._needsCompact = false;
      }
    }
    return invoked;
  }

  clear() {
    for (let i = 0; i < this._listeners.length; i++) {
      this._listeners[i].active = false;
    }
    this._listeners.length = 0;
    this._size = 0;
    this._needsCompact = false;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.clear();
  }
}
