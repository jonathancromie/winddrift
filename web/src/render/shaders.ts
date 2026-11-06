const RANDOM = /* glsl */ `
uint pcg(uint value) {
  uint state = value * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
float nextRandom(inout uint state) {
  state = pcg(state);
  return float(state) / 4294967295.0;
}
`;

/** One simulation step per particle. State is (lon, lat, remaining life in s, speed in m/s). */
export const SIMULATE_VERT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

layout(location = 0) in vec4 a_state;

uniform sampler2D u_windA;
uniform sampler2D u_windB;
uniform float u_mix;
uniform vec4 u_grid;     // lon origin, lat origin, lon span, lat span
uniform sampler2D u_nestA;
uniform sampler2D u_nestB;
uniform sampler2D u_nestMask;
uniform float u_nestMix;
uniform float u_nestWeight; // 0 turns the regional model off
uniform vec4 u_nestGrid;
uniform vec4 u_bounds;   // west, south, east, north in degrees
uniform vec2 u_mercatorY; // top and bottom of the view in Mercator Y
uniform float u_windSeconds;
uniform float u_realSeconds;
uniform uint u_frame;

out vec4 v_state;

const float PI = 3.141592653589793;
const float RADIANS_TO_DEGREES = 180.0 / PI;
const float EARTH_RADIUS = 6371229.0;
${RANDOM}

float latitudeFromMercator(float y) {
  return RADIANS_TO_DEGREES * (2.0 * atan(exp(PI * (1.0 - 2.0 * y))) - PI / 2.0);
}

void main() {
  uint seed = uint(gl_VertexID) * 1597334677u ^ (u_frame * 3812015801u);
  float lon = a_state.x;
  float lat = a_state.y;
  float life = a_state.z - u_realSeconds;

  vec2 uv = vec2(lon - u_grid.x, lat - u_grid.y) / u_grid.zw;
  vec2 wind = mix(textureLod(u_windA, uv, 0.0).rg, textureLod(u_windB, uv, 0.0).rg, u_mix);

  if (u_nestWeight > 0.0) {
    vec2 nestUv = vec2(lon - u_nestGrid.x, lat - u_nestGrid.y) / u_nestGrid.zw;
    // Clamped sampling reads the mask's zero border for anywhere outside the grid.
    float blend = textureLod(u_nestMask, nestUv, 0.0).r * u_nestWeight;
    if (blend > 0.0) {
      vec2 nest = mix(textureLod(u_nestA, nestUv, 0.0).rg, textureLod(u_nestB, nestUv, 0.0).rg, u_nestMix);
      wind = mix(wind, nest, blend);
    }
  }

  float cosLat = max(cos(radians(lat)), 0.01);
  lon += wind.x * u_windSeconds / (EARTH_RADIUS * cosLat) * RADIANS_TO_DEGREES;
  lat += wind.y * u_windSeconds / EARTH_RADIUS * RADIANS_TO_DEGREES;
  if (lon > 180.0) lon -= 360.0;
  if (lon < -180.0) lon += 360.0;

  bool outside = lon < u_bounds.x || lon > u_bounds.z || lat < u_bounds.y || lat > u_bounds.w;
  if (life <= 0.0 || outside) {
    lon = mix(u_bounds.x, u_bounds.z, nextRandom(seed));
    lat = latitudeFromMercator(mix(u_mercatorY.x, u_mercatorY.y, nextRandom(seed)));
    life = 1.5 + 3.5 * nextRandom(seed);
  }

  v_state = vec4(lon, lat, life, length(wind));
  gl_Position = vec4(0.0);
}
`;

export const EMPTY_FRAG = /* glsl */ `#version 300 es
precision lowp float;
out vec4 color;
void main() { color = vec4(0.0); }
`;

export const PARTICLE_VERT = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec4 a_state;

uniform mat4 u_matrix;
uniform float u_pointSize;

out vec4 v_color;

const float PI = 3.141592653589793;

vec3 ramp(float speed) {
  const vec3 calm = vec3(0.30, 0.56, 0.72);
  const vec3 breeze = vec3(0.72, 0.92, 0.90);
  const vec3 strong = vec3(1.00, 0.71, 0.33);
  const vec3 storm = vec3(1.00, 0.30, 0.43);
  if (speed < 6.0) return mix(calm, breeze, speed / 6.0);
  if (speed < 16.0) return mix(breeze, strong, (speed - 6.0) / 10.0);
  return mix(strong, storm, clamp((speed - 16.0) / 16.0, 0.0, 1.0));
}

void main() {
  float x = (a_state.x + 180.0) / 360.0;
  float y = 0.5 - log(tan(PI / 4.0 + radians(a_state.y) / 2.0)) / (2.0 * PI);
  gl_Position = u_matrix * vec4(x, y, 0.0, 1.0);
  gl_PointSize = u_pointSize;

  float speed = a_state.w;
  float alpha = smoothstep(0.0, 0.6, a_state.z) * mix(0.28, 0.8, smoothstep(0.0, 10.0, speed));
  v_color = vec4(ramp(speed) * alpha, alpha);
}
`;

export const PARTICLE_FRAG = /* glsl */ `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 color;
void main() {
  float edge = length(gl_PointCoord - 0.5) * 2.0;
  color = v_color * (1.0 - smoothstep(0.6, 1.0, edge));
}
`;

export const QUAD_VERT = /* glsl */ `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
  // A single triangle that covers the whole screen.
  vec2 corner = vec2(float((gl_VertexID & 1) << 2), float((gl_VertexID & 2) << 1));
  v_uv = corner * 0.5;
  gl_Position = vec4(corner - 1.0, 0.0, 1.0);
}
`;

/** Fades the previous trail image. The subtraction clears residue that 8-bit rounding leaves. */
export const FADE_FRAG = /* glsl */ `#version 300 es
precision mediump float;
uniform sampler2D u_trails;
uniform float u_fade;
in vec2 v_uv;
out vec4 color;
void main() {
  color = max(texture(u_trails, v_uv) * u_fade - 1.0 / 255.0, 0.0);
}
`;

export const COMPOSITE_FRAG = /* glsl */ `#version 300 es
precision mediump float;
uniform sampler2D u_trails;
in vec2 v_uv;
out vec4 color;
void main() {
  color = texture(u_trails, v_uv);
}
`;
