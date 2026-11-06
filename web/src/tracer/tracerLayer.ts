import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl";
import { headPositions, type Plume } from "./plume";

const MERCATOR = /* glsl */ `
const float PI = 3.141592653589793;
vec2 toMercator(vec2 lonLat) {
  return vec2((lonLat.x + 180.0) / 360.0, 0.5 - log(tan(PI / 4.0 + radians(lonLat.y) / 2.0)) / (2.0 * PI));
}
`;

const TRAIL_VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_point; // lon, lat, hours since release
uniform mat4 u_matrix;
out float v_hours;
${MERCATOR}
void main() {
  gl_Position = u_matrix * vec4(toMercator(a_point.xy), 0.0, 1.0);
  v_hours = a_point.z;
}
`;

/** Older parts of the plume thin out, while staying visible as a record of the route. */
const TRAIL_FRAG = /* glsl */ `#version 300 es
precision mediump float;
uniform vec3 u_color;
uniform float u_hours;
in float v_hours;
out vec4 color;
void main() {
  if (v_hours > u_hours) discard;
  float alpha = 0.12 + 0.4 * exp((v_hours - u_hours) / 8.0);
  color = vec4(u_color * alpha, alpha);
}
`;

const HEAD_VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_position;
uniform mat4 u_matrix;
uniform float u_size;
${MERCATOR}
void main() {
  gl_Position = u_matrix * vec4(toMercator(a_position), 0.0, 1.0);
  gl_PointSize = u_size;
}
`;

const HEAD_FRAG = /* glsl */ `#version 300 es
precision mediump float;
uniform vec3 u_color;
uniform float u_opacity;
uniform float u_softness; // 0 gives a crisp dot, 1 a glow that fades from the centre
out vec4 color;
void main() {
  float edge = length(gl_PointCoord - 0.5) * 2.0;
  float crisp = 1.0 - smoothstep(0.6, 1.0, edge);
  float glow = pow(max(1.0 - edge, 0.0), 2.0);
  float alpha = u_opacity * mix(crisp, glow, u_softness);
  color = vec4(u_color * alpha, alpha);
}
`;

interface Program {
  handle: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

function createProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string): Program {
  const handle = gl.createProgram()!;
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertex],
    [gl.FRAGMENT_SHADER, fragment],
  ] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`Tracer shader failed: ${gl.getShaderInfoLog(shader)}`);
    }
    gl.attachShader(handle, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(handle);
  if (!gl.getProgramParameter(handle, gl.LINK_STATUS)) {
    throw new Error(`Tracer program failed: ${gl.getProgramInfoLog(handle)}`);
  }
  const uniforms: Program["uniforms"] = {};
  const count = gl.getProgramParameter(handle, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < count; i++) {
    const name = gl.getActiveUniform(handle, i)!.name;
    uniforms[name] = gl.getUniformLocation(handle, name);
  }
  return { handle, uniforms };
}

/** Line segments for every member's path, as lon, lat, hours for each end. */
export function trailVertices(plume: Plume): Float32Array {
  const out = new Float32Array(plume.members * Math.max(plume.points - 1, 0) * 6);
  const hoursPerPoint = plume.recordMs / 3600000;
  let n = 0;
  for (let m = 0; m < plume.members; m++) {
    const settled = plume.settledAt[m];
    const lastPoint = settled >= 0 ? Math.min(settled, plume.points - 1) : plume.points - 1;
    for (let point = 0; point < lastPoint; point++) {
      const offset = (m * plume.capacity + point) * 2;
      const lonA = plume.positions[offset];
      const lonB = plume.positions[offset + 2];
      // A segment across the antimeridian would streak across the whole map.
      if (Math.abs(lonA - lonB) > 180) continue;
      out[n++] = lonA;
      out[n++] = plume.positions[offset + 1];
      out[n++] = point * hoursPerPoint;
      out[n++] = lonB;
      out[n++] = plume.positions[offset + 3];
      out[n++] = (point + 1) * hoursPerPoint;
    }
  }
  return out.subarray(0, n);
}

/** Draws the plume: faint trails for where parcels have been, and bright dots for where they are. */
export class TracerLayer implements CustomLayerInterface {
  readonly id = "tracer-plume";
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  private gl!: WebGL2RenderingContext;
  private map!: MapLibreMap;
  private trail!: Program;
  private head!: Program;
  private trailVao!: WebGLVertexArrayObject;
  private trailBuffer!: WebGLBuffer;
  private headVao!: WebGLVertexArrayObject;
  private headBuffer!: WebGLBuffer;

