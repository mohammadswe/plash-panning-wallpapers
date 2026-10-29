/**
 * WebGLRefractor — one shared full-viewport WebGL canvas that refracts a scene
 * for every glass box, identically on Chrome, Safari and Firefox.
 *
 * The point: Chrome's Liquid Glass is two parts — (1) the SVG filter MATH
 * (blur → displacement → chromatic → specular) and (2) compositor access to the
 * backdrop. (1) is portable GPU math; (2) is locked to the browser. So we run
 * the SAME math here (sampling the SAME displacement map Chrome bakes, uploaded
 * as a texture) against a scene we CAN read (a <canvas>/<img>/<video>). Run it
 * on every browser and the output is identical cross-engine.
 *
 * Performance (this is the rewrite that fixes the janky v1):
 *   • ONE fixed full-viewport canvas, ONE render pass per frame — every box is a
 *     quad positioned in the viewport by the vertex shader. No per-element
 *     canvas, no drawImage/readback blit, no preserveDrawingBuffer.
 *   • Per-box maps + uniforms are cached; a frame only re-reads rects and
 *     updates the scene-sample offset. Off-screen boxes are culled.
 *   • Scroll/resize just request one render — rects are read once per rAF, never
 *     written, so there is no layout thrashing.
 *
 * Layering: the canvas sits between the scene (behind) and the glass elements
 * (in front, transparent windows whose text/shadow/rim stay CSS). The glass
 * element keeps everything except the backdrop, which this draws.
 */

import { isLiquidGlassAndroid, isLiquidGlassMobileLike } from './DeviceProfile';

export interface RefractorBoxParams {
  displacementMapUrl: string;
  displacementPadding: number;
  specularMapUrl: string | null;
  refraction: number; // px
  blur: number; // px
  chromaticAberration: number; // 0..1
  saturation: number; // %
  radius: number; // px (rounded-rect mask)
  tint: [number, number, number, number]; // rgba 0..1
}

interface BoxEntry {
  el: HTMLElement;
  getParams: () => Promise<RefractorBoxParams>;
  cached: RefractorBoxParams | null;
  dispTex: WebGLTexture | null;
  specTex: WebGLTexture | null;
  dispUrl: string;
  specUrl: string | null;
  refreshId: number;
}

const VERT = `#version 300 es
in vec2 a_pos;                 // 0..1 over the box
uniform vec2 u_viewport;       // CSS px
uniform vec2 u_box_origin;     // box top-left, CSS px (viewport coords)
uniform vec2 u_box_size;       // CSS px
out vec2 v_uv;
void main() {
  v_uv = a_pos;
  vec2 px = u_box_origin + a_pos * u_box_size;     // viewport px
  vec2 ndc = (px / u_viewport) * 2.0 - 1.0;
  ndc.y = -ndc.y;                                   // screen → clip space
  gl_Position = vec4(ndc, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_scene;
uniform sampler2D u_disp;
uniform sampler2D u_spec;
uniform bool  u_hasSpec;
uniform vec2  u_scene_px;
uniform vec2  u_box_origin;
uniform vec2  u_box_size;
uniform float u_pad;
uniform float u_refraction;
uniform float u_blur;
uniform float u_chroma;
uniform float u_sat;
uniform float u_radius;
uniform vec4  u_tint;

vec3 sat(vec3 c, float s) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return mix(vec3(l), c, s);
}

// Signed coverage of a rounded rect, ~1px antialiased edge.
float roundedMask(vec2 p, vec2 half_, float r) {
  vec2 q = abs(p) - (half_ - r);
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  return clamp(0.5 - d, 0.0, 1.0);
}

void main() {
  vec2 half_ = u_box_size * 0.5;
  vec2 p = (v_uv - 0.5) * u_box_size;
  float cover = roundedMask(p, half_, min(u_radius, min(half_.x, half_.y)));
  if (cover < 0.003) { outColor = vec4(0.0); return; }

  // Map box-uv → padded displacement-map uv, decode the encoded shift.
  vec2 padFrac = u_pad / (u_box_size + 2.0 * u_pad);
  vec2 dispUv = mix(padFrac, 1.0 - padFrac, v_uv);
  vec2 shift = (texture(u_disp, dispUv).rg - 0.5078431) * 2.0;
  vec2 shiftPx = shift * u_refraction;

  vec2 sceneUv = (u_box_origin + v_uv * u_box_size + shiftPx) / u_scene_px;
  vec2 ca = shiftPx * u_chroma * 0.6 / u_scene_px;
  vec2 b = vec2(u_blur) / u_scene_px;

  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = -2; i <= 2; i++) {
    float w = 1.0 - abs(float(i)) * 0.28;
    vec2 o = vec2(float(i)) * b * 0.6;
    acc.r += texture(u_scene, sceneUv + ca + o).r * w;
    acc.g += texture(u_scene, sceneUv + o).g * w;
    acc.b += texture(u_scene, sceneUv - ca + o).b * w;
    wsum += w;
  }
  vec3 col = acc / wsum;
  col = sat(col, u_sat) * 1.05;
  col = mix(col, u_tint.rgb, u_tint.a);             // glass tint

  if (u_hasSpec) {
    vec4 s = texture(u_spec, v_uv);
    col = 1.0 - (1.0 - col) * (1.0 - s.rgb * s.a);  // screen-blend rim
  }
  outColor = vec4(col * cover, cover);              // premultiplied
}`;

