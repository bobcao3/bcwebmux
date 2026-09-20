// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const VERTEX = `#version 300 es
precision highp float;
uniform vec4 u_rect;
uniform vec4 u_source;
uniform vec2 u_viewport;
out vec2 v_texel;
void main() {
  vec2 corner = vec2(float((gl_VertexID == 1 || gl_VertexID == 2 || gl_VertexID == 4) ? 1 : 0),
                     float((gl_VertexID == 2 || gl_VertexID == 4 || gl_VertexID == 5) ? 1 : 0));
  vec2 pos = u_rect.xy + u_rect.zw * corner;
  gl_Position = vec4(pos.x / u_viewport.x * 2.0 - 1.0, 1.0 - pos.y / u_viewport.y * 2.0, 0.0, 1.0);
  v_texel = u_source.xy + corner * u_source.zw;
}`;
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_image;
in vec2 v_texel;
out vec4 output_color;
void main() { output_color = texture(u_image, v_texel); }
`;

function shader(gl, type, code) {
  const value = gl.createShader(type);
  gl.shaderSource(value, code);
  gl.compileShader(value);
  if (gl.getShaderParameter(value, gl.COMPILE_STATUS)) return value;
  const error = gl.getShaderInfoLog(value);
  gl.deleteShader(value);
  throw new Error(`graphics shader: ${error}`);
}

export function initWebGlGraphics(renderer) {
  const gl = renderer.gl;
  const vertex = shader(gl, gl.VERTEX_SHADER, VERTEX);
  const fragment = shader(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  try {
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  } catch (error) { gl.deleteProgram(program); throw error; }
  finally { gl.deleteShader(vertex); gl.deleteShader(fragment); }
  renderer.graphicsProgram = program;
  renderer.graphicsVertexArray = gl.createVertexArray();
  renderer.graphicsUniforms = Object.fromEntries(["rect", "source", "viewport", "image"].map(name => [
    name, gl.getUniformLocation(program, `u_${name}`),
  ]));
}

export function createWebGlGraphicsTexture(renderer, width, height, data) {
  const gl = renderer.gl;
  const texture = gl.createTexture();
  if (!texture) throw new Error("graphics texture allocation failed");
  gl.activeTexture(gl.TEXTURE4);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  if (gl.getError() !== gl.NO_ERROR) { gl.deleteTexture(texture); throw new Error("graphics texture upload failed"); }
  return texture;
}

export function drawWebGlGraphics(renderer, behindText) {
  if (!renderer.graphicsScene?.draws.length) return false;
  const gl = renderer.gl;
  gl.useProgram(renderer.graphicsProgram);
  gl.bindVertexArray(renderer.graphicsVertexArray);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.activeTexture(gl.TEXTURE4);
  gl.uniform1i(renderer.graphicsUniforms.image, 4);
  gl.uniform2f(renderer.graphicsUniforms.viewport, renderer.canvas.width, renderer.canvas.height);
  let drawn = false;
  for (const draw of renderer.graphicsScene.draws) {
    if ((draw.z < 0) !== behindText) continue;
    const resource = renderer.graphicsScene.sources.get(draw.key);
    if (!resource?.texture) continue;
    gl.bindTexture(gl.TEXTURE_2D, resource.texture);
    gl.uniform4f(renderer.graphicsUniforms.rect, draw.x * renderer.physicalCellWidth + draw.offsetX,
      draw.y * renderer.physicalCellHeight + draw.offsetY, draw.width, draw.height);
    gl.uniform4f(renderer.graphicsUniforms.source, draw.sourceX / resource.width, draw.sourceY / resource.height,
      draw.sourceWidth / resource.width, draw.sourceHeight / resource.height);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    drawn = true;
  }
  gl.disable(gl.BLEND);
  gl.bindVertexArray(null);
  return drawn;
}

export function disposeWebGlGraphics(renderer) {
  renderer.graphicsScene?.dispose();
  if (!renderer.contextLost) {
    renderer.gl.deleteVertexArray(renderer.graphicsVertexArray);
    renderer.gl.deleteProgram(renderer.graphicsProgram);
  }
}
