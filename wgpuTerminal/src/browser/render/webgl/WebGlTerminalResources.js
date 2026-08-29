// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import { WebGlGlyphAtlas } from "./WebGlGlyphAtlas.js";

const VERTEX_SOURCE = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in uvec2 cell;
uniform uint u_cols;
uniform uint u_cell_width;
uniform uint u_cell_height;
uniform uint u_viewport_width;
uniform uint u_viewport_height;
uniform uint u_atlas_cols;
uniform uint u_tile_width;
uniform uint u_tile_height;
uniform uint u_style_texture_width;
uniform uint u_selection_texture_width;
uniform highp usampler2D u_styles;
uniform highp usampler2D u_selections;

out vec2 v_local;
flat out uvec2 v_cell_size;
flat out uvec2 v_cell_coord;
flat out uvec2 v_colors;
flat out uvec2 v_flags_glyph;
flat out uint v_selected;
flat out uvec2 v_tile_origin;
flat out uvec2 v_pixel_origin;

vec3 rgb(uint value) {
  return vec3(float((value >> 16u) & 255u), float((value >> 8u) & 255u), float(value & 255u)) / 255.0;
}

vec3 srgb_to_linear(vec3 value) {
  return mix(value / 12.92, pow((value + vec3(0.055)) / 1.055, vec3(2.4)), greaterThan(value, vec3(0.04045)));
}

float relative_luminance(uint value) {
  return dot(srgb_to_linear(rgb(value)), vec3(0.2126, 0.7152, 0.0722));
}

