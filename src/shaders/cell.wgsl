// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

alias Lowp = f32;

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
  grain_strength: f32,
  tile_width: u32,
  tile_height: u32,
  blink_on: u32,
  canvas_atlas: u32,
}

struct Cell {
  glyph: u32,
  data: u32,
}

struct Style {
  fg: u32,
  bg: u32,
  flags: u32,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) @interpolate(flat) cell_size: vec2<u32>,
  @location(2) @interpolate(flat) cell_x: u32,
  @location(3) @interpolate(flat) cell_y: u32,
  @location(4) @interpolate(flat) fg: u32,
  @location(5) @interpolate(flat) bg: u32,
  @location(6) @interpolate(flat) flags: u32,
  @location(7) @interpolate(flat) glyph: u32,
  @location(8) @interpolate(flat) selected: u32,
  @location(9) @interpolate(flat) tile_origin: vec2<u32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> cells: array<Cell>;
@group(0) @binding(2) var<storage, read> styles: array<Style>;
@group(0) @binding(3) var<storage, read> selections: array<u32>;
@group(0) @binding(4) var atlas_texture: texture_2d<f32>;
@group(0) @binding(5) var grain_texture: texture_2d<i32>;

fn rgb(value: u32) -> vec3<Lowp> {
  return vec3<Lowp>(
    Lowp(f32((value >> 16u) & 255u)),
    Lowp(f32((value >> 8u) & 255u)),
    Lowp(f32(value & 255u))
  ) / Lowp(255.0);
}

fn srgb_to_linear(value: vec3<Lowp>) -> vec3<Lowp> {
  return select(
    value / Lowp(12.92),
    pow((value + vec3<Lowp>(0.055)) / Lowp(1.055), vec3<Lowp>(2.4)),
    value > vec3<Lowp>(0.04045)
  );
}

fn relative_luminance(value: u32) -> Lowp {
  return dot(
    srgb_to_linear(rgb(value)),
    vec3<Lowp>(0.2126, 0.7152, 0.0722)
  );
}

fn tile_hash(tile: vec2<u32>) -> u32 {
  var hash = tile.x * 0x9e3779b9u + tile.y;
  hash = hash ^ (hash >> 16u);
  hash = hash * 0x85ebca6bu;
  return hash ^ (hash >> 13u);
}

@vertex
fn vertex(@builtin(vertex_index) vertex_index: u32, @builtin(instance_index) instance_index: u32) -> VertexOutput {
  let corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
    vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0)
  );
  let cell = cells[instance_index];
  let cell_data = cell.data;
  let corner = corners[vertex_index];
  let x = instance_index % uniforms.cols;
  let y = instance_index / uniforms.cols;
  let width = select(1u, 2u, (cell_data & 0x00010000u) != 0u);
  let style = styles[cell_data & 0xffffu];
  let selection = selections[y];
  let selection_active = (selection & 0x80000000u) != 0u;
  let selection_start = selection & 0xffffu;
  let selection_end = (selection >> 16u) & 0x7fffu;
  let selected = selection_active &&
    x <= selection_end &&
    x + width > selection_start;
  var tile_origin = vec2<u32>(0u);
  if (cell.glyph != 0u) {
    let slot = cell.glyph - 1u;
    tile_origin = vec2<u32>(
      slot % uniforms.atlas_cols,
      slot / uniforms.atlas_cols
    ) * vec2<u32>(uniforms.tile_width, uniforms.tile_height);
  }
  let origin = vec2<u32>(
    x * uniforms.cell_width,
    y * uniforms.cell_height
  );
  let end = vec2<u32>(
    (x + width) * uniforms.cell_width,
    (y + 1u) * uniforms.cell_height
  );
  let size = end - origin;
  let pixel = vec2<f32>(origin) + corner * vec2<f32>(size);
  var fg = style.fg;
  var bg = style.bg;
  if (selected) {
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
  var output: VertexOutput;
  output.position = vec4<f32>(pixel.x / f32(uniforms.viewport_width) * 2.0 - 1.0, 1.0 - pixel.y / f32(uniforms.viewport_height) * 2.0, 0.0, 1.0);
  output.local = corner * vec2<f32>(size);
  output.cell_size = size;
  output.cell_x = x;
  output.cell_y = y;
  output.fg = fg;
  output.bg = bg;
  output.flags = style.flags;
  output.glyph = cell.glyph;
  output.selected = select(0u, 1u, selected);
  output.tile_origin = tile_origin;
  if ((cell_data & 0x00020000u) == 0u) {
    output.position = vec4<f32>(2.0, 2.0, 0.0, 1.0);
  }
  return output;
}

@fragment
fn fragment(input: VertexOutput) -> @location(0) vec4<f32> {
  let flags = input.flags;
  let fg = input.fg;
  let bg = input.bg;
  let selected = input.selected != 0u;
  var result = rgb(bg);
  if ((flags & 256u) == 0u || selected) {
    let global_pixel = vec2<u32>(
      u32(input.position.x),
      u32(input.position.y)
    );
    let tile_coord = global_pixel >> vec2<u32>(6u);
    var grain_coord = global_pixel & vec2<u32>(63u);
    let symmetry = tile_hash(tile_coord) & 7u;
    if ((symmetry & 1u) != 0u) {
      grain_coord = grain_coord.yx;
    }
    if ((symmetry & 2u) != 0u) {
      grain_coord.x = 63u - grain_coord.x;
    }
    if ((symmetry & 4u) != 0u) {
      grain_coord.y = 63u - grain_coord.y;
    }
    let grain = Lowp(textureLoad(grain_texture, vec2<i32>(grain_coord), 0).r);
    result = clamp(
      result + vec3<Lowp>(grain * Lowp(uniforms.grain_strength) / Lowp(0.5 * 255.0)),
      vec3<Lowp>(0.0),
      vec3<Lowp>(1.0)
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
  if (cursor_visible && input.cell_x == uniforms.cursor_x && input.cell_y == uniforms.cursor_y) {
    if (uniforms.cursor_style == 0u && input.local.x < 2.0) {
      result = rgb(uniforms.default_fg);
    } else if (uniforms.cursor_style == 2u && y >= f32(input.cell_size.y) - 2.0) {
      result = rgb(uniforms.default_fg);
    } else if (uniforms.cursor_style != 0u && uniforms.cursor_style != 2u) {
      result = mix(result, rgb(uniforms.default_fg), Lowp(0.45));
    }
  }
  let glyph = input.glyph;
  let text_visible = glyph != 0u && ((flags & 128u) == 0u || uniforms.blink_on != 0u);
  if (text_visible) {
    let local_texel = vec2<u32>(input.local);
    let atlas_texel = textureLoad(atlas_texture, vec2<i32>(input.tile_origin + local_texel), 0);
    let coverage = select(Lowp(atlas_texel.r), Lowp(atlas_texel.a), uniforms.canvas_atlas != 0u) * select(Lowp(1.0), Lowp(0.62), (flags & 4u) != 0u);
    result = mix(result, rgb(fg), coverage);
  }
  return vec4<f32>(vec3<f32>(result), 1.0);
}
