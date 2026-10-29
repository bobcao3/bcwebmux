// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const [target, outputDirectory] = process.argv.slice(2);
if (!target || !outputDirectory || !/^[a-zA-Z0-9_-]+$/.test(target)) {
  throw new Error("usage: node .github/scripts/package-server.mjs TARGET OUTPUT_DIRECTORY");
}
const output = resolve(outputDirectory);
const localCache = resolve(process.env.ZIG_LOCAL_CACHE_DIR ?? "app-bcwebmux/.zig-cache");
const name = `bcwebmux-${target}`;
const temporary = await mkdtemp(join(tmpdir(), "bcwebmux-package-"));
const stage = join(temporary, name);
const zigEnvironment = execFileSync("zig", ["env"], { encoding: "utf8" });
function zigPath(field) {
  const match = zigEnvironment.match(new RegExp(`\\.${field} = ("(?:[^"\\\\]|\\\\.)*")`));
  if (!match) throw new Error(`zig env did not report ${field}`);
  return JSON.parse(match[1]);
}
async function copy(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination);
}
async function collectLicenses(source, destination) {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      await collectLicenses(from, to);
    } else if (
      entry.isFile() &&
      /^(LICENSE|COPYING|NOTICE|PATENTS|UNLICENSE|OFL)([._-].*)?$/i.test(entry.name)
    ) {
      await copy(from, to);
    }
  }
}

try {
  for (const binary of ["bcwebmux-server", "bcwebmux-sessiond", "bcwebmux-worker"]) {
    const source = resolve("app-bcwebmux/zig-out/bin", binary);
    const headers = execFileSync("readelf", ["-l", source], { encoding: "utf8" });
    const dynamic = execFileSync("readelf", ["-d", source], { encoding: "utf8" });
    if (/\bINTERP\b/.test(headers) || /\(NEEDED\)/.test(dynamic)) {
      throw new Error(`${binary} is not fully static`);
    }
    await copy(source, join(stage, binary));
  }
  for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    await copy(file, join(stage, file));
  }
  for (const cache of ["app-bcwebmux/zig-pkg", join(zigPath("global_cache_dir"), "p")]) {
    try {
      await collectLicenses(cache, join(stage, "licenses/zig"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await collectLicenses(join(localCache, "go/modules"), join(stage, "licenses/go-modules"));
  await copy(join(zigPath("lib_dir"), "libc/musl/COPYRIGHT"), join(stage, "licenses/musl.txt"));
  let zigLicenseFound = false;
  for (const source of [
    join(zigPath("lib_dir"), "../LICENSE"),
    "/usr/share/licenses/zig/LICENSE",
  ]) {
    try {
      await copy(source, join(stage, "licenses/Zig.txt"));
      zigLicenseFound = true;
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!zigLicenseFound) throw new Error("The Zig runtime license is missing");
  for (const [source, file] of [
    ["app-bcwebmux/web/fonts/OFL.txt", "OFL.txt"],
    ["node_modules/@fontsource/noto-color-emoji/LICENSE", "NotoColorEmoji-OFL.txt"],
  ]) {
    await copy(source, join(stage, "licenses", file));
  }
  let goLicenseFound = false;
  for (const entry of await readdir(join(localCache, "o"))) {
    const source = join(localCache, "o", entry, "go-toolchain/LICENSE");
    try {
      await copy(source, join(stage, "licenses/Go.txt"));
      goLicenseFound = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!goLicenseFound) throw new Error("The provisioned Go toolchain license is missing");
  await writeFile(
    join(stage, "BUILD.txt"),
    [
      `Version: ${JSON.parse(await readFile("app-bcwebmux/package.json", "utf8")).version}`,
      `Target: ${target}`,
      `Commit: ${execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()}`,
      `Zig: ${execFileSync("zig", ["version"], { encoding: "utf8" }).trim()}`,
      "Keep bcwebmux-server, bcwebmux-sessiond, and bcwebmux-worker in the same directory.",
      "",
    ].join("\n"),
  );
  await mkdir(output, { recursive: true });
  const archive = `${name}.tar.gz`;
  execFileSync("tar", [
    "--sort=name",
    "--mtime=@0",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "-czf",
    join(output, archive),
    "-C",
    temporary,
    name,
  ]);
  const checksum = createHash("sha256")
    .update(await readFile(join(output, archive)))
    .digest("hex");
  await writeFile(join(output, `${archive}.sha256`), `${checksum}  ${archive}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
