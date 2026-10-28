// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { terminateProcess, waitFor } from "./test-support.mjs";

function daemon(
  serverPath,
  directory,
  { args = [], env = process.env, cwd, timeout = 10000, stateDir } = {},
) {
  const socket = path.join(directory, "session.sock");
  const isolatedEnv = {
    ...env,
    XDG_STATE_HOME: stateDir ?? path.join(directory, "state"),
    XDG_CONFIG_HOME: path.join(directory, "config"),
    XDG_DATA_HOME: path.join(directory, "data"),
    XDG_CACHE_HOME: path.join(directory, "cache"),
    XDG_RUNTIME_DIR: directory,
  };
  const binary =
    process.env.BCWEBMUX_SESSIOND ||
    path.join(path.dirname(path.resolve(serverPath)), "bcwebmux-sessiond");
  const worker = path.join(path.dirname(path.resolve(binary)), "bcwebmux-worker");
  let child;
  let logs = "";

  async function stop() {
    await terminateProcess(child);
    await rm(socket, { force: true });
  }

  async function start() {
    let spawnError;
    try {
      await mkdir(isolatedEnv.XDG_STATE_HOME, { recursive: true });
      child = spawn(binary, ["--socket", socket, "--worker", worker, ...args], {
        cwd,
        env: isolatedEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      child.detachedGroup = true;
      child.on("error", (error) => {
        spawnError = error;
      });
      for (const stream of [child.stdout, child.stderr]) {
        stream.on("data", (chunk) => {
          logs += chunk;
        });
      }
      await waitFor(
        async () => {
          if (spawnError) throw spawnError;
          if (child.exitCode !== null || child.signalCode !== null || !child.pid)
            throw new Error(`session daemon exited during startup\n${logs}`);
          return (await stat(socket).catch(() => null))?.isSocket();
        },
        timeout,
        () => `session daemon failed to start\n${logs}`,
      );
    } catch (error) {
      await stop();
      throw error;
    }
  }

  return {
    socket,
    env: isolatedEnv,
    get child() {
      return child;
    },
    get pid() {
      return child?.pid;
    },
    get logs() {
      return logs;
    },
    start,
    stop,
  };
}

export async function startSessionDaemon(serverPath, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "bcwebmux-session-test-"));
  let instance;
  try {
    instance = daemon(serverPath, dir, options);
    await instance.start();
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  instance.dispose = async () => {
    try {
      await instance.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  return instance;
}

export function webTestDaemon(serverPath, directory, shell = "/bin/sh") {
  return daemon(serverPath, directory, { args: ["--shell", shell], timeout: 5000 });
}

export async function startDaemon(serverPath, directory) {
  const instance = daemon(serverPath, directory, {
    args: ["--shell", "/bin/sh"],
    env: { ...process.env, HOME: directory },
    stateDir: directory,
  });
  await instance.start();
  return { child: instance.child, socket: instance.socket };
}