  private plume: Plume | null = null;
  private color: [number, number, number] = [1, 1, 1];
  private trailCount = 0;
  private heads = new Float32Array(0);
  private headCount = 0;
  private hours = 0;

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl as WebGL2RenderingContext;
    const gl2 = this.gl;
    this.trail = createProgram(gl2, TRAIL_VERT, TRAIL_FRAG);
    this.head = createProgram(gl2, HEAD_VERT, HEAD_FRAG);

    const attribute = (size: number): [WebGLVertexArrayObject, WebGLBuffer] => {
      const vao = gl2.createVertexArray()!;
      const buffer = gl2.createBuffer()!;
      gl2.bindVertexArray(vao);
      gl2.bindBuffer(gl2.ARRAY_BUFFER, buffer);
      gl2.enableVertexAttribArray(0);
      gl2.vertexAttribPointer(0, size, gl2.FLOAT, false, 0, 0);
      gl2.bindVertexArray(null);
      gl2.bindBuffer(gl2.ARRAY_BUFFER, null);
      return [vao, buffer];
    };
    [this.trailVao, this.trailBuffer] = attribute(3);
    [this.headVao, this.headBuffer] = attribute(2);
  }

  onRemove(): void {
    const gl = this.gl;
    gl.deleteProgram(this.trail.handle);
    gl.deleteProgram(this.head.handle);
    gl.deleteVertexArray(this.trailVao);
    gl.deleteVertexArray(this.headVao);
    gl.deleteBuffer(this.trailBuffer);
    gl.deleteBuffer(this.headBuffer);
  }

  setPlume(plume: Plume | null, color: [number, number, number]): void {
    this.plume = plume;
    this.color = color;
    if (plume) {
      const gl = this.gl;
      const vertices = trailVertices(plume);
      this.trailCount = vertices.length / 3;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.trailBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      if (this.heads.length !== plume.members * 2) this.heads = new Float32Array(plume.members * 2);
    }
    this.map.triggerRepaint();
  }

  setTime(timeMs: number): void {
    const { plume } = this;
    if (!plume) return;
    this.hours = (timeMs - plume.startMs) / 3600000;
    this.headCount = headPositions(plume, timeMs, this.heads);
    this.map.triggerRepaint();
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    if (!this.plume || this.hours < 0) return;
    const gl2 = gl as WebGL2RenderingContext;
    const matrix = args.defaultProjectionData.mainMatrix as Float32Array;
    gl2.disable(gl2.DEPTH_TEST);
    gl2.disable(gl2.STENCIL_TEST);
    gl2.enable(gl2.BLEND);
    gl2.blendFunc(gl2.ONE, gl2.ONE_MINUS_SRC_ALPHA);

    gl2.useProgram(this.trail.handle);
    gl2.uniformMatrix4fv(this.trail.uniforms.u_matrix, false, matrix);
    gl2.uniform3fv(this.trail.uniforms.u_color, this.color);
    gl2.uniform1f(this.trail.uniforms.u_hours, this.hours);
    gl2.bindVertexArray(this.trailVao);
    gl2.drawArrays(gl2.LINES, 0, this.trailCount);

    if (this.headCount > 0) {
      gl2.useProgram(this.head.handle);
      gl2.uniformMatrix4fv(this.head.uniforms.u_matrix, false, matrix);
      gl2.uniform3fv(this.head.uniforms.u_color, this.color);
      gl2.bindVertexArray(this.headVao);
      gl2.bindBuffer(gl2.ARRAY_BUFFER, this.headBuffer);
      gl2.bufferData(gl2.ARRAY_BUFFER, this.heads.subarray(0, this.headCount * 2), gl2.DYNAMIC_DRAW);
      // Overlapping glows build into a cloud, with a dot showing each parcel on top.
      const pointScale = window.devicePixelRatio;
      gl2.uniform1f(this.head.uniforms.u_size, 44 * pointScale);
      gl2.uniform1f(this.head.uniforms.u_opacity, 0.1);
      gl2.uniform1f(this.head.uniforms.u_softness, 1);
      gl2.drawArrays(gl2.POINTS, 0, this.headCount);
      gl2.uniform1f(this.head.uniforms.u_size, 4.5 * pointScale);
      gl2.uniform1f(this.head.uniforms.u_opacity, 0.95);
      gl2.uniform1f(this.head.uniforms.u_softness, 0);
      gl2.drawArrays(gl2.POINTS, 0, this.headCount);
      gl2.bindBuffer(gl2.ARRAY_BUFFER, null);
    }
    gl2.bindVertexArray(null);
  }
}
