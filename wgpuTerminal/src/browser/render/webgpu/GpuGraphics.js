// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const SOURCE = `
struct Rect {
  destination: vec4<f32>,
  source: vec4<f32>,
  viewport: vec2<f32>,
  padding: vec2<f32>,
};
struct Vertex { @builtin(position) position: vec4<f32>, @location(0) texel: vec2<f32> };
@group(0) @binding(0) var<uniform> rect: Rect;
@group(0) @binding(1) var image: texture_2d<f32>;
@group(0) @binding(2) var nearest: sampler;
@vertex fn vertex(@builtin(vertex_index) index: u32) -> Vertex {
  var result: Vertex;
  let x = select(0.0, 1.0, index == 1u || index == 2u || index == 4u);
  let y = select(0.0, 1.0, index == 2u || index == 4u || index == 5u);
  let coord = vec2<f32>(x, y);
  let pos = rect.destination.xy + rect.destination.zw * coord;
  result.position = vec4<f32>(pos.x / rect.viewport.x * 2.0 - 1.0, 1.0 - pos.y / rect.viewport.y * 2.0, 0.0, 1.0);
  result.texel = rect.source.xy + rect.source.zw * coord;
  return result;
}
@fragment fn fragment(input: Vertex) -> @location(0) vec4<f32> {
  return textureSample(image, nearest, input.texel);
}
`;

export function initGpuGraphics(renderer) {
  const device = renderer.device;
  const module = device.createShaderModule({ code: SOURCE });
  renderer.graphicsPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vertex" },
    fragment: { module, entryPoint: "fragment", targets: [{ format: renderer.format,
      blend: { color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
        alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } },
    }] },
    primitive: { topology: "triangle-list" },
  });
  renderer.graphicsUniform = device.createBuffer({ size: 2048 * 256,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  renderer.graphicsSampler = device.createSampler({ magFilter: "nearest", minFilter: "nearest" });
}

export function createGpuGraphicsTexture(renderer, width, height, data) {
  const texture = renderer.device.createTexture({ size: [width, height], format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  try {
    renderer.device.queue.writeTexture({ texture }, data, { bytesPerRow: width * 4, rowsPerImage: height },
      [width, height, 1]);
    return texture;
  } catch (error) { texture.destroy(); throw error; }
}

export function drawGpuGraphics(renderer, pass, behindText) {
  if (!renderer.graphicsScene?.draws.length) return false;
  const rects = new Float32Array(renderer.graphicsScene.draws.length * 64);
  const prepared = [];
  for (const [index, draw] of renderer.graphicsScene.draws.entries()) {
    const source = renderer.graphicsScene.sources.get(draw.key);
    if (!source?.texture) continue;
    const offset = index * 64;
    rects.set([
      draw.x * renderer.physicalCellWidth + draw.offsetX,
      draw.y * renderer.physicalCellHeight + draw.offsetY, draw.width, draw.height,
      draw.sourceX / source.width, draw.sourceY / source.height,
      draw.sourceWidth / source.width, draw.sourceHeight / source.height,
      renderer.canvas.width, renderer.canvas.height, 0, 0,
    ], offset);
    if ((draw.z < 0) === behindText) prepared.push({ source, index });
  }
  if (!prepared.length) return false;
  renderer.device.queue.writeBuffer(renderer.graphicsUniform, 0, rects.buffer, 0, rects.byteLength);
  pass.setPipeline(renderer.graphicsPipeline);
  for (let i = 0; i < prepared.length; i++) {
    const group = renderer.device.createBindGroup({
      layout: renderer.graphicsPipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: renderer.graphicsUniform, offset: prepared[i].index * 256, size: 48 } },
        { binding: 1, resource: prepared[i].source.texture.createView() },
        { binding: 2, resource: renderer.graphicsSampler },
      ],
    });
    pass.setBindGroup(0, group);
    pass.draw(6);
  }
  return true;
}

export function disposeGpuGraphics(renderer) {
  renderer.graphicsScene?.dispose();
  renderer.graphicsUniform?.destroy();
}