void main() {
  const vec2 corners[6] = vec2[6](
    vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0),
    vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0)
  );
  uint glyph = cell.x;
  uint cell_data = cell.y;
  vec2 corner = corners[gl_VertexID];
  uint instance = uint(gl_InstanceID);
  uint x = instance % u_cols;
  uint y = instance / u_cols;
  uint width = (cell_data & 0x00010000u) != 0u ? 2u : 1u;
  uint style_id = cell_data & 0xffffu;
  uvec3 style = texelFetch(u_styles, ivec2(int(style_id % u_style_texture_width), int(style_id / u_style_texture_width)), 0).rgb;
  uint selection = texelFetch(u_selections, ivec2(int(y % u_selection_texture_width), int(y / u_selection_texture_width)), 0).r;
  bool selection_active = (selection & 0x80000000u) != 0u;
  uint selection_start = selection & 0xffffu;
  uint selection_end = (selection >> 16u) & 0x7fffu;
  bool selected = selection_active && x <= selection_end && x + width > selection_start;
  uvec2 tile_origin = uvec2(0u);
  if (glyph != 0u) {
    uint slot = glyph - 1u;
    tile_origin = uvec2(slot % u_atlas_cols, slot / u_atlas_cols) * uvec2(u_tile_width, u_tile_height);
  }
  uvec2 origin = uvec2(x * u_cell_width, y * u_cell_height);
  uvec2 end = uvec2((x + width) * u_cell_width, (y + 1u) * u_cell_height);
  uvec2 size = end - origin;
  vec2 pixel = vec2(origin) + corner * vec2(size);
  uint fg = style.r;
  uint bg = style.g;
  if (selected) {
    uint original_fg = fg;
    uint original_bg = bg;
    bool invisible = (original_fg & 0x00ffffffu) == (original_bg & 0x00ffffffu);
    uint selected_bg_rgb = relative_luminance(original_bg) <= 0.1791288 ? 0x00ffffffu : 0x000000u;
    uint selected_fg_rgb = invisible ? selected_bg_rgb : (selected_bg_rgb == 0x00ffffffu ? 0x000000u : 0x00ffffffu);
    fg = (original_fg & 0xff000000u) | selected_fg_rgb;
    bg = (original_bg & 0xff000000u) | selected_bg_rgb;
  }
  gl_Position = vec4(pixel.x / float(u_viewport_width) * 2.0 - 1.0, 1.0 - pixel.y / float(u_viewport_height) * 2.0, 0.0, 1.0);
  if ((cell_data & 0x00020000u) == 0u) gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
  v_local = corner * vec2(size);
  v_cell_size = size;
  v_cell_coord = uvec2(x, y);
  v_colors = uvec2(fg, bg);
  v_flags_glyph = uvec2(style.b, glyph);
  v_selected = selected ? 1u : 0u;
  v_tile_origin = tile_origin;
  v_pixel_origin = origin;
}
`;

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;
precision highp int;

uniform uint u_default_fg;
uniform uint u_cursor_x;
uniform uint u_cursor_y;
uniform uint u_cursor_flags;
uniform uint u_cursor_style;
uniform uint u_blink_on;
uniform uint u_canvas_atlas;
uniform float u_grain_strength;
uniform sampler2D u_atlas;
uniform sampler2D u_grain;

in vec2 v_local;
flat in uvec2 v_cell_size;
flat in uvec2 v_cell_coord;
flat in uvec2 v_colors;
flat in uvec2 v_flags_glyph;
flat in uint v_selected;
flat in uvec2 v_tile_origin;
flat in uvec2 v_pixel_origin;
out vec4 output_color;

vec3 rgb(uint value) {
  return vec3(float((value >> 16u) & 255u), float((value >> 8u) & 255u), float(value & 255u)) / 255.0;
}

uint tile_hash(uvec2 tile) {
  uint hash = tile.x * 0x9e3779b9u + tile.y;
  hash = hash ^ (hash >> 16u);
  hash = hash * 0x85ebca6bu;
  return hash ^ (hash >> 13u);
}

void main() {
  uint flags = v_flags_glyph.x;
  uint glyph = v_flags_glyph.y;
  uint fg = v_colors.x;
  uint bg = v_colors.y;
  bool selected = v_selected != 0u;
  vec3 result = rgb(bg);
  uvec2 global_pixel = v_pixel_origin + uvec2(v_local);
  if ((flags & 256u) == 0u || selected) {
    uvec2 tile_coord = global_pixel >> uvec2(6u);
    uvec2 grain_coord = global_pixel & uvec2(63u);
    uint symmetry = tile_hash(tile_coord) & 7u;
    if ((symmetry & 1u) != 0u) grain_coord = grain_coord.yx;
    if ((symmetry & 2u) != 0u) grain_coord.x = 63u - grain_coord.x;
    if ((symmetry & 4u) != 0u) grain_coord.y = 63u - grain_coord.y;
    float grain = texelFetch(u_grain, ivec2(grain_coord), 0).r;
    result = clamp(result + vec3(grain * u_grain_strength / 255.0), vec3(0.0), vec3(1.0));
  }
  float y = v_local.y;
  bool decoration = ((flags & 8u) != 0u && y >= float(v_cell_size.y) - 2.0 && y < float(v_cell_size.y) - 1.0) ||
    ((flags & 16u) != 0u && y >= floor(float(v_cell_size.y) * 0.52) && y < floor(float(v_cell_size.y) * 0.52) + 1.0) ||
    ((flags & 32u) != 0u && y < 1.0);
  if (decoration) result = rgb(fg);
  bool cursor_visible = (u_cursor_flags & 1u) != 0u && ((u_cursor_flags & 2u) == 0u || u_blink_on != 0u);
  if (cursor_visible && v_cell_coord.x == u_cursor_x && v_cell_coord.y == u_cursor_y) {
    if (u_cursor_style == 0u && v_local.x < 2.0) result = rgb(u_default_fg);
    else if (u_cursor_style == 2u && y >= float(v_cell_size.y) - 2.0) result = rgb(u_default_fg);
    else if (u_cursor_style != 0u && u_cursor_style != 2u) result = mix(result, rgb(u_default_fg), 0.45);
  }
  bool text_visible = glyph != 0u && ((flags & 128u) == 0u || u_blink_on != 0u);
  if (text_visible) {
    vec4 atlas_texel = texelFetch(u_atlas, ivec2(v_tile_origin + uvec2(v_local)), 0);
    float coverage = (u_canvas_atlas != 0u ? atlas_texel.a : atlas_texel.r) * ((flags & 4u) != 0u ? 0.62 : 1.0);
    result = mix(result, rgb(fg), coverage);
  }
  output_color = vec4(result, 1.0);
}
`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("WebGL shader allocation failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "unknown shader error";
    gl.deleteShader(shader);
    throw new Error(`WebGL shader compilation failed: ${message}`);
  }
  return shader;
}

