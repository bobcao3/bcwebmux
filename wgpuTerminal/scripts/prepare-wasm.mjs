// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { copyFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "..");
const result = spawnSync("zig", ["build", "terminal-wasm", "-Doptimize=ReleaseSmall"], {
  cwd: resolve(repositoryRoot, "bcwebmux"),
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const destination = resolve(packageRoot, "dist/terminal.wasm");
await mkdir(dirname(destination), { recursive: true });
await copyFile(resolve(repositoryRoot, "bcwebmux/zig-out/wgpu-terminal/terminal.wasm"), destination);
