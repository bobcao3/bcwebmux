// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { compareScreenshot } from "./visual-compare.mjs";

const exec = promisify(execFile);
const frameFile = (directory, index) =>
  path.join(directory, `${String(index).padStart(6, "0")}.png`);

// Records named groups of animated frames as one AV1 video per group. Each group
// is stored as <group>.webm plus <group>.json in goldenDir, so unrelated
// scenarios no longer share a single concatenated timeline.
export class VideoGoldens {
  constructor({ goldenDir, outputDir, update = false }) {
    this.goldenDir = goldenDir;
    this.outputDir = outputDir;
    this.update = update;
    this.groups = new Map();
  }

  framesFor(group) {
    if (!this.groups.has(group)) this.groups.set(group, []);
    return this.groups.get(group);
  }

  async initialize() {
    if (this.directory) return;
    this.directory = await mkdtemp(path.join(os.tmpdir(), "bcwebmux-video-golden-"));
    this.decodedDir = path.join(this.directory, "decoded");
    await mkdir(this.outputDir, { recursive: true });
    if (this.update) return;
    this.references = new Map();
    for (const entry of await readdir(this.goldenDir)) {
      if (!entry.endsWith(".json")) continue;
      const name = entry.slice(0, -".json".length);
      const manifest = JSON.parse(await readFile(path.join(this.goldenDir, entry), "utf8"));
      assert.equal(manifest.version, 1, `${name}: manifest version`);
      assert.equal(manifest.codec, "av1", `${name}: manifest codec`);
      await this.decode(path.join(this.goldenDir, `${name}.webm`), manifest, name);
      this.references.set(name, manifest);
    }
  }

  async decode(video, manifest, name) {
    const directory = path.join(this.decodedDir, name);
    await mkdir(directory, { recursive: true });
    await exec("ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-threads",
      "2",
      "-i",
      video,
      "-fps_mode",
      "passthrough",
      "-pix_fmt",
      "rgb24",
      "-start_number",
      "0",
      path.join(directory, "%06d.png"),
    ]);
    assert.equal(
      (await readdir(directory)).length,
      manifest.frames.length,
      `${name}: video reference frame count`,
    );
    const info = await sharp(frameFile(directory, 0)).metadata();
    assert.equal(info.width, manifest.width, `${name}: video reference width`);
    assert.equal(info.height, manifest.height, `${name}: video reference height`);
  }

  async compare(name, index, png, frame) {
    const referencePng = await sharp(frameFile(path.join(this.decodedDir, name), index))
      .extract({ left: 0, top: 0, width: frame.width, height: frame.height })
      .png()
      .toBuffer();
    await compareScreenshot({
      png,
      referencePng,
      ...frame,
      goldenDir: this.goldenDir,
      outputDir: this.outputDir,
      tolerance: 2,
    });
  }

  async add({ png, name, width, height, group }) {
    await this.initialize();
    const frames = this.framesFor(group);
    const frame = { name, width, height };
    const index = frames.length;
    frames.push(frame);
    await writeFile(path.join(this.outputDir, `${name}.png`), png);
    if (this.update) return;
    const reference = this.references.get(group);
    assert.ok(reference, `${group}: missing video reference`);
    assert.deepEqual(
      frame,
      reference.frames[index],
      `${group}: video scenario order and dimensions`,
    );
    await this.compare(group, index, png, frame);
  }

  async finish() {
    await this.initialize();
    if (!this.update) {
      for (const [name, frames] of this.groups) {
        const reference = this.references.get(name);
        assert.ok(reference, `${name}: missing video reference`);
        assert.equal(
          frames.length,
          reference.frames.length,
          `${name}: all video reference frames must run`,
        );
      }
      for (const name of this.references.keys())
        assert.ok(this.groups.has(name), `${name}: video reference was not recorded`);
      return;
    }
    for (const [name, frames] of this.groups) await this.encodeGroup(name, frames);
  }

  async encodeGroup(name, frames) {
    const width = Math.max(...frames.map((frame) => frame.width));
    const height = Math.max(...frames.map((frame) => frame.height));
    const inputDir = path.join(this.directory, `input-${name}`);
    await mkdir(inputDir, { recursive: true });
    for (const [index, frame] of frames.entries()) {
      await sharp(path.join(this.outputDir, `${frame.name}.png`))
        .extend({ right: width - frame.width, bottom: height - frame.height, background: "black" })
        .png()
        .toFile(frameFile(inputDir, index));
    }
    const video = path.join(this.outputDir, `${name}.candidate.webm`);
    const manifest = {
      version: 1,
      codec: "av1",
      pixelFormat: "gbrp",
      crf: 2,
      fps: 5,
      width,
      height,
      frames,
    };
    await writeFile(
      path.join(this.outputDir, `${name}.candidate.json`),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    await exec("ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-framerate",
      String(manifest.fps),
      "-i",
      path.join(inputDir, "%06d.png"),
      "-c:v",
      "libaom-av1",
      "-b:v",
      "0",
      "-crf",
      String(manifest.crf),
      "-pix_fmt",
      manifest.pixelFormat,
      "-cpu-used",
      "0",
      "-row-mt",
      "1",
      "-threads",
      "2",
      video,
    ]);
    await this.decode(video, manifest, name);
    for (const [index, frame] of frames.entries())
      await this.compare(
        name,
        index,
        await readFile(path.join(this.outputDir, `${frame.name}.png`)),
        frame,
      );
    await mkdir(this.goldenDir, { recursive: true });
    await copyFile(video, path.join(this.goldenDir, `${name}.webm`));
    await writeFile(
      path.join(this.goldenDir, `${name}.json`),
      JSON.stringify(manifest, null, 2) + "\n",
    );
  }

  async dispose() {
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}
