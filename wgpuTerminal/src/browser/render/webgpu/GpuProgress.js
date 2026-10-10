// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

export function initGpuProgress(renderer, source) {
  const device = renderer.device;
  const module = device.createShaderModule({ code: source });
  renderer.progressPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vertex" },
    fragment: {
      module,
      entryPoint: "fragment",
      targets: [{ format: renderer.format }],
    },
    primitive: { topology: "triangle-list" },
  });
  renderer.progressUniform = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
}

export function resetGpuProgress(renderer) {
  renderer.progressOutput?.destroy();
  renderer.progressOutput = null;
  renderer.progressOutputView = null;
  renderer.progressBindGroup = null;
}

export function drawGpuProgress(renderer, encoder, progress, now) {
  if (!progress?.visible) {
    resetGpuProgress(renderer);
    return renderer.offscreen;
  }
  const device = renderer.device;
  if (!renderer.progressOutput) {
    let output = null;
    try {
      output = device.createTexture({
        size: [renderer.canvas.width, renderer.canvas.height],
        format: renderer.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      const view = output.createView();
      const bindGroup = device.createBindGroup({
        layout: renderer.progressPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: renderer.progressUniform } },
          { binding: 1, resource: renderer.offscreenView },
        ],
      });
      renderer.progressOutput = output;
      renderer.progressOutputView = view;
      renderer.progressBindGroup = bindGroup;
    } catch (error) {
      output?.destroy();
      throw error;
    }
  }
  device.queue.writeBuffer(renderer.progressUniform, 0, progress.uniforms(now, renderer));
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: renderer.progressOutputView,
        loadOp: "clear",
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        storeOp: "store",
      },
    ],
  });
  pass.setPipeline(renderer.progressPipeline);
  pass.setBindGroup(0, renderer.progressBindGroup);
  pass.draw(3);
  pass.end();
  return renderer.progressOutput;
}

export function disposeGpuProgress(renderer) {
  resetGpuProgress(renderer);
  renderer.progressUniform?.destroy();
  renderer.progressUniform = null;
  renderer.progressPipeline = null;
}
