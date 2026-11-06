import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl";
import { isGlobal, type FrameGrid } from "../data/frame";
import { MAX_MERCATOR_LAT, mercatorY, timeCompression } from "./geo";
import { ParticleBudget } from "./particleBudget";
import {
  COMPOSITE_FRAG,
  EMPTY_FRAG,
  FADE_FRAG,
  PARTICLE_FRAG,
  PARTICLE_VERT,
  QUAD_VERT,
  SIMULATE_VERT,
} from "./shaders";

const STATE_FLOATS = 4;
const PIXELS_PER_SECOND_PER_MS = 2.2;
/** How long particles move to draw a still picture: long enough to build their trails. */
const STILL_REDRAW_MS = 2500;

type Uniforms = Record<string, WebGLUniformLocation | null>;

interface Program {
  handle: WebGLProgram;
  uniforms: Uniforms;
}

interface StateBuffer {
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
}

export interface WindPair {
  a: WebGLTexture;
  b: WebGLTexture;
  mix: number;
  grid: FrameGrid;
}

export interface WindTextures extends WindPair {
  /** A regional model blended over the global wind. */
  nest?: WindPair & { mask: WebGLTexture; weight: number };
}

export interface ParticleLayerStats {
  particles: number;
  frameMs: number;
}

/** GPU wind particles with fading trails, drawn as a MapLibre custom layer. */
export class ParticleLayer implements CustomLayerInterface {
  readonly id = "wind-particles";
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  readonly stats: ParticleLayerStats = { particles: 0, frameMs: 16 };

  private map!: MapLibreMap;
  private gl!: WebGL2RenderingContext;
  private simulate!: Program;
  private particle!: Program;
  private fade!: Program;
  private composite!: Program;
  private states!: [StateBuffer, StateBuffer];
  private feedback!: WebGLTransformFeedback;
  private framebuffer!: WebGLFramebuffer;
  private trails: [WebGLTexture, WebGLTexture] | null = null;
  private trailSize: [number, number] = [0, 0];
  private emptyVao!: WebGLVertexArrayObject;
  private wind: WindTextures | null = null;
  private frame = 0;
  private lastTime = 0;
  private still = false;
  private plain = false;
  private awakeUntil = 0;

  /** How many particles the device can sustain, separate from how many look good. */
  private readonly budget: ParticleBudget;

  /**
   * @param capacity Most particles the GPU buffers can hold.
   * @param cssPixelsPerParticle Screen area per particle, which sets the visual density.
   */
  constructor(
    private readonly capacity: number,
    private readonly cssPixelsPerParticle: number,
  ) {
    this.budget = new ParticleBudget(capacity);
    this.stats.particles = capacity;
  }

  setWind(wind: WindTextures | null): void {
    this.wind = wind;
    this.wake();
  }

  /** Draw particles in plain white, so they don't compete with a colored layer beneath. */
  setPlain(plain: boolean): void {
    this.plain = plain;
    this.wake();
  }

  /** Hold a still picture of the wind instead of animating continuously. */
  setStill(still: boolean): void {
    this.still = still;
    this.wake();
  }

  /** Let particles move for a moment, to redraw the picture after a change. */
  wake(): void {
    this.awakeUntil = performance.now() + STILL_REDRAW_MS;
    this.map?.triggerRepaint();
  }

  private isResting(): boolean {
    return this.still && performance.now() > this.awakeUntil;
  }