function createProgram(gl) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SOURCE);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
  const program = gl.createProgram();
  if (!program) throw new Error("WebGL program allocation failed");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "unknown link error";
    gl.deleteProgram(program);
    throw new Error(`WebGL program link failed: ${message}`);
  }
  return program;
}

function createTexture(gl, internalFormat, width, height) {
  const texture = gl.createTexture();
  if (!texture) throw new Error("WebGL texture allocation failed");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, width, height);
  return texture;
}

export function initializeWebGl(renderer, cellSource, grain, grainSize, maxCells, maxGlyphs, maxStyles, styleSize, atlasSlots, cellSize) {
  if (renderer.initialized) {
    const matches = maxCells === renderer.maxCells && maxGlyphs === renderer.maxGlyphs &&
      maxStyles === renderer.maxStyles && styleSize === renderer.styleSize &&
      cellSize === renderer.cellSize && grainSize === 64 && grain.length === grainSize * grainSize;
    if (!matches) throw new Error("terminal core renderer ABI mismatch");
    return 1;
  }
  if (!(grain instanceof Int8Array) || grainSize !== 64 || grain.length !== grainSize * grainSize) {
    throw new Error("invalid grain texture");
  }
  if (maxCells <= 0 || maxGlyphs <= 0 || maxStyles <= 0 || styleSize !== 12 ||
      atlasSlots <= 0 || atlasSlots > maxGlyphs || cellSize !== 8 || !cellSource.includes("alias Lowp = f32;")) {
    throw new Error("invalid GPU initialization constants");
  }
  Object.assign(renderer, { maxCells, maxGlyphs, maxStyles, styleSize, cellSize, atlasRequiredSlots: atlasSlots });
  const gl = renderer.gl;
  const maxDimension = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  renderer.styleTextureWidth = Math.min(maxStyles, maxDimension);
  renderer.styleTextureHeight = Math.ceil(maxStyles / renderer.styleTextureWidth);
  renderer.selectionTextureWidth = Math.min(maxCells, maxDimension);
  renderer.selectionTextureHeight = Math.ceil(maxCells / renderer.selectionTextureWidth);
  const font = getComputedStyle(renderer.canvas.parentElement);
  renderer.atlas = new WebGlGlyphAtlas(
    gl,
    font,
    atlasSlots,
    maxGlyphs,
    renderer.textRenderer === "kb-canvas" ? "rgba8unorm" : "r8unorm",
    renderer.physicalCellWidth,
    renderer.physicalCellHeight,
    renderer.physicalFontSize,
  );
  renderer.program = createProgram(gl);
  renderer.vertexArray = gl.createVertexArray();
  renderer.cellBuffer = gl.createBuffer();
  if (!renderer.vertexArray || !renderer.cellBuffer) throw new Error("WebGL cell buffer allocation failed");
  gl.bindVertexArray(renderer.vertexArray);
  gl.bindBuffer(gl.ARRAY_BUFFER, renderer.cellBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, maxCells * cellSize, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribIPointer(0, 2, gl.UNSIGNED_INT, cellSize, 0);
  gl.vertexAttribDivisor(0, 1);
  renderer.styleTexture = createTexture(gl, gl.RGB32UI, renderer.styleTextureWidth, renderer.styleTextureHeight);
  renderer.selectionTexture = createTexture(gl, gl.R32UI, renderer.selectionTextureWidth, renderer.selectionTextureHeight);
  renderer.grainTexture = createTexture(gl, gl.R8_SNORM, grainSize, grainSize);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, grainSize, grainSize, gl.RED, gl.BYTE, grain);
  renderer.uniforms = {};
  for (const name of [
    "cols", "cell_width", "cell_height", "viewport_width", "viewport_height", "default_fg",
    "cursor_x", "cursor_y", "cursor_flags", "cursor_style", "atlas_cols", "grain_strength",
    "tile_width", "tile_height", "blink_on", "canvas_atlas", "style_texture_width",
    "selection_texture_width", "atlas", "styles", "selections", "grain",
  ]) {
    const location = gl.getUniformLocation(renderer.program, `u_${name}`);
    if (location === null) throw new Error(`WebGL uniform u_${name} unavailable`);
    renderer.uniforms[name] = location;
  }
  gl.useProgram(renderer.program);
  gl.uniform1i(renderer.uniforms.atlas, 0);
  gl.uniform1i(renderer.uniforms.styles, 1);
  gl.uniform1i(renderer.uniforms.selections, 2);
  gl.uniform1i(renderer.uniforms.grain, 3);
  gl.disable(gl.BLEND);
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.DITHER);
  gl.disable(gl.SCISSOR_TEST);
  gl.bindVertexArray(null);
  renderer.initialized = true;
  return 1;
}

