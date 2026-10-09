// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

struct Progress {
  viewport: vec2<f32>,
  cell: vec2<f32>,
  fraction: f32,
  seconds: f32,
  animate: f32,
  shutter: f32,
};

@group(0) @binding(0) var<uniform> progress: Progress;
@group(0) @binding(1) var scene: texture_2d<f32>;

const PI = 3.141592653589793;
const BAYER = array<f32, 16>(
  0.0, 8.0, 2.0, 10.0,
  12.0, 4.0, 14.0, 6.0,
  3.0, 11.0, 1.0, 9.0,
  15.0, 7.0, 13.0, 5.0,
);
const CUBE = array<f32, 6>(0.0, 95.0 / 255.0, 135.0 / 255.0, 175.0 / 255.0, 215.0 / 255.0, 1.0);

@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let x = select(-1.0, 3.0, index == 1u);
  let y = select(-1.0, 3.0, index == 2u);
  return vec4<f32>(x, y, 0.0, 1.0);
}

fn srgbToLinear(value: vec3<f32>) -> vec3<f32> {
  return select(pow((value + 0.055) / 1.055, vec3<f32>(2.4)), value / 12.92, value <= vec3<f32>(0.04045));
}

fn linearToSrgb(value: vec3<f32>) -> vec3<f32> {
  let positive = max(value, vec3<f32>(0.0));
  return clamp(select(1.055 * pow(positive, vec3<f32>(1.0 / 2.4)) - 0.055, 12.92 * value, value <= vec3<f32>(0.0031308)), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn linearToOklab(rgb: vec3<f32>) -> vec3<f32> {
  let lms = vec3<f32>(
    dot(rgb, vec3<f32>(0.4122214708, 0.5363325363, 0.0514459929)),
    dot(rgb, vec3<f32>(0.2119034982, 0.6806995451, 0.1073969566)),
    dot(rgb, vec3<f32>(0.0883024619, 0.2817188376, 0.6299787005)),
  );
  let root = pow(lms, vec3<f32>(1.0 / 3.0));
  return vec3<f32>(
    dot(root, vec3<f32>(0.2104542553, 0.7936177850, -0.0040720468)),
    dot(root, vec3<f32>(1.9779984951, -2.4285922050, 0.4505937099)),
    dot(root, vec3<f32>(0.0259040371, 0.7827717662, -0.8086757660)),
  );
}

fn oklabToLinear(lab: vec3<f32>) -> vec3<f32> {
  let root = vec3<f32>(
    lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z,
    lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z,
    lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z,
  );
  let lms = root * root * root;
  return vec3<f32>(
    dot(lms, vec3<f32>(4.0767416621, -3.3077115913, 0.2309699292)),
    dot(lms, vec3<f32>(-1.2684380046, 2.6097574011, -0.3413193965)),
    dot(lms, vec3<f32>(-0.0041960863, -0.7034186147, 1.7076147010)),
  );
}

fn nearestCube(value: f32) -> f32 {
  var nearest = CUBE[0];
  var distance = abs(value - nearest);
  for (var index = 1u; index < 6u; index += 1u) {
    let candidateDistance = abs(value - CUBE[index]);
    if (candidateDistance < distance) {
      nearest = CUBE[index];
      distance = candidateDistance;
    }
  }
  return nearest;
}

fn ditherCube(value: f32, threshold: f32) -> f32 {
  for (var index = 1u; index < 6u; index += 1u) {
    if (value <= CUBE[index]) {
      let lower = CUBE[index - 1u];
      let upper = CUBE[index];
      return select(lower, upper, (value - lower) / (upper - lower) > threshold);
    }
  }
  return 1.0;
}

fn quantize(value: vec3<f32>, threshold: f32) -> vec3<f32> {
  let cube = vec3<f32>(nearestCube(value.r), nearestCube(value.g), nearestCube(value.b));
  let mean = (value.r + value.g + value.b) / 3.0;
  let grayIndex = clamp(floor((mean * 255.0 - 8.0) / 10.0 + 0.5), 0.0, 23.0);
  let gray = vec3<f32>((8.0 + 10.0 * grayIndex) / 255.0);
  let cubeDelta = value - cube;
  let grayDelta = value - gray;
  if (dot(grayDelta, grayDelta) <= dot(cubeDelta, cubeDelta)) {
    let index = clamp(floor((mean * 255.0 - 8.0) / 10.0 + threshold), 0.0, 23.0);
    return vec3<f32>((8.0 + 10.0 * index) / 255.0);
  }
  return vec3<f32>(ditherCube(value.r, threshold), ditherCube(value.g, threshold), ditherCube(value.b, threshold));
}

fn bounceIntegral(seconds: f32, limit: f32) -> f32 {
  if (limit <= 0.0) { return 0.0; }
  if (limit >= 2.0 / 3.0) { return seconds; }
  let period = 4.8;
  let crossing = acos(1.0 - 3.0 * limit) * period / (2.0 * PI);
  let cycles = floor(seconds / period);
  let phase = seconds - cycles * period;
  return cycles * 2.0 * crossing + min(phase, crossing) + max(phase - (period - crossing), 0.0);
}

fn bounceCoverage(t: f32, seconds: f32, shutter: f32) -> f32 {
  let phase = seconds - 4.8 * floor(seconds / 4.8);
  let start = phase - shutter * 0.5;
  let end = phase + shutter * 0.5;
  let upper = bounceIntegral(end, t) - bounceIntegral(start, t);
  let lower = bounceIntegral(end, t - 1.0 / 3.0) - bounceIntegral(start, t - 1.0 / 3.0);
  return clamp((upper - lower) / shutter, 0.0, 1.0);
}

fn sinc(value: f32) -> f32 {
  if (abs(value) < 0.001) { return 1.0 - value * value / 6.0; }
  return sin(value) / value;
}

@fragment fn fragment(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let pixel = vec2<i32>(position.xy);
  let source = textureLoad(scene, pixel, 0);
  let h = max(1.0, 0.2 * progress.cell.y);
  let width = progress.viewport.x - 2.0 * progress.cell.x;
  if (width <= 0.0 || progress.viewport.y < h ||
      position.x < progress.cell.x || position.x >= progress.viewport.x - progress.cell.x ||
      position.y < progress.viewport.y - h || position.y >= progress.viewport.y) {
    return source;
  }
  let t = (position.x - progress.cell.x) / width;
  var coverage = select(0.0, 1.0, t < progress.fraction);
  if (progress.fraction < 0.0) {
    var offset = 1.0 / 3.0;
    if (progress.animate == 1.0) {
      offset = (1.0 - cos(PI * progress.seconds / 2.4)) / 3.0;
    }
    coverage = select(0.0, 1.0, t >= offset && t < offset + 1.0 / 3.0);
    if (progress.animate == 1.0 && progress.shutter > 0.0) {
      coverage = bounceCoverage(t, progress.seconds, progress.shutter);
    }
  }
  var color = source.rgb;
  if (coverage > 0.0) {
    var lab = linearToOklab(srgbToLinear(color));
    lab.x = mix(lab.x, 1.0 - lab.x, 0.6);
    if (progress.fraction >= 0.0 && progress.animate == 1.0) {
      lab.x += 0.12 * sin(2.0 * PI * (2.0 * t - progress.seconds / 1.2)) * sinc(PI * progress.shutter / 1.2);
    }
    lab.x = clamp(lab.x, 0.0, 1.0);
    color = linearToSrgb(mix(srgbToLinear(source.rgb), oklabToLinear(lab), coverage));
  }
  let index = (u32(pixel.y) % 4u) * 4u + u32(pixel.x) % 4u;
  let threshold = (BAYER[index] + 0.5) / 16.0;
  return vec4<f32>(quantize(color, threshold), source.a);
}
