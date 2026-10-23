// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { cp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "..");
const result = spawnSync("zig", ["build", "terminal-wasm", "-Doptimize=small"], {
  cwd: resolve(repositoryRoot, "app-bcwebmux"),
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

await cp(
  resolve(repositoryRoot, "app-bcwebmux/zig-out/wgpu-terminal"),
  resolve(packageRoot, "dist"),
  { recursive: true },
);
