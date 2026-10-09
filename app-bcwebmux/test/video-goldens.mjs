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

export class VideoGoldens {
  constructor({ goldenDir, outputDir, update = false }) {
    this.goldenDir = goldenDir;
    this.outputDir = outputDir;
    this.update = update;
    this.frames = [];
    this.videoPath = path.join(goldenDir, "session-progress.webm");
    this.manifestPath = path.join(goldenDir, "session-progress.json");
  }

  async initialize() {
    if (this.directory) return;
    this.directory = await mkdtemp(path.join(os.tmpdir(), "bcwebmux-video-golden-"));
    this.decodedDir = path.join(this.directory, "decoded");
    await mkdir(this.outputDir, { recursive: true });
    if (!this.update) {
      this.reference = JSON.parse(await readFile(this.manifestPath, "utf8"));
      assert.equal(this.reference.version, 1);
      assert.equal(this.reference.codec, "av1");
      await this.decode(this.videoPath, this.reference);
    }
  }

  async decode(video, manifest) {
    await mkdir(this.decodedDir, { recursive: true });
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
      path.join(this.decodedDir, "%06d.png"),
    ]);
    assert.equal(
      (await readdir(this.decodedDir)).length,
      manifest.frames.length,
      "video reference frame count",
    );
    const info = await sharp(frameFile(this.decodedDir, 0)).metadata();
    assert.equal(info.width, manifest.width, "video reference width");
    assert.equal(info.height, manifest.height, "video reference height");
  }

  async compare(index, png, frame) {
    const referencePng = await sharp(frameFile(this.decodedDir, index))
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

  async add({ png, name, width, height }) {
    await this.initialize();
    const frame = { name, width, height };
    const index = this.frames.length;
    this.frames.push(frame);
    await writeFile(path.join(this.outputDir, `${name}.png`), png);
    if (!this.update) {
      assert.deepEqual(frame, this.reference.frames[index], "video scenario order and dimensions");
      await this.compare(index, png, frame);
    }
  }

  async finish() {
    if (!this.update) {
      assert.equal(
        this.frames.length,
        this.reference.frames.length,
        "all video reference frames must run",
      );
      return;
    }
    const width = Math.max(...this.frames.map((frame) => frame.width));
    const height = Math.max(...this.frames.map((frame) => frame.height));
    const inputDir = path.join(this.directory, "input");
    await mkdir(inputDir);
    for (const [index, frame] of this.frames.entries()) {
      await sharp(path.join(this.outputDir, `${frame.name}.png`))
        .extend({ right: width - frame.width, bottom: height - frame.height, background: "black" })
        .png()
        .toFile(frameFile(inputDir, index));
    }
    const video = path.join(this.outputDir, "session-progress.candidate.webm");
    const manifest = {
      version: 1,
      codec: "av1",
      pixelFormat: "gbrp",
      crf: 2,
      fps: 5,
      width,
      height,
      frames: this.frames,
    };
    await writeFile(
      path.join(this.outputDir, "session-progress.candidate.json"),
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
    await this.decode(video, manifest);
    for (const [index, frame] of this.frames.entries()) {
      await this.compare(
        index,
        await readFile(path.join(this.outputDir, `${frame.name}.png`)),
        frame,
      );
    }
    await mkdir(this.goldenDir, { recursive: true });
    await copyFile(video, this.videoPath);
    await writeFile(this.manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }

  async dispose() {
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}
