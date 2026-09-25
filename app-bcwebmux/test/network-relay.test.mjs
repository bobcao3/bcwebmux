// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { test } from "node:test";
import net from "node:net";
import dgram from "node:dgram";
import { once } from "node:events";
import { Cdp } from "./test-support.mjs";
import { Journal } from "./network-support.mjs";
import { FaultRelay, faultDuration } from "./network-relay.mjs";

async function event(target, name, timeout = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${name} deadline`)), timeout);
  try {
    return await once(target, name, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
async function tcpClient(port) {
  const socket = net.connect({ host: "127.0.0.1", port });
  socket.on("error", () => {});
  await event(socket, "connect");
  return socket;
}
async function destroy(socket) {
  if (socket.closed) return;
  const closed = event(socket, "close");
  socket.destroy();
  await closed;
}
async function echoTcp(prefix) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (bytes) => socket.write(Buffer.concat([Buffer.from(prefix), bytes])));
  });
  server.listen(0, "127.0.0.1");
  await event(server, "listening");
  return {
    port: server.address().port,
    async close() {
      await Promise.all([...sockets].map(destroy));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test(
  "TCP latency, reset, changed target/source ports, silent stale mapping and bounded cleanup",
  { timeout: 10000 },
  async () => {
    const a = await echoTcp("A"),
      b = await echoTcp("B");
    const relay = await new FaultRelay({ upstreamPort: a.port, latencyMs: 20 }).listen();
    let socket;
    try {
      socket = await tcpClient(relay.port);
      let response = event(socket, "data");
      const started = performance.now();
      socket.write("first");
      assert.equal((await response)[0].toString(), "Afirst");
      assert.ok(performance.now() - started >= 35, "both 20ms directions impaired");
      const oldSourcePort = relay.history.find(
        (entry) => entry.type === "tcp-connected",
      ).sourcePort;
      // RST is expected: await close directly rather than events.once's error rejection.
      const closed = new Promise((resolve) => socket.once("close", resolve));
      const fault = relay.fault("reset");
      await closed;
      const restored = relay.restore({ upstreamPort: b.port });
      assert.ok(restored.at >= fault.at);
      socket = await tcpClient(relay.port);
      response = event(socket, "data");
      socket.write("second");
      assert.equal((await response)[0].toString(), "Bsecond");
      assert.notEqual(
        relay.history.filter((entry) => entry.type === "tcp-connected").at(-1).sourcePort,
        oldSourcePort,
      );
      relay.fault("blackhole");
      relay.restore();
      assert.ok([...relay.flows].every((flow) => flow.stale));
      assert.equal(socket.destroyed, false, "blackhole does not notify client with close");
      await destroy(socket);
      socket = await tcpClient(relay.port);
      response = event(socket, "data");
      socket.write("new-path");
      assert.equal((await response)[0].toString(), "Bnew-path");
      relay.setLatency(1000);
      const queued = new Promise((resolve) => {
        const original = relay.schedule.bind(relay);
        relay.schedule = (...args) => {
          original(...args);
          resolve();
        };
      });
      socket.write("cancel-me");
      await queued;
      assert.ok(relay.bufferedBytes > 0);
      await relay.close();
      assert.equal(relay.bufferedBytes, 0);
      assert.equal(relay.timers.size, 0);
      assert.equal(relay.pendingCloses.size, 0);
    } finally {
      await relay.close();
      if (socket) await destroy(socket);
      await a.close();
      await b.close();
    }
  },
);

test(
  "TCP lowering latency preserves admitted byte order in both directions",
  { timeout: 10000 },
  async () => {
    const echo = await echoTcp("");
    const relay = await new FaultRelay({ upstreamPort: echo.port }).listen();
    let socket;
    const schedule = relay.schedule.bind(relay);
    relay.schedule = (...args) => {
      schedule(...args);
      relay.emit("admitted", args);
    };
    try {
      socket = await tcpClient(relay.port);
      const flow = [...relay.flows][0];
      for (const reverse of [false, true]) {
        relay.setLatency(reverse ? 0 : 500);
        let received = "";
        const collect = (bytes) => {
          received += bytes.toString();
          if (received.length === 11) socket.emit("complete");
        };
        socket.on("data", collect);
        // The reverse case sets latency before the echo's bytes are admitted.
        const admitted = event(relay, "admitted");
        socket.write("earlier");
        await admitted;
        if (reverse) {
          relay.setLatency(500);
          await event(flow.upstream, "data");
        }
        assert.equal(relay.bufferedBytes, 7, "earlier bytes are retained before changing latency");
        relay.setLatency(0);
        const complete = event(socket, "complete");
        socket.write("late");
        await complete;
        socket.off("data", collect);
        assert.equal(received, "earlierlate");
        assert.equal(relay.bufferedBytes, 0);
      }
    } finally {
      await relay.close();
      if (socket) await destroy(socket);
      await echo.close();
    }
  },
);

for (const action of ["reset", "blackhole", "close", "overflow"]) {
  test(
    `TCP ready followers remain accounted and are cancelled on ${action}`,
    { timeout: 10000 },
    async () => {
      const echo = await echoTcp("");
      const relay = await new FaultRelay({
        upstreamPort: echo.port,
        latencyMs: 5000,
        maxBufferedBytes: 11,
      }).listen();
      let socket;
      const schedule = relay.schedule.bind(relay);
      relay.schedule = (...args) => {
        schedule(...args);
        relay.emit("admitted", args);
      };
      const drain = relay.drainBuffers.bind(relay);
      relay.drainBuffers = (direction) => {
        drain(direction);
        relay.emit("ready", direction);
      };
      try {
        socket = await tcpClient(relay.port);
        let admitted = event(relay, "admitted");
        socket.write("earlier");
        await admitted;
        relay.setLatency(0);
        const ready = event(relay, "ready");
        socket.write("late");
        const [direction] = await ready;
        assert.equal(direction.items.size, 2);
        assert.deepEqual(
          [...direction.items].map((item) => item.ready),
          [false, true],
        );
        assert.equal(relay.bufferedBytes, 11);
        assert.equal(direction.queued, 11);
        assert.equal(
          relay.timers.size,
          2,
          "expired follower remains in cancellation/accounting registry",
        );
        if (action === "close") await relay.close();
        else if (action === "overflow") {
          admitted = event(relay, "admitted");
          socket.write("!");
          await admitted;
          assert.ok(relay.history.some((entry) => entry.type === "overflow"));
        } else relay.fault(action);
        assert.equal(direction.items.size, 0);
        assert.equal(direction.queued, 0);
        assert.equal(relay.bufferedBytes, 0);
        assert.equal(relay.timers.size, 0);
      } finally {
        await relay.close();
        if (socket) await destroy(socket);
        await echo.close();
        assert.equal(relay.pendingCloses.size, 0);
      }
    },
  );
}

test(
  "UDP symmetric latency and actual upstream source-port rebinding on same downstream socket",
  { timeout: 10000 },
  async () => {
    const echo = dgram.createSocket("udp4");
    const ports = [];
    echo.on("message", (bytes, peer) => {
      ports.push(peer.port);
      echo.send(bytes, peer.port, peer.address);
    });
    echo.bind(0, "127.0.0.1");
    await event(echo, "listening");
    const relay = await new FaultRelay({
      protocol: "udp",
      upstreamPort: echo.address().port,
      latencyMs: 20,
    }).listen();
    const client = dgram.createSocket("udp4");
    client.bind(0, "127.0.0.1");
    await event(client, "listening");
    try {
      let received = event(client, "message");
      const started = performance.now();
      client.send(Buffer.from("before"), relay.port, "127.0.0.1");
      assert.equal((await received)[0].toString(), "before");
      assert.ok(performance.now() - started >= 35);
      const downstreamPort = client.address().port;
      const rebound = await relay.rebind();
      assert.equal(rebound.changes.length, 1);
      assert.notEqual(rebound.changes[0].sourcePort, rebound.changes[0].previousPort);
      received = event(client, "message");
      client.send(Buffer.from("after"), relay.port, "127.0.0.1");
      assert.equal((await received)[0].toString(), "after");
      assert.notEqual(ports[0], ports[1]);
      assert.equal(client.address().port, downstreamPort);
      relay.fault("blackhole");
      assert.equal(relay.timers.size, 0);
      relay.restore();
      received = event(client, "message");
      client.send(Buffer.from("restored"), relay.port, "127.0.0.1");
      assert.equal((await received)[0].toString(), "restored");
    } finally {
      await relay.close();
      const clientClosed = event(client, "close"),
        echoClosed = event(echo, "close");
      client.close();
      echo.close();
      await Promise.all([clientClosed, echoClosed]);
      assert.equal(relay.bufferedBytes, 0);
      assert.equal(relay.pendingCloses.size, 0);
    }
  },
);

test("relay rejects unbounded configurations and overflow cancels queued buffers", () => {
  assert.throws(() => new FaultRelay({ latencyMs: -1 }));
  assert.throws(() => new FaultRelay({ maxFlows: Infinity }));
  const relay = new FaultRelay({ upstreamPort: 1, maxBufferedBytes: 4 });
  const flow = { closed: false };
  relay.schedule(flow, Buffer.alloc(5), () => assert.fail("overflow delivered"));
  assert.equal(flow.closed, true);
  assert.equal(relay.bufferedBytes, 0);
  assert.equal(relay.timers.size, 0);
});

test(
  "CDP subscriptions and journal waits are event driven and dispose on disconnect",
  { timeout: 10000 },
  async () => {
    class FakeSocket extends EventTarget {
      readyState = WebSocket.OPEN;
      send() {}
      close() {
        this.readyState = WebSocket.CLOSED;
        this.dispatchEvent(new Event("close"));
      }
      emit(method, params) {
        this.dispatchEvent(
          new MessageEvent("message", { data: JSON.stringify({ method, params }) }),
        );
      }
    }

    const socket = new FakeSocket();
    const cdp = new Cdp(socket);
    const seen = [];
    const unsubscribe = cdp.on("Demo.event", ({ value }) => seen.push(value));
    const received = cdp.waitEvent("Demo.event", ({ value }) => value === 2, 1000);
    socket.emit("Demo.event", { value: 1 });
    socket.emit("Demo.event", { value: 2 });
    assert.equal((await received).value, 2);
    assert.deepEqual(seen, [1, 2]);
    unsubscribe();
    assert.equal(cdp.eventWaiters.size, 0);

    const disconnected = assert.rejects(cdp.waitEvent("Never"), /disconnected/);
    cdp.disconnect(new Error("disconnected"));
    await disconnected;
    await assert.rejects(cdp.waitEvent("Never"), /disconnected/);
    await cdp.close();

    const journal = new Journal();
    const ready = journal.wait((entry) => entry.kind === "ready");
    journal.add({ kind: "ready" });
    await ready;
    assert.equal(journal.waiters.size, 0);
    const closed = assert.rejects(
      journal.wait(() => false),
      /closed/,
    );
    await journal.close();
    await closed;

    const controller = new AbortController();
    const cancelled = assert.rejects(faultDuration(10000, controller.signal), /cancelled/);
    controller.abort(new Error("cancelled"));
    await cancelled;
  },
);
