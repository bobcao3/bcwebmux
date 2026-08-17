// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

struct Uniforms {
  cols: u32,
  rows: u32,
  cell_width: u32,
  cell_height: u32,
  viewport_width: u32,
  viewport_height: u32,
  default_bg: u32,
  default_fg: u32,
  cursor_x: u32,
  cursor_y: u32,
  cursor_flags: u32,
  cursor_style: u32,
  atlas_cols: u32,
  atlas_rows: u32,
  blink_on: u32,
  cell_count: u32,
}

struct Cell {
  x: u32,
  y: u32,
  width: u32,
  flags: u32,
  fg: u32,
  bg: u32,
  glyph: u32,
  enabled: u32,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) @interpolate(flat) cell_index: u32,
  @location(2) @interpolate(flat) cell_size: vec2<u32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> cells: array<Cell>;
@group(0) @binding(2) var atlas_texture: texture_2d<f32>;
@group(0) @binding(3) var grain_texture: texture_2d<f32>;
@group(0) @binding(4) var grain_sampler: sampler;

fn rgb(value: u32) -> vec3<f32> {
  return vec3<f32>(f32((value >> 16u) & 255u), f32((value >> 8u) & 255u), f32(value & 255u)) / 255.0;
}

fn srgb_to_linear(value: vec3<f32>) -> vec3<f32> {
  return select(
    value / 12.92,
    pow((value + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4)),
    value > vec3<f32>(0.04045)
  );
}

fn relative_luminance(value: u32) -> f32 {
  return dot(
    srgb_to_linear(rgb(value)),
    vec3<f32>(0.2126, 0.7152, 0.0722)
  );
}

@vertex
fn vertex(@builtin(vertex_index) vertex_index: u32, @builtin(instance_index) instance_index: u32) -> VertexOutput {
  let corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
    vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0)
  );
  let cell_index = instance_index;
  let cell = cells[instance_index];
  let corner = corners[vertex_index];
  let width = cell.width;
  let origin = vec2<u32>(
    cell.x * uniforms.cell_width,
    cell.y * uniforms.cell_height
  );
  let end = vec2<u32>(
    (cell.x + width) * uniforms.cell_width,
    (cell.y + 1u) * uniforms.cell_height
  );
  let size = end - origin;
  let pixel = vec2<f32>(origin) + corner * vec2<f32>(size);
  var output: VertexOutput;
  output.position = vec4<f32>(pixel.x / f32(uniforms.viewport_width) * 2.0 - 1.0, 1.0 - pixel.y / f32(uniforms.viewport_height) * 2.0, 0.0, 1.0);
  output.local = corner * vec2<f32>(size);
  output.cell_index = cell_index;
  output.cell_size = size;
  if (cell.enabled == 0u) {
    output.position = vec4<f32>(2.0, 2.0, 0.0, 1.0);
  }
  return output;
}

@fragment
fn fragment(input: VertexOutput) -> @location(0) vec4<f32> {
  let cell = cells[input.cell_index];
  let flags = cell.flags;
  var fg = cell.fg;
  var bg = cell.bg;
  if ((flags & 64u) != 0u) {
    let original_fg = fg;
    let original_bg = bg;
    let invisible = (original_fg & 0x00ffffffu) == (original_bg & 0x00ffffffu);
    let selected_bg_rgb = select(
      0x000000u,
      0x00ffffffu,
      relative_luminance(original_bg) <= 0.1791288
    );
    let selected_fg_rgb = select(
      select(0x00ffffffu, 0x000000u, selected_bg_rgb == 0x00ffffffu),
      selected_bg_rgb,
      invisible
    );
    fg = (original_fg & 0xff000000u) | selected_fg_rgb;
    bg = (original_bg & 0xff000000u) | selected_bg_rgb;
  }
  let global_pixel = vec2<u32>(
    cell.x * uniforms.cell_width,
    cell.y * uniforms.cell_height
  ) + vec2<u32>(floor(input.local));
  let grain = textureSample(
    grain_texture,
    grain_sampler,
    (vec2<f32>(global_pixel) + vec2<f32>(0.5)) / 64.0
  ).r;
  var result = rgb(bg);
  if ((flags & 256u) == 0u) {
    result = clamp(
      result + vec3<f32>(grain * 127.0 / 255.0),
      vec3<f32>(0.0),
      vec3<f32>(1.0)
    );
  }
  let y = input.local.y;
  let decoration = ((flags & 8u) != 0u && y >= f32(input.cell_size.y) - 2.0 && y < f32(input.cell_size.y) - 1.0) ||
    ((flags & 16u) != 0u && y >= floor(f32(input.cell_size.y) * 0.52) && y < floor(f32(input.cell_size.y) * 0.52) + 1.0) ||
    ((flags & 32u) != 0u && y < 1.0);
  if (decoration) {
    result = rgb(fg);
  }
  let cursor_visible = (uniforms.cursor_flags & 1u) != 0u && ((uniforms.cursor_flags & 2u) == 0u || uniforms.blink_on != 0u);
  if (cursor_visible && cell.x == uniforms.cursor_x && cell.y == uniforms.cursor_y) {
    if (uniforms.cursor_style == 0u && input.local.x < 2.0) {
      result = rgb(uniforms.default_fg);
    } else if (uniforms.cursor_style == 2u && y >= f32(input.cell_size.y) - 2.0) {
      result = rgb(uniforms.default_fg);
    } else if (uniforms.cursor_style != 0u && uniforms.cursor_style != 2u) {
      result = mix(result, rgb(uniforms.default_fg), 0.45);
    }
  }
  let text_visible = cell.glyph != 0u && ((flags & 128u) == 0u || uniforms.blink_on != 0u);
  if (text_visible) {
    let atlas_size = textureDimensions(atlas_texture);
    let tile_size = atlas_size / vec2<u32>(uniforms.atlas_cols, uniforms.atlas_rows);
    let slot = cell.glyph - select(0u, 1u, cell.glyph != 0u);
    let tile_origin = vec2<u32>(slot % uniforms.atlas_cols, slot / uniforms.atlas_cols) * tile_size;
    let local_texel = vec2<u32>(
      clamp(u32(floor(input.local.x)), 0u, tile_size.x - 1u),
      clamp(u32(floor(input.local.y)), 0u, tile_size.y - 1u)
    );
    let coverage = textureLoad(atlas_texture, vec2<i32>(tile_origin + local_texel), 0).r * select(1.0, 0.62, (flags & 4u) != 0u);
    result = mix(result, rgb(fg), coverage);
  }
  return vec4<f32>(result, 1.0);
}
