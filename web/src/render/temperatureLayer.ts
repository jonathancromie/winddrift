import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl";
import { isGlobal, type FrameGrid } from "../data/frame";
import { scaleGlsl } from "./temperatureScale";

const VERT = /* glsl */ `#version 300 es
precision highp float;
uniform mat4 u_matrix;
out vec2 v_mercator;
void main() {
  // The whole Mercator world, as a strip of two triangles.
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  v_mercator = corner;
  gl_Position = u_matrix * vec4(corner, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D u_baseA;
uniform sampler2D u_baseB;
uniform float u_baseMix;
uniform vec4 u_baseGrid;
uniform sampler2D u_nestA;
uniform sampler2D u_nestB;
uniform sampler2D u_nestMask;
uniform float u_nestMix;
uniform float u_nestWeight;
uniform vec4 u_nestGrid;
uniform float u_opacity;

in vec2 v_mercator;
out vec4 color;

const float PI = 3.141592653589793;

${scaleGlsl()}

void main() {
  float lon = v_mercator.x * 360.0 - 180.0;
  float lat = degrees(2.0 * atan(exp(PI * (1.0 - 2.0 * v_mercator.y))) - PI / 2.0);

  vec2 uv = (vec2(lon, lat) - u_baseGrid.xy) / u_baseGrid.zw;
  float celsius = mix(texture(u_baseA, uv).r, texture(u_baseB, uv).r, u_baseMix);

  if (u_nestWeight > 0.0) {
    vec2 nestUv = (vec2(lon, lat) - u_nestGrid.xy) / u_nestGrid.zw;
    float blend = texture(u_nestMask, nestUv).r * u_nestWeight;
    if (blend > 0.0) {
      float nest = mix(texture(u_nestA, nestUv).r, texture(u_nestB, nestUv).r, u_nestMix);
      celsius = mix(celsius, nest, blend);
    }
  }

  color = vec4(scale(celsius) * u_opacity, u_opacity);
}
`;

export interface TemperaturePair {
  a: WebGLTexture;
  b: WebGLTexture;
  mix: number;
  grid: FrameGrid;
}

export interface TemperatureTextures extends TemperaturePair {
  nest?: TemperaturePair & { mask: WebGLTexture; weight: number };
}

/** Strong enough to read the scale, while leaving coastlines and terrain visible. */
const OPACITY = 0.5;

/** Texture placement as origin and span. Values sit at cell centres, half a cell inside the edge. */
function gridUniform(grid: FrameGrid): number[] {
  return [grid.lon0 - grid.dlon / 2, grid.lat0 - grid.dlat / 2, grid.nx * grid.dlon, grid.ny * grid.dlat];
}

/** A color wash of temperature, drawn beneath the wind particles. */
export class TemperatureLayer implements CustomLayerInterface {
  readonly id = "temperature";
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  private map!: MapLibreMap;
  private gl!: WebGL2RenderingContext;
  private program!: WebGLProgram;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private vao!: WebGLVertexArrayObject;
  private field: TemperatureTextures | null = null;

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl as WebGL2RenderingContext;
    const gl2 = this.gl;
    const program = gl2.createProgram()!;
    for (const [type, source] of [
      [gl2.VERTEX_SHADER, VERT],
      [gl2.FRAGMENT_SHADER, FRAG],
    ] as const) {
      const shader = gl2.createShader(type)!;
      gl2.shaderSource(shader, source);
      gl2.compileShader(shader);
      if (!gl2.getShaderParameter(shader, gl2.COMPILE_STATUS)) {
        throw new Error(`Temperature shader failed: ${gl2.getShaderInfoLog(shader)}`);
      }
      gl2.attachShader(program, shader);
      gl2.deleteShader(shader);
    }
    gl2.linkProgram(program);
    if (!gl2.getProgramParameter(program, gl2.LINK_STATUS)) {
      throw new Error(`Temperature program failed: ${gl2.getProgramInfoLog(program)}`);
    }
    this.program = program;
    const count = gl2.getProgramParameter(program, gl2.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < count; i++) {
      const name = gl2.getActiveUniform(program, i)!.name;
      this.uniforms[name] = gl2.getUniformLocation(program, name);
    }
    this.vao = gl2.createVertexArray()!;
  }

  onRemove(): void {
    this.gl.deleteProgram(this.program);
    this.gl.deleteVertexArray(this.vao);
  }

  setField(field: TemperatureTextures | null): void {
    this.field = field;
    this.map?.triggerRepaint();
  }

  createTexture(grid: FrameGrid, data: Uint16Array): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, grid.nx, grid.ny, 0, gl.RED, gl.HALF_FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, isGlobal(grid) ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return texture;
  }

  deleteTexture(texture: WebGLTexture): void {
    this.gl.deleteTexture(texture);
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    const { field } = this;
    if (!field) return;
    const gl2 = gl as WebGL2RenderingContext;
    const { uniforms } = this;
    gl2.disable(gl2.DEPTH_TEST);
    gl2.disable(gl2.STENCIL_TEST);
    gl2.disable(gl2.CULL_FACE);
    gl2.enable(gl2.BLEND);
    gl2.blendFunc(gl2.ONE, gl2.ONE_MINUS_SRC_ALPHA);
    gl2.useProgram(this.program);
    gl2.uniformMatrix4fv(uniforms.u_matrix, false, args.defaultProjectionData.mainMatrix as Float32Array);
    gl2.uniform1f(uniforms.u_opacity, OPACITY);

    const bind = (name: string, unit: number, texture: WebGLTexture) => {
      gl2.activeTexture(gl2.TEXTURE0 + unit);
      gl2.bindTexture(gl2.TEXTURE_2D, texture);
      gl2.uniform1i(uniforms[name], unit);
    };
    bind("u_baseA", 0, field.a);
    bind("u_baseB", 1, field.b);
    gl2.uniform1f(uniforms.u_baseMix, field.mix);
    gl2.uniform4fv(uniforms.u_baseGrid, gridUniform(field.grid));

    const { nest } = field;
    gl2.uniform1f(uniforms.u_nestWeight, nest ? nest.weight : 0);
    if (nest) {
      bind("u_nestA", 2, nest.a);
      bind("u_nestB", 3, nest.b);
      bind("u_nestMask", 4, nest.mask);
      gl2.uniform1f(uniforms.u_nestMix, nest.mix);
      gl2.uniform4fv(uniforms.u_nestGrid, gridUniform(nest.grid));
    }
    gl2.bindVertexArray(this.vao);
    gl2.drawArrays(gl2.TRIANGLE_STRIP, 0, 4);
    gl2.bindVertexArray(null);
    gl2.activeTexture(gl2.TEXTURE0);
  }
}