  /** Copy a frame to the GPU. Half-float data is ready to upload without conversion. */
  createWindTexture(grid: FrameGrid, data: Uint16Array): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, grid.nx, grid.ny, 0, gl.RG, gl.HALF_FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // Only a global grid joins up across the antimeridian.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, isGlobal(grid) ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return texture;
  }

  createMaskTexture(grid: FrameGrid, mask: Uint8Array): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, grid.nx, grid.ny, 0, gl.RED, gl.UNSIGNED_BYTE, mask);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return texture;
  }

  deleteWindTexture(texture: WebGLTexture): void {
    this.gl.deleteTexture(texture);
  }

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error("WindDrift needs WebGL2");
    }
    this.map = map;
    this.gl = gl;
    this.simulate = createProgram(gl, SIMULATE_VERT, EMPTY_FRAG, ["v_state"]);
    this.particle = createProgram(gl, PARTICLE_VERT, PARTICLE_FRAG);
    this.fade = createProgram(gl, QUAD_VERT, FADE_FRAG);
    this.composite = createProgram(gl, QUAD_VERT, COMPOSITE_FRAG);
    this.states = [this.createState(), this.createState()];
    this.feedback = gl.createTransformFeedback()!;
    this.framebuffer = gl.createFramebuffer()!;
    this.emptyVao = gl.createVertexArray()!;
    gl.bindVertexArray(null);
  }

  onRemove(): void {
    const gl = this.gl;
    for (const program of [this.simulate, this.particle, this.fade, this.composite]) {
      gl.deleteProgram(program.handle);
    }
    for (const state of this.states) {
      gl.deleteBuffer(state.buffer);
      gl.deleteVertexArray(state.vao);
    }
    gl.deleteTransformFeedback(this.feedback);
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteVertexArray(this.emptyVao);
    this.trails?.forEach((texture) => gl.deleteTexture(texture));
  }

  prerender(gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    if (!this.wind || this.isResting()) return;
    const gl2 = gl as WebGL2RenderingContext;
    const now = performance.now();
    const elapsedMs = this.lastTime ? now - this.lastTime : 16;
    this.lastTime = now;
    this.adaptParticleCount(elapsedMs);
    // A stalled tab shouldn't make particles leap when it resumes.
    const seconds = Math.min(elapsedMs / 1000, 0.05);

    gl2.disable(gl2.DEPTH_TEST);
    gl2.disable(gl2.STENCIL_TEST);
    gl2.disable(gl2.CULL_FACE);
    gl2.disable(gl2.SCISSOR_TEST);

    this.ensureTrails(gl2);
    this.step(gl2, seconds, this.wind);
    this.drawTrails(gl2, seconds, args);

    gl2.bindVertexArray(null);
    gl2.bindFramebuffer(gl2.FRAMEBUFFER, null);
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (!this.wind || !this.trails) return;
    const gl2 = gl as WebGL2RenderingContext;
    gl2.disable(gl2.DEPTH_TEST);
    gl2.disable(gl2.STENCIL_TEST);
    gl2.enable(gl2.BLEND);
    gl2.blendFunc(gl2.ONE, gl2.ONE_MINUS_SRC_ALPHA);
    gl2.useProgram(this.composite.handle);
    gl2.activeTexture(gl2.TEXTURE0);
    gl2.bindTexture(gl2.TEXTURE_2D, this.trails[0]);
    gl2.uniform1i(this.composite.uniforms.u_trails, 0);
    gl2.bindVertexArray(this.emptyVao);
    gl2.drawArrays(gl2.TRIANGLES, 0, 3);
    gl2.bindVertexArray(null);
    if (!this.isResting()) this.map.triggerRepaint();
  }

  private createState(): StateBuffer {
    const gl = this.gl;
    // Zero life makes every particle respawn inside the view on the first step.
    const initial = new Float32Array(this.capacity * STATE_FLOATS);
    const buffer = gl.createBuffer()!;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, initial, gl.DYNAMIC_COPY);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, STATE_FLOATS, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return { vao, buffer };
  }

  private adaptParticleCount(elapsedMs: number): void {
    const canvas = this.map.getCanvas();
    const wanted = Math.floor((canvas.clientWidth * canvas.clientHeight) / this.cssPixelsPerParticle);
    this.stats.particles = this.budget.update(elapsedMs, wanted);
    this.stats.frameMs = this.budget.frameMs;
  }

  private step(gl: WebGL2RenderingContext, seconds: number, wind: WindTextures): void {
    const { handle, uniforms } = this.simulate;
    const { grid } = wind;
    const bounds = this.map.getBounds();
    const west = Math.max(bounds.getWest(), -180);
    const east = Math.min(bounds.getEast(), 180);
    const south = Math.max(bounds.getSouth(), -MAX_MERCATOR_LAT);
    const north = Math.min(bounds.getNorth(), MAX_MERCATOR_LAT);

    gl.useProgram(handle);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, wind.a);
    gl.uniform1i(uniforms.u_windA, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, wind.b);
    gl.uniform1i(uniforms.u_windB, 1);
    gl.uniform1f(uniforms.u_mix, wind.mix);
    gl.uniform4fv(uniforms.u_grid, gridUniform(grid));

    const { nest } = wind;
    gl.uniform1f(uniforms.u_nestWeight, nest ? nest.weight : 0);
    if (nest) {
      const textures: [string, WebGLTexture][] = [
        ["u_nestA", nest.a],
        ["u_nestB", nest.b],
        ["u_nestMask", nest.mask],
      ];
      textures.forEach(([name, texture], i) => {
        gl.activeTexture(gl.TEXTURE2 + i);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1i(uniforms[name], 2 + i);
      });
      gl.uniform1f(uniforms.u_nestMix, nest.mix);
      gl.uniform4fv(uniforms.u_nestGrid, gridUniform(nest.grid));
    }

    gl.uniform4f(uniforms.u_bounds, west, south, east, north);
    gl.uniform2f(uniforms.u_mercatorY, mercatorY(north), mercatorY(south));
    gl.uniform1f(
      uniforms.u_windSeconds,
      seconds * timeCompression(this.map.getZoom(), PIXELS_PER_SECOND_PER_MS),
    );
    gl.uniform1f(uniforms.u_realSeconds, seconds);
    gl.uniform1ui(uniforms.u_frame, ++this.frame);

    const [source, target] = this.states;
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.bindVertexArray(source.vao);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.feedback);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, target.buffer);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, this.stats.particles);
    gl.endTransformFeedback();
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    gl.disable(gl.RASTERIZER_DISCARD);
    gl.bindVertexArray(null);
    this.states = [target, source];
  }

  private drawTrails(gl: WebGL2RenderingContext, seconds: number, args: CustomRenderMethodInput): void {
    const [previous, current] = this.trails!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, current, 0);
    gl.viewport(0, 0, this.trailSize[0], this.trailSize[1]);
    gl.colorMask(true, true, true, true);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);

    // Old trails no longer line up once the camera moves, so drop them.
    if (!this.map.isMoving()) {
      gl.useProgram(this.fade.handle);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, previous);
      gl.uniform1i(this.fade.uniforms.u_trails, 0);
      gl.uniform1f(this.fade.uniforms.u_fade, Math.pow(0.965, seconds * 60));
      gl.bindVertexArray(this.emptyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.particle.handle);
    gl.uniformMatrix4fv(
      this.particle.uniforms.u_matrix,
      false,
      args.defaultProjectionData.mainMatrix as Float32Array,
    );
    gl.uniform1f(this.particle.uniforms.u_pointSize, 1.2 * window.devicePixelRatio);
    gl.uniform1f(this.particle.uniforms.u_plain, this.plain ? 1 : 0);
    gl.bindVertexArray(this.states[0].vao);
    gl.drawArrays(gl.POINTS, 0, this.stats.particles);

    this.trails = [current, previous];
  }

  private ensureTrails(gl: WebGL2RenderingContext): void {
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    if (this.trails && this.trailSize[0] === width && this.trailSize[1] === height) return;
    this.trails?.forEach((texture) => gl.deleteTexture(texture));
    this.trails = [createTrailTexture(gl, width, height), createTrailTexture(gl, width, height)];
    this.trailSize = [width, height];
  }
}

/** Texture placement as origin and span. Values sit at cell centres, half a cell inside the edge. */
function gridUniform(grid: FrameGrid): number[] {
  return [
    grid.lon0 - grid.dlon / 2,
    grid.lat0 - grid.dlat / 2,
    grid.nx * grid.dlon,
    grid.ny * grid.dlat,
  ];
}

function createTrailTexture(gl: WebGL2RenderingContext, width: number, height: number): WebGLTexture {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`Shader compile failed: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
  feedbackVaryings?: string[],
): Program {
  const handle = gl.createProgram()!;
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(handle, vertex);
  gl.attachShader(handle, fragment);
  if (feedbackVaryings) {
    gl.transformFeedbackVaryings(handle, feedbackVaryings, gl.INTERLEAVED_ATTRIBS);
  }
  gl.linkProgram(handle);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(handle, gl.LINK_STATUS)) {
    throw new Error(`Program link failed: ${gl.getProgramInfoLog(handle)}`);
  }
  const uniforms: Uniforms = {};
  const count = gl.getProgramParameter(handle, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < count; i++) {
    const name = gl.getActiveUniform(handle, i)!.name;
    uniforms[name] = gl.getUniformLocation(handle, name);
  }
  return { handle, uniforms };
}
