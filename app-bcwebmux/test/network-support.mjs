// SPDX-License-Identifier: MIT
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export async function deadline(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out (${ms}ms)`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class Journal extends EventEmitter {
  constructor() { super(); this.entries = []; this.waiters = new Set(); this.closed = false; }
  add(entry) {
    if (this.entries.length >= 20000) throw new Error("network event journal capacity exceeded");
    entry.at ??= performance.now();
    this.entries.push(entry);
    this.emit("entry", entry);
    return entry;
  }
  wait(predicate, timeout = 10000, after = 0) {
    if (this.closed) return Promise.reject(new Error("journal closed"));
    const existing = this.entries.slice(after).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        clearTimeout(timer); this.off("entry", listener); this.waiters.delete(cancel);
        if (error) reject(error); else resolve(value);
      };
      const listener = event => { try { if (predicate(event)) finish(null, event); } catch (error) { finish(error); } };
      const cancel = () => finish(new Error("journal closed"));
      const timer = setTimeout(() => finish(new Error(`event deadline exceeded (${timeout}ms)`)), timeout);
      this.waiters.add(cancel); this.on("entry", listener);
    });
  }
  close() { this.closed = true; for (const cancel of this.waiters) cancel(); this.removeAllListeners(); }
}

// A suspect old connection intentionally retains input authority. It is NOT
// recovered-path evidence: never send the one-shot response marker onto it.
export async function waitForRestoredController(journal, { after, deadlineAt, ready }) {
  let cursor = after, detection, welcome, barrier, controller;
  for (;;) {
    const remaining = deadlineAt - performance.now();
    if (remaining <= 0) throw new Error("recovery observation deadline exceeded");
    const event = await journal.wait(event => ["state", "welcome", "live-barrier"].includes(event.type), remaining, cursor);
    cursor = journal.entries.indexOf(event) + 1;
    if (event.type === "state" && !event.state.connected) {
      detection ??= event;
      // Public connected includes attachment readiness: WELCOME may be followed
      // by a false snapshot while restore is pending, without another socket loss.
      controller = undefined;
    }
    if (!detection) continue;
    if (event.type === "welcome") { welcome = event; barrier = controller = undefined; }
    if (!welcome) continue;
    if (event.type === "live-barrier" && event.socketId === welcome.socketId) barrier = event;
    // CDP renderer/network notifications can interleave: require both, without
    // assuming the host receives BARRIER before the matching ready snapshot.
    if (event.type === "state") controller = ready(event) ? event : undefined;
    if (barrier && controller) return { detection, welcome, barrier, controller };
  }
}

// Must be called at spawn time; readiness is an explicit listening log, never a probe loop.
export function spawnListening(command, args, pattern, timeout = 20000) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
  child.detachedGroup = true;
  let log = "";
  const ready = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, match) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); child.off("exit", exit); child.off("error", failure);
      if (error) reject(error); else resolve(match);
    };
    const exit = (code, signal) => finish(new Error(`${command} exited before readiness: ${code}/${signal}\n${log}`));
    const failure = error => finish(error);
    const timer = setTimeout(() => finish(new Error(`${command} readiness timeout\n${log}`)), timeout);
    const data = bytes => {
      log = (log + bytes).slice(-128 * 1024);
      const match = log.match(pattern);
      if (match) finish(null, match);
    };
    child.stdout.on("data", data); child.stderr.on("data", data);
    child.once("exit", exit); child.once("error", failure);
  });
  return { child, ready, get log() { return log; } };
}
