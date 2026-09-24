// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, chmod, writeFile, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { freePort, terminateProcess, waitFor } from "./test-support.mjs";

if (!process.argv[2]) throw new Error("usage: node test/session-shell-integration.mjs SERVER");
const serverPath = resolve(process.argv[2]);
const root = await mkdtemp(join(tmpdir(), "bcwebmux-shell-"));
const outside = join(root, "outside");
const home = join(root, "home with spaces");
const shell = join(root, "shell");
const probe = join(root, "probe");
await mkdir(outside);
await mkdir(home);
await writeFile(join(root, "config.toml"), "");
const inaccessible = join(root, "inaccessible");
await mkdir(inaccessible);
await chmod(inaccessible, 0);
// Observe cwd before any shell startup scripts; then verify a real bash login
// shell without host profiles changing cwd or introducing machine-specific effects.
await writeFile(shell, `#!/bin/sh
PROBE='${probe}'
export PROBE
printf '%s\\n' "$@" > "$PROBE.args"
pwd -P > "$PROBE.cwd"
env | grep -E '^(TERM|COLORTERM|TERM_PROGRAM|KITTY_WINDOW_ID)=' | sort > "$PROBE.env"
readlink "/proc/$PPID/cwd" > "$PROBE.worker-cwd"
exec /bin/bash --noprofile --norc "$@" -c 'shopt -q login_shell || exit 42; pwd -P > "$PROBE.login"'
`, { mode: 0o700 });

try {
  for (const [name, value, expected] of [
    ["explicit", home, home],
    ["missing", undefined, userInfo().homedir],
    ["empty", "", userInfo().homedir],
    ["nonexistent", join(root, "absent"), null],
    ["not-directory", shell, null],
    ...(process.getuid() === 0 ? [] : [["inaccessible", inaccessible, null]]),
  ]) {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    for (const suffix of ["args", "cwd", "login", "worker-cwd", "env"]) await rm(`${probe}.${suffix}`, { force: true });
    const env = { ...process.env };
    if (value === undefined) delete env.HOME;
    else env.HOME = value;
    const server = spawn(serverPath, ["--config", join(root, "config.toml"), "--auth=false", "--port", String(port), "--origin", base, "--shell", shell, ...(name === "explicit" ? ["--term", "screen-256color", "--kitty-graphics=false"] : [])], {
      cwd: outside, env, stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    server.stdout.on("data", chunk => { logs += chunk; });
    server.stderr.on("data", chunk => { logs += chunk; });
    try {
      await waitFor(async () => {
        try { return (await fetch(`${base}/api/server`)).ok; } catch { return false; }
      }, 5000, () => `${name}: server failed to start\n${logs}`);
      const response = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { Origin: base, "Content-Type": "application/json", "Idempotency-Key": name },
        body: JSON.stringify({ profile: "shell" }),
      });
      assert.equal(response.status, 201, `${name}: ${await response.clone().text()}`);
      const session = await response.json();
      const exited = await waitFor(async () => {
        const current = await (await fetch(`${base}/api/sessions/${session.id}`)).json();
        return current.state === "exited" && current;
      }, 5000, () => `${name}: session did not exit\n${logs}`);
      assert.equal(await readlink(`/proc/${server.pid}/cwd`), outside, "server cwd must not change");
      if (expected) {
        assert.equal(exited.exitStatus, 0, name);
        assert.equal(await readFile(`${probe}.args`, "utf8"), "-l\n", name);
        assert.equal((await readFile(`${probe}.cwd`, "utf8")).trim(), expected, name);
        assert.equal((await readFile(`${probe}.login`, "utf8")).trim(), expected, name);
        assert.equal((await readFile(`${probe}.worker-cwd`, "utf8")).trim(), outside, "worker cwd must not change");
        assert.equal(await readFile(`${probe}.env`, "utf8"), `COLORTERM=truecolor\n${name === "explicit" ? "" : "KITTY_WINDOW_ID=1\n"}TERM_PROGRAM=bcwebmux\nTERM=${name === "explicit" ? "screen-256color" : "xterm-ghostty"}\n`, name);
      } else {
        assert.equal(exited.exitStatus, 126 << 8, name);
        assert.ok(exited.outputOffset > 0, "home failure must emit a diagnostic");
        await assert.rejects(readFile(`${probe}.args`), { code: "ENOENT" });
      }
    } finally {
      await terminateProcess(server);
    }
  }
  console.log("session shell integration: passed");
} finally {
  await chmod(inaccessible, 0o700);
  await rm(root, { recursive: true, force: true });
}
