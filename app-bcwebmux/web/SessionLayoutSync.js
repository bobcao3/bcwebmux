// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

export class SessionLayoutSync {
  #api;
  #onChange;
  #onError;
  #seed;
  #abort = new AbortController();
  #version = null;
  #initializing = null;
  #tail = Promise.resolve();
  #refreshing = false;
  #refreshQueued = false;

  constructor(api, { seed, onChange, onError }) {
    this.#api = api;
    this.#seed = seed;
    this.#onChange = onChange;
    this.#onError = onError;
  }

  start() {
    void this.#watch();
  }

  move(source, target, position) {
    const operation = this.#tail.then(async () => {
      await this.#initialize();
      const result = await this.#api.updateLayout({ source, target, position }, this.#abort.signal);
      this.#apply(result);
    });
    this.#tail = operation.catch(() => {});
    return operation;
  }

  renameGroup(anchor, name) {
    const operation = this.#tail.then(async () => {
      await this.#initialize();
      const result = await this.#api.updateLayout({ group: anchor, name }, this.#abort.signal);
      this.#apply(result);
    });
    this.#tail = operation.catch(() => {});
    return operation;
  }

  async #initialize() {
    if (this.#version) return;
    if (!this.#initializing) {
      this.#initializing = (async () => {
        const result =
          Array.isArray(this.#seed) && this.#seed.length
            ? await this.#api.updateLayout({ seed: this.#seed }, this.#abort.signal)
            : await this.#api.layout(null, this.#abort.signal);
        this.#seed = null;
        this.#apply(result);
      })().finally(() => {
        this.#initializing = null;
      });
    }
    return this.#initializing;
  }

  async refresh() {
    if (this.#refreshing) {
      this.#refreshQueued = true;
      return;
    }
    this.#refreshing = true;
    try {
      do {
        this.#refreshQueued = false;
        await this.#initialize();
        this.#apply(await this.#api.layout(null, this.#abort.signal));
      } while (this.#refreshQueued && !this.#abort.signal.aborted);
    } catch (error) {
      if (!this.#abort.signal.aborted) this.#onError?.(error);
    } finally {
      this.#refreshing = false;
    }
  }

  #apply(result) {
    if (this.#abort.signal.aborted) return;
    if (
      !result ||
      typeof result.epoch !== "string" ||
      !Number.isSafeInteger(result.revision) ||
      !Array.isArray(result.layout)
    ) {
      throw new Error("Invalid session layout response");
    }
    if (this.#version?.epoch === result.epoch && this.#version.revision >= result.revision) return;
    this.#version = { epoch: result.epoch, revision: result.revision };
    this.#onChange(result.layout);
  }

  async #watch() {
    let reported = false;
    while (!this.#abort.signal.aborted) {
      try {
        await this.#initialize();
        const result = await this.#api.layout(this.#version, this.#abort.signal);
        this.#apply(result);
        reported = false;
      } catch (error) {
        if (this.#abort.signal.aborted) return;
        if (!reported) this.#onError?.(error);
        reported = true;
        await new Promise((resolve) => {
          const signal = this.#abort.signal;
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, 2000);
          signal.addEventListener("abort", done, { once: true });
        });
      }
    }
  }

  dispose() {
    this.#abort.abort();
  }
}
