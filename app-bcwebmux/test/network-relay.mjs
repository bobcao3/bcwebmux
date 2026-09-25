// SPDX-License-Identifier: MIT
// Userspace byte/datagram fault simulation. NOT a TCP packet/ACK simulator.
import net from "node:net";
import dgram from "node:dgram";
import { EventEmitter, once } from "node:events";
import { deadline } from "./network-support.mjs";

const now = () => performance.now();
export class FaultRelay extends EventEmitter {
  constructor({
    protocol = "tcp",
    upstreamPort,
    latencyMs = 0,
    maxBufferedBytes = 4 * 1024 * 1024,
    maxFlows = 64,
  } = {}) {
    super();
    if (!["tcp", "udp"].includes(protocol)) throw new Error("invalid relay protocol");
    if (
      upstreamPort !== undefined &&
      (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535)
    )
      throw new Error("invalid upstream port");
    if (!Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > 60000)
      throw new Error("invalid latency");
    if (
      !Number.isFinite(maxBufferedBytes) ||
      maxBufferedBytes <= 0 ||
      maxBufferedBytes > 64 * 1024 * 1024
    )
      throw new Error("invalid max buffered bytes");
    if (!Number.isInteger(maxFlows) || maxFlows <= 0) throw new Error("invalid max flows");
    this.protocol = protocol;
    this.upstreamPort = upstreamPort;
    this.latencyMs = latencyMs;
    this.maxBufferedBytes = maxBufferedBytes;
    this.maxFlows = maxFlows;
    this.flows = new Set();
    this.timers = new Map();
    this.bufferedBytes = 0;
    this.history = [];
    this.mode = "up";
    this.closed = false;
    this.pendingCloses = new Set();
    this.record("configured", { latencyMs, protocol });
  }
  record(type, values = {}) {
    const event = { type, at: now(), ...values };
    this.history.push(event);
    if (this.history.length > 10000) this.history.shift();
    this.emit("event", event);
    return event;
  }
  async listen() {
    this.listener =
      this.protocol === "tcp"
        ? net.createServer((socket) => this.acceptTcp(socket))
        : dgram.createSocket("udp4");
    this.listener.on("error", (error) => this.record("error", { message: error.message }));
    if (this.protocol === "udp")
      this.listener.on("message", (bytes, peer) => this.acceptUdp(bytes, peer));
    const ready = once(this.listener, "listening");
    if (this.protocol === "tcp") this.listener.listen(0, "127.0.0.1");
    else this.listener.bind(0, "127.0.0.1");
    await deadline(ready, 5000, "relay listening");
    this.port = this.listener.address().port;
    this.record("listening", { port: this.port });
    return this;
  }
  setLatency(latencyMs) {
    if (!Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > 60000)
      throw new Error("invalid latency");
    this.latencyMs = latencyMs;
    return this.record("latency", { latencyMs });
  }
  track(socket) {
    const closed = new Promise((resolve) => socket.once("close", resolve));
    this.pendingCloses.add(closed);
    closed.then(() => this.pendingCloses.delete(closed));
    socket.on("error", (error) => this.record("socket-error", { message: error.message }));
    return socket;
  }
  schedule(flow, bytes, deliver, direction) {
    if (this.closed || this.mode !== "up" || flow.stale || flow.closed) return;
    if (this.bufferedBytes + bytes.length > this.maxBufferedBytes) {
      this.record("overflow", { bytes: this.bufferedBytes });
      this.drop(flow);
      return;
    }
    // Copy: retained buffers are accounted, and cancelled on fault/close.
    const copy = Buffer.from(bytes);
    this.bufferedBytes += copy.length;
    const item = { flow, size: copy.length, copy, deliver, direction, ready: false };
    if (direction) {
      direction.items.add(item);
      direction.queued += copy.length;
    }
    item.timer = setTimeout(() => {
      item.ready = true;
      if (direction) this.drainBuffers(direction);
      else {
        this.releaseBuffer(item);
        if (!flow.closed && !flow.stale && this.mode === "up") deliver(copy);
      }
    }, this.latencyMs);
    // Keep expired-but-blocked entries accounted until delivery or cancellation.
    this.timers.set(item.timer, item);
  }
  releaseBuffer(item) {
    clearTimeout(item.timer);
    this.timers.delete(item.timer);
    this.bufferedBytes -= item.size;
    if (item.direction) {
      item.direction.items.delete(item);
      item.direction.queued -= item.size;
    }
  }
  drainBuffers(direction) {
    // Each deadline is relative to admission, not the previous chunk's delivery.
    for (const item of direction.items) {
      if (!item.ready || direction.blocked) break;
      this.releaseBuffer(item);
      if (!item.flow.closed && !item.flow.stale && this.mode === "up") item.deliver(item.copy);
    }
  }
  cancelBuffers(flow) {
    for (const item of this.timers.values()) {
      if (flow && item.flow !== flow) continue;
      this.releaseBuffer(item);
    }
  }
  acceptTcp(socket) {
    this.track(socket);
    if (this.closed || this.flows.size >= this.maxFlows || this.mode === "reset") {
      socket.resetAndDestroy();
      return;
    }
    const flow = { downstream: socket, stale: this.mode === "blackhole", closed: false };
    this.flows.add(flow);
    socket.setNoDelay(true);
    socket.once("close", () => this.drop(flow));
    if (flow.stale) {
      socket.resume();
      return;
    }
    const upstream = (flow.upstream = this.track(
      net.connect({ host: "127.0.0.1", port: this.upstreamPort }),
    ));
    upstream.setNoDelay(true);
    upstream.once("connect", () =>
      this.record("tcp-connected", {
        sourcePort: upstream.localPort,
        targetPort: this.upstreamPort,
      }),
    );
    upstream.once("close", () => this.drop(flow));
    upstream.on("error", () => this.drop(flow));
    socket.on("error", () => this.drop(flow));
    const pipe = (source, target) => {
      const direction = { items: new Set(), queued: 0, blocked: false };
      source.on("data", (bytes) => {
        if (this.mode !== "up" || flow.stale || flow.closed) return;
        this.schedule(
          flow,
          bytes,
          (copy) => {
            if (target.destroyed) return;
            if (!target.write(copy)) {
              source.pause();
              direction.blocked = true;
              target.once("drain", () => {
                direction.blocked = false;
                this.drainBuffers(direction);
                if (
                  !flow.closed &&
                  !flow.stale &&
                  !direction.blocked &&
                  direction.queued < 128 * 1024
                )
                  source.resume();
              });
            }
            if (!direction.blocked && direction.queued < 128 * 1024) source.resume();
          },
          direction,
        );
        if (direction.queued >= 128 * 1024) source.pause();
      });
    };
    pipe(socket, upstream);
    pipe(upstream, socket);
  }
  async udpUpstream(flow) {
    const socket = (flow.upstream = this.track(dgram.createSocket("udp4")));
    socket.on("message", (bytes) =>
      this.schedule(flow, bytes, (copy) =>
        this.listener.send(copy, flow.peer.port, flow.peer.address),
      ),
    );
    const ready = once(socket, "listening");
    socket.bind(0, "127.0.0.1");
    await deadline(ready, 5000, "UDP upstream binding");
    return this.record("udp-bound", {
      sourcePort: socket.address().port,
      peerPort: flow.peer.port,
    });
  }
  acceptUdp(bytes, peer) {
    if (this.closed || this.mode !== "up") return;
    let flow = [...this.flows].find(
      (f) => f.peer.port === peer.port && f.peer.address === peer.address,
    );
    if (!flow) {
      if (this.flows.size >= this.maxFlows) return this.record("flow-limit");
      flow = { peer, closed: false };
      this.flows.add(flow);
      flow.ready = this.udpUpstream(flow);
      flow.ready.catch((error) => {
        this.record("error", { message: error.message });
        this.drop(flow);
      });
    }
    this.schedule(flow, bytes, (copy) => {
      if (!flow.closed) flow.upstream.send(copy, this.upstreamPort, "127.0.0.1");
    });
  }
  fault(kind) {
    if (!["reset", "blackhole"].includes(kind)) throw new Error("unknown fault");
    const event = this.record("fault-start", { kind });
    this.mode = kind;
    this.cancelBuffers();
    for (const flow of [...this.flows]) {
      if (kind === "reset") this.drop(flow, true);
      else if (this.protocol === "tcp") {
        // Old TCP byte streams stay dead after restore, like a stale NAT mapping.
        // Kernel ACKs are NOT suppressed by a userspace relay.
        flow.stale = true;
        flow.downstream.resume();
        flow.upstream?.resume();
      }
    }
    return event;
  }
  restore({ upstreamPort = this.upstreamPort } = {}) {
    if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535)
      throw new Error("invalid upstream port");
    this.upstreamPort = upstreamPort;
    this.mode = "up";
    return this.record("path-restored", { upstreamPort });
  }
  async rebind() {
    if (this.protocol !== "udp") throw new Error("TCP cannot migrate: reset and reconnect instead");
    const changes = [];
    for (const flow of this.flows) {
      this.cancelBuffers(flow);
      const old = flow.upstream;
      const previousPort = old.address().port;
      // Bind the replacement before closing the old socket, guaranteeing a new port.
      old.removeAllListeners("message");
      flow.ready = this.udpUpstream(flow);
      const event = await flow.ready;
      const closed = once(old, "close");
      old.close();
      await deadline(closed, 5000, "UDP old socket close");
      changes.push({ previousPort, sourcePort: event.sourcePort });
    }
    return this.record("rebound", { changes });
  }
  drop(flow, reset = false) {
    if (flow.closed) return;
    flow.closed = true;
    this.cancelBuffers(flow);
    this.flows.delete(flow);
    if (this.protocol === "tcp") {
      for (const socket of [flow.downstream, flow.upstream]) {
        if (!socket || socket.destroyed) continue;
        if (reset && !socket.connecting) socket.resetAndDestroy();
        else socket.destroy();
      }
    } else {
      try {
        flow.upstream?.close();
      } catch {}
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.cancelBuffers();
    for (const flow of [...this.flows]) this.drop(flow);
    if (this.listener)
      await deadline(
        new Promise((resolve, reject) =>
          this.listener.close((error) => (error ? reject(error) : resolve())),
        ),
        5000,
        "relay listener close",
      );
    await deadline(Promise.all([...this.pendingCloses]), 5000, "relay socket close");
    this.record("closed");
    this.removeAllListeners();
  }
}

// Only explicit simulation timers; all readiness waits use events.
export function faultDuration(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}
