// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

struct Progress {
  viewport: vec2<f32>,
  block: vec2<f32>,
  fraction: f32,
  seconds: f32,
  animate: f32,
  shutter: f32,
  barHeight: f32,
  completed: f32,
  reserved: vec2<f32>,
};

@group(0) @binding(0) var<uniform> progress: Progress;
@group(0) @binding(1) var scene: texture_2d<f32>;

const PI = 3.141592653589793;
const BAYER = array<f32, 64>(
  0.0, 32.0, 8.0, 40.0, 2.0, 34.0, 10.0, 42.0,
  48.0, 16.0, 56.0, 24.0, 50.0, 18.0, 58.0, 26.0,
  12.0, 44.0, 4.0, 36.0, 14.0, 46.0, 6.0, 38.0,
  60.0, 28.0, 52.0, 20.0, 62.0, 30.0, 54.0, 22.0,
  3.0, 35.0, 11.0, 43.0, 1.0, 33.0, 9.0, 41.0,
  51.0, 19.0, 59.0, 27.0, 49.0, 17.0, 57.0, 25.0,
  15.0, 47.0, 7.0, 39.0, 13.0, 45.0, 5.0, 37.0,
  63.0, 31.0, 55.0, 23.0, 61.0, 29.0, 53.0, 21.0,
);
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

fn quantize(value: vec3<f32>, threshold: f32) -> vec3<f32> {
  let levels = vec3<f32>(5.0);
  let scaled = value * levels;
  return (floor(scaled) + select(vec3<f32>(0.0), vec3<f32>(1.0), fract(scaled) > vec3<f32>(threshold))) / levels;
}

fn snapPalette(value: vec3<f32>) -> vec3<f32> {
  return floor(clamp(value, vec3<f32>(0.0), vec3<f32>(1.0)) * 5.0 + 0.5) / 5.0;
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
  let h = progress.barHeight;
  let width = progress.viewport.x;
  if (width <= 0.0 || progress.viewport.y < h ||
      position.y < progress.viewport.y - h || position.y >= progress.viewport.y) {
    return source;
  }
  let t = position.x / width;
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
  var color = snapPalette(source.rgb);
  if (coverage > 0.0) {
    var lab = linearToOklab(srgbToLinear(source.rgb));
    lab.x = mix(lab.x, 1.0 - lab.x, 0.6);
    lab.x = clamp(lab.x, 0.0, 1.0);
    let low = snapPalette(linearToSrgb(oklabToLinear(lab)));
    lab.x += 0.12;
    lab.x = clamp(lab.x, 0.0, 1.0);
    let high = snapPalette(linearToSrgb(oklabToLinear(lab)));
    var brightness = progress.completed;
    if (progress.fraction >= 0.0 && progress.animate == 1.0) {
      let waveT = (floor(position.x / progress.block.x) + 0.5) * progress.block.x / width;
      let wave = sin(2.0 * PI * (2.0 * waveT - progress.seconds / 1.2)) * sinc(PI * progress.shutter / 1.2);
      brightness = max(0.0, wave);
    }
    let filledColor = mix(low, high, brightness);
    if (coverage == 1.0) {
      color = filledColor;
    } else {
      color = linearToSrgb(mix(srgbToLinear(color), srgbToLinear(filledColor), coverage));
    }
  }
  let barTop = i32(progress.viewport.y - h);
  let ditherPixel = vec2<u32>(pixel - vec2<i32>(0, barTop)) / vec2<u32>(progress.block);
  let index = (ditherPixel.y % 8u) * 8u + ditherPixel.x % 8u;
  let threshold = (BAYER[index] + 0.5) / 64.0;
  return vec4<f32>(quantize(color, threshold), source.a);
}
