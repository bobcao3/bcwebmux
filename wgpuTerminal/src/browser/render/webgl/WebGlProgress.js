// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const VERTEX = `#version 300 es
precision highp float;
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_scene;
uniform vec4 u_progress[4];
out vec4 output_color;

vec3 srgb_to_linear(vec3 value) {
  return mix(value / 12.92, pow((value + 0.055) / 1.055, vec3(2.4)), greaterThan(value, vec3(0.04045)));
}

vec3 linear_to_srgb(vec3 value) {
  return mix(value * 12.92, 1.055 * pow(max(value, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
             greaterThan(value, vec3(0.0031308)));
}

vec3 to_oklab(vec3 value) {
  vec3 rgb = srgb_to_linear(value);
  vec3 lms = vec3(
    dot(rgb, vec3(0.4122214708, 0.5363325363, 0.0514459929)),
    dot(rgb, vec3(0.2119034982, 0.6806995451, 0.1073969566)),
    dot(rgb, vec3(0.0883024619, 0.2817188376, 0.6299787005))
  );
  lms = pow(lms, vec3(1.0 / 3.0));
  return vec3(
    dot(lms, vec3(0.2104542553, 0.7936177850, -0.0040720468)),
    dot(lms, vec3(1.9779984951, -2.4285922050, 0.4505937099)),
    dot(lms, vec3(0.0259040371, 0.7827717662, -0.8086757660))
  );
}

vec3 oklab_to_linear(vec3 value) {
  vec3 lms = vec3(
    value.x + 0.3963377774 * value.y + 0.2158037573 * value.z,
    value.x - 0.1055613458 * value.y - 0.0638541728 * value.z,
    value.x - 0.0894841775 * value.y - 1.2914855480 * value.z
  );
  lms = lms * lms * lms;
  vec3 rgb = vec3(
    dot(lms, vec3(4.0767416621, -3.3077115913, 0.2309699292)),
    dot(lms, vec3(-1.2684380046, 2.6097574011, -0.3413193965)),
    dot(lms, vec3(-0.0041960863, -0.7034186147, 1.7076147010))
  );
  return rgb;
}

vec3 snap_palette(vec3 value) {
  return floor(clamp(value, 0.0, 1.0) * 5.0 + 0.5) / 5.0;
}

vec3 quantize(vec3 value, ivec2 pixel) {
  const int bayer[64] = int[64](
    0, 32, 8, 40, 2, 34, 10, 42,
    48, 16, 56, 24, 50, 18, 58, 26,
    12, 44, 4, 36, 14, 46, 6, 38,
    60, 28, 52, 20, 62, 30, 54, 22,
    3, 35, 11, 43, 1, 33, 9, 41,
    51, 19, 59, 27, 49, 17, 57, 25,
    15, 47, 7, 39, 13, 45, 5, 37,
    63, 31, 55, 23, 61, 29, 53, 21
  );
  ivec2 dither_pixel = pixel / ivec2(u_progress[0].zw);
  float threshold = (float(bayer[(dither_pixel.y & 7) * 8 + (dither_pixel.x & 7)]) + 0.5) / 64.0;
  vec3 levels = vec3(5.0);
  vec3 scaled = value * levels;
  return (floor(scaled) + mix(vec3(0.0), vec3(1.0), greaterThan(fract(scaled), vec3(threshold)))) / levels;
}

float bounce_integral(float seconds, float limit) {
  if (limit <= 0.0) return 0.0;
  if (limit >= 2.0 / 3.0) return seconds;
  float period = 4.8;
  float crossing = acos(1.0 - 3.0 * limit) * period / 6.283185307179586;
  float cycles = floor(seconds / period);
  float phase = seconds - cycles * period;
  return cycles * 2.0 * crossing + min(phase, crossing) + max(phase - (period - crossing), 0.0);
}

float bounce_coverage(float t, float seconds, float shutter) {
  float phase = seconds - 4.8 * floor(seconds / 4.8);
  float start = phase - shutter * 0.5;
  float end = phase + shutter * 0.5;
  float upper = bounce_integral(end, t) - bounce_integral(start, t);
  float lower = bounce_integral(end, t - 1.0 / 3.0) - bounce_integral(start, t - 1.0 / 3.0);
  return clamp((upper - lower) / shutter, 0.0, 1.0);
}

float sinc(float value) {
  if (abs(value) < 0.001) return 1.0 - value * value / 6.0;
  return sin(value) / value;
}

void main() {
  vec4 source = texelFetch(u_scene, ivec2(gl_FragCoord.xy), 0);
  vec2 pixel = vec2(gl_FragCoord.x, u_progress[0].y - gl_FragCoord.y);
  float width = u_progress[0].x;
  float height = u_progress[0].y;
  float h = u_progress[2].x;
  if (width <= 0.0 || height < h ||
      pixel.y < height - h || pixel.y >= height) {
    output_color = source;
    return;
  }
  float t = pixel.x / width;
  if (u_progress[2].w < 0.5) {
    output_color = vec4(mix(source.rgb, u_progress[3].rgb, u_progress[2].z), source.a);
    return;
  }
  float fraction = u_progress[1].x;
  float seconds = u_progress[1].y;
  bool animate = u_progress[1].z > 0.5;
  float shutter = u_progress[1].w;
  float coverage;
  if (fraction < 0.0) {
    float offset = animate ? (1.0 - cos(3.141592653589793 * seconds / 2.4)) / 3.0 : 1.0 / 3.0;
    coverage = t >= offset && t < offset + 1.0 / 3.0 ? 1.0 : 0.0;
    if (animate && shutter > 0.0) coverage = bounce_coverage(t, seconds, shutter);
  } else {
    coverage = t < fraction ? 1.0 : 0.0;
  }
  vec3 color = snap_palette(source.rgb);
  if (coverage > 0.0) {
    vec3 lab = to_oklab(source.rgb);
    lab.x = mix(lab.x, 1.0 - lab.x, 0.6);
    lab.x = clamp(lab.x, 0.0, 1.0);
    vec3 low = snap_palette(clamp(linear_to_srgb(oklab_to_linear(lab)), 0.0, 1.0));
    float brightness = u_progress[2].y;
    if (fraction >= 0.0 && animate) {
      float wave_t = (floor(pixel.x / u_progress[0].z) + 0.5) * u_progress[0].z / width;
      float wave = sin(6.283185307179586 * (2.0 * wave_t - seconds / 1.2)) * sinc(3.141592653589793 * shutter / 1.2);
      brightness = max(0.0, wave);
    }
    lab.x = clamp(lab.x + 0.12, 0.0, 1.0);
    vec3 high = snap_palette(clamp(linear_to_srgb(oklab_to_linear(lab)), 0.0, 1.0));
    vec3 filled_color = mix(low, high, brightness);
    color = coverage == 1.0 ? filled_color :
      linear_to_srgb(mix(srgb_to_linear(color), srgb_to_linear(filled_color), coverage));
  }
  vec3 base = quantize(color, ivec2(pixel.x, pixel.y - height + h));
  output_color = vec4(mix(base, u_progress[3].rgb, u_progress[2].z), source.a);
}
`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("WebGL progress shader allocation failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  const error = gl.getShaderInfoLog(shader);
  gl.deleteShader(shader);
  throw new Error(`WebGL progress shader: ${error}`);
}

export class WebGlProgress {
  constructor(gl) {
    this.gl = gl;
    this.width = 0;
    this.height = 0;
    this.texture = null;
    this.framebuffer = null;
    this.program = null;
    this.vertexArray = null;
    let vertex = null;
    let fragment = null;
    try {
      vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX);
      fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT);
      this.program = gl.createProgram();
      if (!this.program) throw new Error("WebGL progress program allocation failed");
      gl.attachShader(this.program, vertex);
      gl.attachShader(this.program, fragment);
      gl.linkProgram(this.program);
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS))
        throw new Error(`WebGL progress program: ${gl.getProgramInfoLog(this.program)}`);
      this.vertexArray = gl.createVertexArray();
      if (!this.vertexArray) throw new Error("WebGL progress vertex array allocation failed");
      this.sceneUniform = gl.getUniformLocation(this.program, "u_scene");
      this.progressUniform = gl.getUniformLocation(this.program, "u_progress[0]");
    } catch (error) {
      this.dispose();
      throw error;
    } finally {
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
    }
  }

  resize(width, height) {
    if (width === this.width && height === this.height) return;
    this.releaseScene();
    this.width = width;
    this.height = height;
  }

  begin(width, height) {
    const gl = this.gl;
    this.resize(width, height);
    if (!this.framebuffer) {
      try {
        this.texture = gl.createTexture();
        this.framebuffer = gl.createFramebuffer();
        if (!this.texture || !this.framebuffer)
          throw new Error("WebGL progress framebuffer allocation failed");
        gl.activeTexture(gl.TEXTURE5);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_2D,
          this.texture,
          0,
        );
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
          throw new Error("WebGL progress framebuffer is incomplete");
      } catch (error) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.releaseScene();
        throw error;
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
  }

  present(uniforms) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vertexArray);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.sceneUniform, 5);
    gl.uniform4fv(this.progressUniform, uniforms);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  releaseScene() {
    if (!this.gl.isContextLost()) {
      this.gl.deleteFramebuffer(this.framebuffer);
      this.gl.deleteTexture(this.texture);
    }
    this.framebuffer = null;
    this.texture = null;
  }

  dispose(contextLost = this.gl.isContextLost()) {
    if (!contextLost) {
      this.gl.deleteFramebuffer(this.framebuffer);
      this.gl.deleteTexture(this.texture);
      this.gl.deleteVertexArray(this.vertexArray);
      this.gl.deleteProgram(this.program);
    }
    this.framebuffer = null;
    this.texture = null;
    this.vertexArray = null;
    this.program = null;
  }
}
