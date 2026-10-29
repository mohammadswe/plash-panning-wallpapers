/**
 * Pixel rasterizers for displacement/specular maps. This module is intentionally
 * DOM-light so it can run either on the main thread or inside a Worker with
 * OffscreenCanvas.
 */

import { makeSurface } from './SurfaceField';
import { encodeCanvas } from './CanvasEncode';

export interface DisplacementMapParams {
  width: number;
  height: number;
  radius: number;
  thickness: number;
  pixelRatio: number;
  refraction: number;
}

export interface DisplacementMapResult {
  url: string;
  padding: number;
  totalWidth: number;
  totalHeight: number;
}

export interface SpecularMapParams {
  width: number;
  height: number;
  radius: number;
  thickness: number;
  pixelRatio: number;
  intensity: number;
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type Any2DContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Index of refraction of the glass body (air = 1.0). */
const GLASS_IOR = 1.5;
/** Lens depth at the reference thickness, as a fraction of the half short-side. */
const LENS_DEPTH_BASE = 1.95;
/** `thickness` (CSS px) that maps to the base depth; others scale linearly. */
const THICKNESS_REF = 30;
/**
 * Maps the refracted ray's normalised lateral component onto the encodable
 * +/-1 range so the steepest rim reaches the configured displacement.
 */
const RIM_GAIN = 1.7;

// Key light: straight from the top.
const LIGHT_X = 0;
const LIGHT_Y = -1;

const PRIMARY_EXP = 3;
const W_PRIMARY = 0.84;
const W_RIM = 0.18;
const GAIN = 255;

// Broad convex gloss over the upper surface.
const GLOSS_CX = 0;
const GLOSS_CY = -0.42;
const GLOSS_RADIUS = 1.42;
const GLOSS_EXP = 1.95;
const W_GLOSS = 0.4;

function context2d(canvas: AnyCanvas, options?: CanvasRenderingContext2DSettings): Any2DContext {
  const ctx = canvas.getContext('2d', options) as Any2DContext | null;
  if (!ctx) throw new Error('[liquid-glass] 2d canvas context unavailable');
  return ctx;
}

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

export function rasterizeDisplacementMap(
  params: DisplacementMapParams
): Promise<DisplacementMapResult> {
  // Anti-aliasing: at a low output pixel-ratio (e.g. 0.4 on mobile, or a
  // perf-reduced desktop), a hard-sampled map upscales into visible stair-steps
  // along the lensing edge. So we render at a higher internal resolution and
  // downscale with the browser's high-quality filter. The stored texture stays
  // small but remains cleanly anti-aliased.
  const outDpr = params.pixelRatio;
  const ss = outDpr < 0.9 ? 2 : 1;
  const dpr = outDpr * ss;
  const w = Math.max(1, Math.round(params.width * dpr));
  const h = Math.max(1, Math.round(params.height * dpr));
  const r = Math.max(0, Math.min(Math.min(w, h) / 2, params.radius * dpr));

  const paddingCss = Math.max(8, Math.ceil(params.refraction));
  const pad = Math.ceil(paddingCss * dpr);

  const totalW = w + pad * 2;
  const totalH = h + pad * 2;

  const canvas = makeCanvas(totalW, totalH);
  const ctx = context2d(canvas, { willReadFrequently: false });
  const img = ctx.createImageData(totalW, totalH);
  const data = img.data;

  const halfMin = Math.min(w, h) / 2;
  const thicknessScale = Math.max(0.3, Math.min(1.6, params.thickness / THICKNESS_REF));
  const lensDepth = halfMin * LENS_DEPTH_BASE * thicknessScale;
  const surf = makeSurface({
    cx: pad + w / 2,
    cy: pad + h / 2,
    halfW: w / 2,
    halfH: h / 2,
    r,
    lensDepth,
  });

  // Snell's law, air -> glass. Straight-down viewing ray I = (0, 0, -1).
  const eta = 1 / GLASS_IOR;

  for (let y = 0; y < totalH; y++) {
    const rowBase = y * totalW * 4;
    const py = y + 0.5;

    for (let x = 0; x < totalW; x++) {
      const px = x + 0.5;
      const i = rowBase + x * 4;

      if (surf.sdf(px, py) <= 0) {
        data[i] = 128;
        data[i + 1] = 128;
        data[i + 2] = 128;
        data[i + 3] = 255;
        continue;
      }

      const { nx, ny, nz } = surf.lensNormal(px, py);
      const dot = -nz;
      const k = 1 - eta * eta * (1 - dot * dot);

      let fx = 0;
      let fy = 0;
      if (k >= 0) {
        const c = eta * dot + Math.sqrt(k);
        fx = -c * nx * RIM_GAIN;
        fy = -c * ny * RIM_GAIN;
      }

      data[i] = Math.max(1, Math.min(255, Math.round(128 + fx * 127)));
      data[i + 1] = Math.max(1, Math.min(255, Math.round(128 + fy * 127)));
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);

  const urlPromise =
    ss > 1 ? downscaleAndEncode(canvas, totalW, totalH, ss) : encodeCanvas(canvas);

  return urlPromise.then((url) => ({
    url,
    padding: paddingCss,
    totalWidth: totalW / dpr,
    totalHeight: totalH / dpr,
  }));
}

export async function rasterizeSpecularMap(params: SpecularMapParams): Promise<string> {
  const outDpr = params.pixelRatio;
  const ss = outDpr < 1.1 ? 2 : 1;
  const dpr = outDpr * ss;
  const w = Math.max(2, Math.round(params.width * dpr));
  const h = Math.max(2, Math.round(params.height * dpr));
  const r = Math.max(0, Math.min(Math.min(w, h) / 2, params.radius * dpr));
  const intensity = Math.max(0, params.intensity);

  const canvas = makeCanvas(w, h);
  const ctx = context2d(canvas);
  const imgData = ctx.createImageData(w, h);
  const data = imgData.data;

  const lineW = Math.min(3.6 * dpr, Math.max(2, r * 0.64));
  const surf = makeSurface({ cx: w / 2, cy: h / 2, halfW: w / 2, halfH: h / 2, r });

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5;
      const py = y + 0.5;

      const d = surf.sdf(px, py);
      if (d <= 0) continue;

      let s = 0;

      const u = (px - w / 2) / (w / 2);
      const v = (py - h / 2) / (h / 2);
      const gdx = u - GLOSS_CX;
      const gdy = v - GLOSS_CY;
      const gloss = Math.max(0, 1 - Math.sqrt(gdx * gdx + gdy * gdy) / GLOSS_RADIUS);
      if (gloss > 0) s += Math.pow(gloss, GLOSS_EXP) * W_GLOSS;

      if (d < lineW) {
        const eps = 0.75;
        const gx = (surf.sdf(px + eps, py) - surf.sdf(px - eps, py)) / (2 * eps);
        const gy = (surf.sdf(px, py + eps) - surf.sdf(px, py - eps)) / (2 * eps);
        const gl = Math.sqrt(gx * gx + gy * gy) || 1;
        const facing = (-gx / gl) * LIGHT_X + (-gy / gl) * LIGHT_Y;
        const t = 1 - d / lineW;
        const fade = t * t;
        const primary = facing > 0 ? Math.pow(facing, PRIMARY_EXP) : 0;
        s += (W_PRIMARY * primary + W_RIM) * fade;
      }

      const a = Math.min(255, s * intensity * GAIN);
      if (a <= 0) continue;
      const idx = (y * w + x) * 4;
      data[idx] = 255;
      data[idx + 1] = 255;
      data[idx + 2] = 255;
      data[idx + 3] = a;
    }
  }

  ctx.putImageData(imgData, 0, 0);

  if (ss > 1) {
    return downscaleAndEncode(canvas, w, h, ss);
  }
  return encodeCanvas(canvas);
}

function downscaleAndEncode(
  src: AnyCanvas,
  srcW: number,
  srcH: number,
  ss: number
): Promise<string> {
  const dstW = Math.max(1, Math.round(srcW / ss));
  const dstH = Math.max(1, Math.round(srcH / ss));
  const tmp = makeCanvas(dstW, dstH);
  const ctx = context2d(tmp, { willReadFrequently: true });
  ctx.clearRect(0, 0, dstW, dstH);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src as CanvasImageSource, 0, 0, srcW, srcH, 0, 0, dstW, dstH);
  return encodeCanvas(tmp);
}