let singleton: WebGLRefractor | null = null;
let triedInit = false;
const WEBGL_VIEWPORT_DPR_CAP = isLiquidGlassAndroid()
  ? 1
  : isLiquidGlassMobileLike()
    ? 1.25
    : 2;

export function getWebGLRefractor(): WebGLRefractor | null {
  if (!triedInit) {
    triedInit = true;
    const r = new WebGLRefractor();
    singleton = r.usable ? r : null;
  }
  return singleton;
}

export class WebGLRefractor {
  usable = false;
  private gl: WebGL2RenderingContext | null = null;
  readonly canvas: HTMLCanvasElement;
  private program: WebGLProgram | null = null;
  private uloc: Record<string, WebGLUniformLocation | null> = {};
  private sceneTex: WebGLTexture | null = null;
  private scenePx: [number, number] = [1, 1];
  private boxes = new Set<BoxEntry>();
  private rafPending = false;
  private boundScene: HTMLElement | null = null;

  constructor(zIndex = -1) {
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.style.cssText =
      `position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:${zIndex};`;
    try {
      const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false });
      if (!gl) return;
      this.gl = gl;
      if (!this.initProgram()) return;
      this.usable = true;
      window.addEventListener('scroll', this.requestRender, { passive: true, capture: true });
      window.addEventListener('resize', this.onResize, { passive: true });
    } catch {
      /* no WebGL2 → caller falls back */
    }
  }

  private initProgram(): boolean {
    const gl = this.gl!;
    const vs = this.compile(gl.VERTEX_SHADER, VERT);
    const fs = this.compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return false;
    const p = gl.createProgram()!;
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.warn('[liquid-glass] WebGL link error:', gl.getProgramInfoLog(p));
      return false;
    }
    this.program = p;
    gl.useProgram(p);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(p, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const n of [
      'u_scene', 'u_disp', 'u_spec', 'u_hasSpec', 'u_scene_px', 'u_box_origin',
      'u_box_size', 'u_pad', 'u_refraction', 'u_blur', 'u_chroma', 'u_sat',
      'u_radius', 'u_tint', 'u_viewport',
    ]) {
      this.uloc[n] = gl.getUniformLocation(p, n);
    }
    return true;
  }

  private compile(type: number, src: string): WebGLShader | null {
    const gl = this.gl!;
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn('[liquid-glass] WebGL shader error:', gl.getShaderInfoLog(sh));
      return null;
    }
    return sh;
  }

  private static sceneSource(el: HTMLElement): TexImageSource | null {
    if (el instanceof HTMLCanvasElement && el.width && el.height) return el;
    if (el instanceof HTMLImageElement && el.complete && el.naturalWidth) return el;
    if (el instanceof HTMLVideoElement && el.readyState >= 2) return el;
    return null;
  }

  /** Register a glass box against the shared scene. Returns null (→ caller uses
   * the CSS fallback) if the scene isn't uploadable or differs from the bound
   * one. The refractor's `canvas` must be in the DOM (the caller appends it). */
  register(el: HTMLElement, scene: HTMLElement, getParams: () => Promise<RefractorBoxParams>): { destroy: () => void; refresh: () => void } | null {
    if (!this.usable) return null;
    if (!this.boundScene) {
      if (!WebGLRefractor.sceneSource(scene)) return null;
      this.boundScene = scene;
      this.recaptureScene();
    } else if (this.boundScene !== scene) {
      return null;
    }
    const entry: BoxEntry = { el, getParams, cached: null, dispTex: null, specTex: null, dispUrl: '', specUrl: null, refreshId: 0 };
    this.boxes.add(entry);
    void this.refresh(entry).catch(() => {
      this.boxes.delete(entry);
    });
    return {
      refresh: () => {
        void this.refresh(entry).catch(() => {
          this.requestRender();
        });
      },
      destroy: () => {
        this.boxes.delete(entry);
        const gl = this.gl;
        if (gl) {
          if (entry.dispTex) gl.deleteTexture(entry.dispTex);
          if (entry.specTex) gl.deleteTexture(entry.specTex);
        }
        this.requestRender();
      },
    };
  }

  /** Recompute a box's cached params + (re)load its map textures. Cheap; called
   * on register and when size/options change — NOT per frame. */
  private async refresh(entry: BoxEntry): Promise<void> {
    const refreshId = ++entry.refreshId;
    const p = await entry.getParams();
    if (!this.boxes.has(entry) || refreshId !== entry.refreshId) return;
    entry.cached = p;
    if (p.displacementMapUrl !== entry.dispUrl) {
      entry.dispUrl = p.displacementMapUrl;
      this.uploadFromUrl(p.displacementMapUrl, (t) => { entry.dispTex = t; this.requestRender(); });
    }
    if (p.specularMapUrl !== entry.specUrl) {
      entry.specUrl = p.specularMapUrl;
      if (p.specularMapUrl) this.uploadFromUrl(p.specularMapUrl, (t) => { entry.specTex = t; this.requestRender(); });
      else entry.specTex = null;
    }
    this.requestRender();
  }

  recaptureScene(): void {
    if (!this.gl || !this.boundScene) return;
    const src = WebGLRefractor.sceneSource(this.boundScene);
    if (!src) return;
    const r = this.boundScene.getBoundingClientRect();
    this.scenePx = [Math.max(1, r.width || window.innerWidth), Math.max(1, r.height || window.innerHeight)];
    this.sceneTex = this.uploadImage(src, this.sceneTex);
    this.requestRender();
  }

  /** Refresh the texture after the app repaints the scene (e.g. animated bg). */
  refreshScene(): void { this.recaptureScene(); }

  private uploadImage(src: TexImageSource, reuse: WebGLTexture | null): WebGLTexture | null {
    const gl = this.gl!;
    const tex = reuse ?? gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private uploadFromUrl(url: string, onReady: (t: WebGLTexture | null) => void): void {
    const img = new Image();
    img.onload = () => onReady(this.uploadImage(img, null));
    img.onerror = () => onReady(null);
    img.src = url;
  }

  private onResize = (): void => {
    this.recaptureScene();
    this.requestRender();
  };

  requestRender = (): void => {
    if (this.rafPending || !this.usable) return;
    this.rafPending = true;
    requestAnimationFrame(() => { this.rafPending = false; this.render(); });
  };

  private render(): void {
    const gl = this.gl;
    if (!gl || !this.program || !this.sceneTex) return;
    const dpr = Math.min(WEBGL_VIEWPORT_DPR_CAP, window.devicePixelRatio || 1);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cw = Math.round(vw * dpr);
    const ch = Math.round(vh * dpr);
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }

    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    gl.uniform1i(this.uloc.u_scene, 0);
    gl.uniform2f(this.uloc.u_scene_px, this.scenePx[0], this.scenePx[1]);
    gl.uniform2f(this.uloc.u_viewport, vw, vh);

    for (const e of this.boxes) {
      if (!e.dispTex || !e.cached) continue;
      const r = e.el.getBoundingClientRect();
      // Cull fully off-screen boxes.
      if (r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh || r.width < 1 || r.height < 1) continue;
      const p = e.cached;

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, e.dispTex);
      gl.uniform1i(this.uloc.u_disp, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, e.specTex ?? e.dispTex);
      gl.uniform1i(this.uloc.u_spec, 2);
      gl.uniform1i(this.uloc.u_hasSpec, e.specTex ? 1 : 0);

      gl.uniform2f(this.uloc.u_box_origin, r.left, r.top);
      gl.uniform2f(this.uloc.u_box_size, r.width, r.height);
      gl.uniform1f(this.uloc.u_pad, p.displacementPadding);
      gl.uniform1f(this.uloc.u_refraction, p.refraction);
      gl.uniform1f(this.uloc.u_blur, p.blur);
      gl.uniform1f(this.uloc.u_chroma, p.chromaticAberration);
      gl.uniform1f(this.uloc.u_sat, p.saturation / 100);
      gl.uniform1f(this.uloc.u_radius, p.radius);
      gl.uniform4f(this.uloc.u_tint, p.tint[0], p.tint[1], p.tint[2], p.tint[3]);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }
}
