// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, readFile, readdir, readlink, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { freePort, terminateProcess, waitFor } from "./test-support.mjs";

const [serverPath] = process.argv.slice(2);
assert.ok(serverPath, "usage: session-autostart-integration.mjs SERVER");
const source = path.dirname(path.resolve(serverPath));
const directory = await mkdtemp(path.join(os.tmpdir(), "bcwebmux-autostart-"));
const socket = path.join(directory, "socket", "session.sock");
const binary = path.join(directory, "bcwebmux-server");
const children = [];
let daemonPid;

async function findDaemon() {
  const executable = path.resolve(directory, "bcwebmux-sessiond");
  const hidden = path.resolve(directory, "sessiond-hidden");
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const target = await readlink(`/proc/${entry}/exe`).catch(() => null);
    if (target === executable || target === hidden) return Number(entry);
  }
}

async function launch() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(
    binary,
    [
      "--config",
      "/dev/null",
      "--auth=false",
      "--allow-any-origin",
      "--listen",
      `127.0.0.1:${port}`,
      "--session-socket",
      socket,
      "--metadata-file",
      path.resolve(directory, `metadata-${children.length}.json`),
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: path.resolve(directory),
        SHELL: "/bin/sh",
        XDG_STATE_HOME: path.resolve(directory),
      },
    },
  );
  child.detachedGroup = true;
  children.push(child);
  let logs = "";
  child.on("error", (error) => {
    logs += String(error);
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      logs += chunk;
    });
  }
  return {
    child,
    base,
    get logs() {
      return logs;
    },
    async ready() {
      await waitFor(
        async () => {
          if (child.exitCode !== null) throw new Error(`frontend exited: ${logs}`);
          return (await fetch(`${base}/api/server`).catch(() => null))?.ok;
        },
        10000,
        () => `frontend failed to start: ${logs}`,
      );
    },
  };
}

async function mutate(base, method, target, body) {
  const response = await fetch(base + target, {
    method,
    headers: {
      Origin: "https://unpredictable-forward.example",
      "Content-Type": "application/json",
      "Idempotency-Key": `${method}-${target}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.ok(
    response.ok,
    `${method} ${target}: ${response.status} ${await response.clone().text()}`,
  );
  return response.status === 204 ? null : response.json();
}

try {
  await copyFile(path.resolve(serverPath), binary);
  const missing = await launch();
  await Promise.race([
    once(missing.child, "exit"),
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("missing daemon did not fail promptly")),
        10000,
      );
      timer.unref();
    }),
  ]);
  assert.notEqual(missing.child.exitCode, 0);
  assert.match(missing.logs, /cannot autostart/);
  assert.equal(await stat(socket).catch(() => null), null);

  for (const name of ["bcwebmux-sessiond", "bcwebmux-worker"]) {
    await copyFile(path.join(source, name), path.join(directory, name));
  }
  const first = await launch();
  const competing = await launch();
  await Promise.all([first.ready(), competing.ready()]);
  daemonPid = await findDaemon();
  assert.ok(daemonPid, "autostarted daemon process was not found");
  const fields = (await readFile(`/proc/${daemonPid}/stat`, "utf8")).split(") ")[1].split(" ");
  assert.equal(Number(fields[3]), daemonPid, "daemon must have its own session");
  for (const fd of [0, 1, 2]) {
    assert.equal(await readlink(`/proc/${daemonPid}/fd/${fd}`), "/dev/null");
  }
  const created = await mutate(first.base, "POST", "/api/sessions", { profile: "shell" });
  const socketBefore = await stat(socket);

  // Reuse must not depend on the daemon binary still being installed.
  await rename(path.join(directory, "bcwebmux-sessiond"), path.join(directory, "sessiond-hidden"));
  const second = await launch();
  await second.ready();
  assert.equal((await stat(socket)).ino, socketBefore.ino);
  assert.equal((await fetch(`${second.base}/api/sessions/${created.id}`)).status, 200);

  await terminateProcess(first.child);
  await terminateProcess(competing.child);
  process.kill(daemonPid, 0);
  assert.equal((await fetch(`${second.base}/api/sessions/${created.id}`)).status, 200);
  await terminateProcess(second.child);
  process.kill(daemonPid, 0);
  const restarted = await launch();
  await restarted.ready();
  assert.equal(
    (await (await fetch(`${restarted.base}/api/sessions/${created.id}`)).json()).state,
    "running",
  );
  await mutate(restarted.base, "POST", `/api/sessions/${created.id}/terminate`);
  await waitFor(
    async () =>
      (await (await fetch(`${restarted.base}/api/sessions/${created.id}`)).json()).state ===
      "exited",
    5000,
    "session did not exit",
  );
  await mutate(restarted.base, "DELETE", `/api/sessions/${created.id}`);
  console.log("session daemon autostart, detachment, reuse, and frontend restart passed");
} finally {
  for (const child of children) await terminateProcess(child);
  daemonPid ??= await findDaemon();
  if (daemonPid) {
    try {
      process.kill(daemonPid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    await waitFor(
      async () => !(await stat(socket).catch(() => null)),
      10000,
      "daemon did not remove its socket",
    );
    await waitFor(
      async () => {
        const status = await readFile(`/proc/${daemonPid}/stat`, "utf8").catch(() => null);
        return status === null || status.split(") ")[1].startsWith("Z ");
      },
      10000,
      "daemon did not exit",
    );
  }
  await rm(directory, { recursive: true, force: true });
}
