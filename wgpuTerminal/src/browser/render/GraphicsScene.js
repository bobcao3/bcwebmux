// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const MAX_DECODED_BYTES = 32 * 1024 * 1024;

async function pixels(source) {
  let bytes = source.bytes;
  if (source.compression) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
    const reader = stream.getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > (source.format === 100 ? 32 * 1024 * 1024 : source.width * source.height * 4)) {
          await reader.cancel();
          throw new Error("graphics decompression budget exceeded");
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  }
  const { width, height, format } = source;
  if (format === 100) {
    if (source.pngSize && bytes.length !== source.pngSize) throw new Error("invalid graphics PNG length");
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }), {
      premultiplyAlpha: "none", colorSpaceConversion: "none",
    });
    try {
      if (bitmap.width !== width || bitmap.height !== height) throw new Error("invalid graphics PNG dimensions");
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("graphics decoder unavailable");
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, width, height).data;
    } finally { bitmap.close(); }
  }
  const channels = format === 24 ? 3 : 4;
  if (bytes.length !== width * height * channels) throw new Error("invalid graphics raw length");
  if (channels === 4) return bytes;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < bytes.length; i += 3, j += 4) {
    rgba[j] = bytes[i]; rgba[j + 1] = bytes[i + 1]; rgba[j + 2] = bytes[i + 2]; rgba[j + 3] = 255;
  }
  return rgba;
}

export class GraphicsScene {
  constructor(backend) {
    this.backend = backend;
    this.sources = new Map();
    this.draws = [];
    this.epoch = 0;
    this.decodedBytes = 0;
  }

  dispose() {
    this.epoch++;
    for (const value of this.sources.values()) this.backend.destroyGraphicsTexture(value.texture);
    this.sources.clear();
    this.draws = [];
    this.decodedBytes = 0;
  }

  update(packet) {
    const epoch = ++this.epoch;
    const previous = this.sources;
    this.sources = new Map();
    const keys = [];
    const resources = packet.graphicsResources;
    for (let i = 0; i < resources.byteLength / 44; i++) {
      const o = i * 44;
      const key = `${resources.getUint32(o, true)}:${resources.getUint32(o + 4, true)}:${resources.getUint32(o + 12, true)}:${resources.getUint32(o + 8, true)}`;
      keys.push(key);
      const retained = previous.get(key);
      if (retained) {
        this.sources.set(key, retained);
        previous.delete(key);
      } else {
        this.sources.set(key, { width: resources.getUint32(o + 16, true), height: resources.getUint32(o + 20, true), texture: null });
      }
    }
    for (const value of previous.values()) {
      if (value.texture) { this.decodedBytes -= value.width * value.height * 4; this.backend.destroyGraphicsTexture(value.texture); }
    }
    this.draws = [];
    const draws = packet.graphicsDraws;
    for (let i = 0; i < draws.byteLength / 48; i++) {
      const o = i * 48;
      this.draws.push({
        key: keys[draws.getUint32(o, true)], z: draws.getInt32(o + 4, true),
        x: draws.getInt32(o + 8, true), y: draws.getInt32(o + 12, true),
        width: draws.getUint32(o + 16, true), height: draws.getUint32(o + 20, true),
        sourceX: draws.getUint32(o + 24, true), sourceY: draws.getUint32(o + 28, true),
        sourceWidth: draws.getUint32(o + 32, true), sourceHeight: draws.getUint32(o + 36, true),
        offsetX: draws.getUint32(o + 40, true), offsetY: draws.getUint32(o + 44, true),
      });
    }
    const queue = [];
    for (let i = 0; i < keys.length; i++) {
      if (this.sources.get(keys[i]).texture || this.sources.get(keys[i]).failed) continue;
      const o = i * 44;
      const width = resources.getUint32(o + 16, true), height = resources.getUint32(o + 20, true);
      if (this.decodedBytes + width * height * 4 > MAX_DECODED_BYTES) continue;
      queue.push({ key: keys[i], width, height,
        format: resources.getUint32(o + 24, true), compression: resources.getUint32(o + 28, true),
        pngSize: resources.getUint32(o + 32, true), bytes: Uint8Array.from(packet.graphicsBytes[i]) });
    }
    const worker = async () => {
      while (queue.length && epoch === this.epoch && !this.backend.disposed) {
        const source = queue.shift();
        try {
          if (this.decodedBytes + source.width * source.height * 4 > MAX_DECODED_BYTES) continue;
          const data = await pixels(source);
          if (epoch !== this.epoch || this.backend.disposed) return;
          const value = this.sources.get(source.key);
          const size = source.width * source.height * 4;
          if (!value || this.decodedBytes + size > MAX_DECODED_BYTES) continue;
          value.texture = this.backend.createGraphicsTexture(source.width, source.height, data);
          this.decodedBytes += size;
          this.backend.presenter?.requestPresentation();
        } catch (error) {
          if (epoch === this.epoch) {
            const value = this.sources.get(source.key);
            if (value) value.failed = true;
            if (!this.backend.disposed) this.backend.onGraphicsError?.(error);
          }
        }
      }
    };
    for (let i = 0; i < Math.min(2, queue.length); i++) void worker();
  }
}