export function resizeWebGl(renderer, widthValue, heightValue) {
  const width = Math.round(Number(widthValue));
  const height = Math.round(Number(heightValue));
  const maximum = renderer.gl.getParameter(renderer.gl.MAX_TEXTURE_SIZE);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 ||
      width > maximum || height > maximum) {
    throw new Error("invalid GPU viewport dimensions");
  }
  renderer.viewportWidth = width;
  renderer.viewportHeight = height;
  renderer.pixelScaleX = width / Math.max(1, renderer.canvas.clientWidth);
  renderer.pixelScaleY = height / Math.max(1, renderer.canvas.clientHeight);
  if (renderer.canvas.width === width && renderer.canvas.height === height) return;
  renderer.canvas.width = width;
  renderer.canvas.height = height;
  renderer.gl.viewport(0, 0, width, height);
  if (renderer.rows) renderer.draw();
}

export function readWebGlPixels(renderer) {
  if (!renderer.initialized) throw new Error("GPU terminal is not initialized");
  renderer.draw();
  const gl = renderer.gl;
  const width = renderer.canvas.width;
  const height = renderer.canvas.height;
  const source = new Uint8Array(width * height * 4);
  const data = new Uint8Array(source.length);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, source);
  const stride = width * 4;
  for (let y = 0; y < height; y += 1) {
    data.set(source.subarray((height - y - 1) * stride, (height - y) * stride), y * stride);
  }
  return { width, height, format: "rgba8unorm", data };
}

export function disposeWebGl(renderer) {
  if (renderer.error === "disposed") return;
  if (renderer.blinkTimer) clearTimeout(renderer.blinkTimer);
  const gl = renderer.gl;
  renderer.canvas.removeEventListener("webglcontextlost", renderer.contextLostListener);
  renderer.canvas.removeEventListener("webglcontextrestored", renderer.contextRestoredListener);
  renderer.atlas?.dispose();
  gl.deleteTexture(renderer.styleTexture);
  gl.deleteTexture(renderer.selectionTexture);
  gl.deleteTexture(renderer.grainTexture);
  gl.deleteBuffer(renderer.cellBuffer);
  gl.deleteVertexArray(renderer.vertexArray);
  gl.deleteProgram(renderer.program);
  renderer.error = "disposed";
  renderer.initialized = false;
}
