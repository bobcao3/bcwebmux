// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

export { delay };

export async function localTls() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bcwebmux-tls-"));
  const cert = path.join(dir, "cert.pem");
  const key = path.join(dir, "key.pem");
  const result = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  if (result.status !== 0) {
    await rm(dir, { recursive: true, force: true });
    throw new Error("local TLS certificate failed");
  }
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  return { cert, key, dispose: () => rm(dir, { recursive: true, force: true }) };
}

export async function freePort() {
  const listener = net.createServer();
  const listening = once(listener, "listening");
  listener.listen(0, "127.0.0.1");
  await listening;
  const port = listener.address().port;
  await new Promise((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

export async function waitFor(check, timeout, message, interval = 50) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(interval);
  }
  throw new Error(typeof message === "function" ? message() : message);
}

function groupAlive(child) {
  if (!child.detachedGroup || child.pid == null) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signal(child, name) {
  if (child.detachedGroup && child.pid != null) {
    try {
      process.kill(-child.pid, name);
      return;
    } catch {}
  }
  child.kill(name);
}

export async function terminateProcess(child, grace = 1000) {
  if (!child) return;
  const running = child.pid != null && child.exitCode === null && child.signalCode === null;
  // Register before signalling: a fast exit must not be missed.
  const exited = running ? once(child, "exit") : Promise.resolve();
  if (running || groupAlive(child)) signal(child, "SIGTERM");
  if (running) {
    const controller = new AbortController();
    try {
      await Promise.race([exited, delay(grace, undefined, { signal: controller.signal })]);
    } finally {
      controller.abort();
    }
  }
  if (groupAlive(child) || (running && child.exitCode === null && child.signalCode === null)) {
    signal(child, "SIGKILL");
  }
  await exited;
}

export class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.eventWaiters = new Set();
    this.events = [];
    this.disconnected = false;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        this.events.push(message);
        for (const listener of [...(this.listeners.get(message.method) ?? [])])
          listener(message.params);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    socket.addEventListener("close", () => this.disconnect(new Error("CDP disconnected")));
    socket.addEventListener("error", () => this.disconnect(new Error("CDP socket error")));
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("CDP connection timed out")),
      10000,
    );
    socket.addEventListener("error", () => controller.abort(new Error("CDP connection failed")), {
      signal: controller.signal,
    });
    socket.addEventListener("close", () => controller.abort(new Error("CDP connection closed")), {
      signal: controller.signal,
    });
    try {
      await once(socket, "open", { signal: controller.signal });
      return new Cdp(socket);
    } catch (error) {
      try {
        socket.close();
      } catch {}
      throw error;
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }

  on(method, listener) {
    let listeners = this.listeners.get(method);
    if (!listeners) this.listeners.set(method, (listeners = new Set()));
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(method);
    };
  }

  waitEvent(method, predicate = () => true, timeout = 10000) {
    if (this.disconnected) return Promise.reject(new Error("CDP disconnected"));
    return new Promise((resolve, reject) => {
      let timer;
      const waiter = {
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      const cleanup = () => {
        clearTimeout(timer);
        unsubscribe();
        this.eventWaiters.delete(waiter);
      };
      const unsubscribe = this.on(method, (params) => {
        try {
          if (!predicate(params)) return;
        } catch (error) {
          cleanup();
          reject(error);
          return;
        }
        cleanup();
        resolve(params);
      });
      this.eventWaiters.add(waiter);
      timer = setTimeout(() => waiter.reject(new Error(`CDP ${method} timed out`)), timeout);
    });
  }

  // Long browser-evaluated scenarios have their own deadlines; no default request deadline.
  call(method, params = {}, timeout = 0) {
    if (this.disconnected || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP disconnected"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (settle, value) => {
        clearTimeout(timer);
        this.pending.delete(id);
        settle(value);
      };
      const pending = {
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      };
      this.pending.set(id, pending);
      if (timeout > 0)
        timer = setTimeout(() => pending.reject(new Error(`CDP ${method} timed out`)), timeout);
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        pending.reject(error);
      }
    });
  }

  disconnect(error) {
    this.disconnected = true;
    for (const pending of this.pending.values()) pending.reject(error);
    for (const waiter of this.eventWaiters) waiter.reject(error);
    this.listeners.clear();
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = once(this.socket, "close");
    const controller = new AbortController();
    const timeout = delay(2000, undefined, { signal: controller.signal }).then(() => {
      throw new Error("CDP close timed out");
    });
    try {
      this.socket.close();
      await Promise.race([closed, timeout]);
    } finally {
      controller.abort();
      this.disconnect(new Error("CDP closed"));
    }
  }
}
