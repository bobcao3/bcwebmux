struct Uniforms {
  cols: u32,
  rows: u32,
  cell_width: f32,
  cell_height: f32,
  viewport_width: f32,
  viewport_height: f32,
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
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> cells: array<Cell>;
@group(0) @binding(2) var atlas_texture: texture_2d<f32>;

fn rgb(value: u32) -> vec3<f32> {
  return vec3<f32>(f32((value >> 16u) & 255u), f32((value >> 8u) & 255u), f32(value & 255u)) / 255.0;
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
  let origin = vec2<f32>(
    round(f32(cell.x) * uniforms.cell_width),
    round(f32(cell.y) * uniforms.cell_height)
  );
  let end = vec2<f32>(
    round(f32(cell.x + width) * uniforms.cell_width),
    round(f32(cell.y + 1u) * uniforms.cell_height)
  );
  let size = end - origin;
  let pixel = origin + corner * size;
  var output: VertexOutput;
  output.position = vec4<f32>(pixel.x / uniforms.viewport_width * 2.0 - 1.0, 1.0 - pixel.y / uniforms.viewport_height * 2.0, 0.0, 1.0);
  output.local = corner * size;
  output.cell_index = cell_index;
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
    fg = fg ^ 0x00ffffffu;
    bg = bg ^ 0x00ffffffu;
  }
  var result = rgb(bg);
  let y = input.local.y;
  let decoration = ((flags & 8u) != 0u && y >= uniforms.cell_height - 2.0 && y < uniforms.cell_height - 1.0) ||
    ((flags & 16u) != 0u && y >= floor(uniforms.cell_height * 0.52) && y < floor(uniforms.cell_height * 0.52) + 1.0) ||
    ((flags & 32u) != 0u && y < 1.0);
  if (decoration) {
    result = rgb(fg);
  }
  let cursor_visible = (uniforms.cursor_flags & 1u) != 0u && ((uniforms.cursor_flags & 2u) == 0u || uniforms.blink_on != 0u);
  if (cursor_visible && cell.x == uniforms.cursor_x && cell.y == uniforms.cursor_y) {
    if (uniforms.cursor_style == 0u && input.local.x < 2.0) {
      result = rgb(uniforms.default_fg);
    } else if (uniforms.cursor_style == 2u && y >= uniforms.cell_height - 2.0) {
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
