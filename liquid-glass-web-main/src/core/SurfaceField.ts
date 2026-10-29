/**
 * Shared glass surface field — the geometry the refraction and the light maps
 * are derived from.
 *
 * Apple's Liquid Glass bends light through a transparent body — "letting content
 * shine through underneath it", concentrating the bend toward the edges (Meet
 * Liquid Glass, WWDC25).
 *
 * Crucially, we do NOT bend in a *band* near the edge and leave the centre flat:
 * a band has an inner boundary, and that boundary reads as a rounded rectangle
 * floating inside the glass. Instead the whole surface is **one smooth lens**
 * whose displacement increases *monotonically* from zero at the exact centre to
 * its maximum at the edge. Monotonic ⇒ there is no ring, no inner edge — nowhere
 * the bend "stops". The profile is shaped (exponent K) so the middle stays
 * nearly flat (clear body) and the bend ramps up only near the rim, but it never
 * drops back to zero between centre and edge, so no contour is ever drawn.
 *
 * The field is built from `(1 − u²)(1 − v²)` in normalised box coordinates — C∞
 * everywhere, so there is no medial-axis crease on any shape either.
 */

export interface SurfaceParams {
  /** Centre of the element box, in device px (may be offset by padding). */
  cx: number;
  cy: number;
  /** Half extents of the element box, in device px. */
  halfW: number;
  halfH: number;
  /** Corner radius, in device px (used by the SDF mask / specular edge). */
  r: number;
  /**
   * Lens depth in device px — how "thick" the glass is. Deeper ⇒ steeper edge
   * normals ⇒ more pronounced lensing, matching Apple's "thicker material has
   * more pronounced lensing and refraction" (only `lensNormal` uses it; the
   * specular map can pass 0). Default 0 keeps the surface flat.
   */
  lensDepth?: number;
}

/** Cap the in-plane lens slope so the very edge can't fold the backdrop.
 * Higher ⇒ steeper, thicker-looking glass edges (more apparent volume). */
const GRAD_CLAMP = 8.5;
/** Edge concentration: lower values let the whole body behave more like a
 * convex lens; higher values push the bend into a quiet rim-only treatment. */
const LENS_K = 1.15;

export interface SurfaceField {
  /** Signed distance inside from the nearest edge, in device px (0 outside). */
  sdf(px: number, py: number): number;
  /** Unit normal of the smooth monotonic lens — used for refraction. */
  lensNormal(px: number, py: number): { nx: number; ny: number; nz: number };
}

export function makeSurface(p: SurfaceParams): SurfaceField {
  const { cx, cy, halfW, halfH, r } = p;
  const innerW = Math.max(0, halfW - r);
  const innerH = Math.max(0, halfH - r);
  const depth = p.lensDepth ?? 0;

  // Exact rounded-rect SDF — masks the exterior and places the specular edge.
  function sdf(px: number, py: number): number {
    const adx = Math.abs(px - cx);
    const ady = Math.abs(py - cy);
    const distX = halfW - adx;
    const distY = halfH - ady;
    if (distX <= 0 || distY <= 0) return 0;

    const qx = adx - innerW;
    const qy = ady - innerH;
    if (qx > 0 && qy > 0) {
      const d = Math.sqrt(qx * qx + qy * qy);
      return d > r ? 0 : r - d;
    }
    return Math.min(distX, distY);
  }

  // Smooth lens height: peak at the centre, 0 at the box edge. With e = edgeness
  // (0 centre → 1 edge), height = depth·(1 − eᴷ). Its slope rises monotonically
  // from the centre to the edge — no bump, so no inner ring.
  function lensHeight(px: number, py: number): number {
    let u = (px - cx) / halfW;
    let v = (py - cy) / halfH;
    if (u < -1) u = -1;
    else if (u > 1) u = 1;
    if (v < -1) v = -1;
    else if (v > 1) v = 1;
    const base = (1 - u * u) * (1 - v * v); // 1 centre → 0 edge
    const e = 1 - base; // 0 centre → 1 edge
    return depth * (1 - Math.pow(e, LENS_K));
  }

  function lensNormal(px: number, py: number): { nx: number; ny: number; nz: number } {
    const eps = 0.5;
    let gx = (lensHeight(px + eps, py) - lensHeight(px - eps, py)) / (2 * eps);
    let gy = (lensHeight(px, py + eps) - lensHeight(px, py - eps)) / (2 * eps);
    const gl = Math.sqrt(gx * gx + gy * gy);
    if (gl > GRAD_CLAMP) {
      const s = GRAD_CLAMP / gl;
      gx *= s;
      gy *= s;
    }
    const len = Math.sqrt(gx * gx + gy * gy + 1);
    return { nx: -gx / len, ny: -gy / len, nz: 1 / len };
  }

  return { sdf, lensNormal };
}
