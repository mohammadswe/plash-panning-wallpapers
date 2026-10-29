/**
 * Per-instance SVG filter element living in a single shared <svg defs> appended
 * to <body>. Each glass element references its own filter by id via
 * backdrop-filter: url(#…).
 *
 * Chain (one GPU pass, fully composited by Chromium):
 *
 *   SourceGraphic --feGaussianBlur(edgeMode=duplicate)--> blurred
 *   feImage(displacement) --feDisplacementMap(blurred, scale=2*refraction)--> refracted
 *   refracted --feColorMatrix(saturate)--> saturated
 *   feImage(specular) --feComposite(in saturated)--> rimClipped
 *   feBlend(saturated, rimClipped, screen) --> final
 *
 * Optional chromatic-aberration variant runs three displacement passes with
 * slightly different scales per RGB channel and feBlends them additively
 * before the specular pass.
 */

let filterCounter = 0;

/**
 * One <svg><defs> per tree scope. A glass element inside a Shadow DOM (every
 * Chrome-extension content script) needs its filter in the SAME shadow root,
 * because `backdrop-filter: url(#id)` resolves the fragment against the
 * element's own tree scope — a filter in document.body is invisible to it.
 */
const defsByRoot = new WeakMap<Document | ShadowRoot, SVGDefsElement>();

function ensureDefs(root: Document | ShadowRoot): SVGDefsElement {
  const existing = defsByRoot.get(root);
  if (existing && existing.isConnected) return existing;

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.cssText =
    'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;';
  const defs = document.createElementNS(ns, 'defs');
  svg.appendChild(defs);

  // Append into the shadow root directly, or document.body for the main tree.
  const container: ParentNode =
    root.nodeType === 9 ? (root as Document).body ?? root : root;
  container.appendChild(svg);

  defsByRoot.set(root, defs);
  return defs;
}

export interface FilterParams {
  refraction: number;
  chromaticAberration: number;
  blur: number;
  saturation: number;
  width: number;
  height: number;
  displacementMapUrl: string;
  /** Padding (CSS px) baked into the displacement map's canvas, per side. */
  displacementPadding: number;
  specularMapUrl: string | null;
  /** Tree scope (document or shadow root) to inject the shared <svg defs> into. */
  root: Document | ShadowRoot;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export class FilterChain {
  readonly id: string;
  private readonly filter: SVGFilterElement;
  private readonly defs: SVGDefsElement;
  private readonly feImageDisp: SVGFEImageElement;
  private readonly feImageSpec: SVGFEImageElement | null;
  private readonly feBlur: SVGFEGaussianBlurElement;
  private readonly feDispR: SVGFEDisplacementMapElement | null;
  private readonly feDispG: SVGFEDisplacementMapElement;
  private readonly feDispB: SVGFEDisplacementMapElement | null;
  private readonly feSaturate: SVGFEColorMatrixElement;
  private readonly chromaticEnabled: boolean;

  constructor(initial: FilterParams) {
    this.defs = ensureDefs(initial.root);
    this.id = `lg-filter-${++filterCounter}`;
    // The 3-pass chromatic split triples the GPU displacement work, so only pay
    // for it when the fringe is actually visible. Below this a single pass is
    // used — a ~0.03 fringe is imperceptible anyway, so there's no quality loss.
    this.chromaticEnabled = initial.chromaticAberration > 0.12;

    this.filter = document.createElementNS(SVG_NS, 'filter');
    this.filter.setAttribute('id', this.id);
    // Filter region sized to match the displacement map's padding exactly.
    // Pads in CSS px on every side so the lens can sample beyond the element
    // box without clipping. Sized dynamically rather than a fixed % so small
    // and large elements both get just-right headroom.
    const padX = (initial.displacementPadding / initial.width) * 100;
    const padY = (initial.displacementPadding / initial.height) * 100;
    this.filter.setAttribute('x', `${-padX}%`);
    this.filter.setAttribute('y', `${-padY}%`);
    this.filter.setAttribute('width', `${100 + padX * 2}%`);
    this.filter.setAttribute('height', `${100 + padY * 2}%`);
    this.filter.setAttribute('filterUnits', 'objectBoundingBox');
    this.filter.setAttribute('primitiveUnits', 'userSpaceOnUse');
    this.filter.setAttribute('color-interpolation-filters', 'sRGB');

    // 1. Backdrop blur — edgeMode=duplicate stops viewport edges from being
    //    pulled in as transparent, which would wash floating glass to white.
    this.feBlur = document.createElementNS(SVG_NS, 'feGaussianBlur');
    this.feBlur.setAttribute('in', 'SourceGraphic');
    this.feBlur.setAttribute('stdDeviation', String(initial.blur));
    this.feBlur.setAttribute('edgeMode', 'duplicate');
    this.feBlur.setAttribute('result', 'blurred');
    this.filter.appendChild(this.feBlur);

    // 2. Displacement map image. The PNG is pre-padded by `displacementPadding`
    //    CSS px per side, so we place it at (-padding, -padding) with the
    //    padded total size — the encoded rim ends up exactly aligned with
    //    the element's edge.
    this.feImageDisp = document.createElementNS(SVG_NS, 'feImage');
    this.feImageDisp.setAttribute('href', initial.displacementMapUrl);
    this.feImageDisp.setAttribute('x', String(-initial.displacementPadding));
    this.feImageDisp.setAttribute('y', String(-initial.displacementPadding));
    this.feImageDisp.setAttribute(
      'width',
      String(initial.width + initial.displacementPadding * 2)
    );
    this.feImageDisp.setAttribute(
      'height',
      String(initial.height + initial.displacementPadding * 2)
    );
    this.feImageDisp.setAttribute('preserveAspectRatio', 'none');
    this.feImageDisp.setAttribute('result', 'dispMap');
    this.filter.appendChild(this.feImageDisp);

    if (this.chromaticEnabled) {
      const ab = initial.chromaticAberration;
      const baseScale = 2 * initial.refraction;

      const onlyR = matrix(SVG_NS, 'blurred', 'onlyR', [
        1, 0, 0, 0, 0,
        0, 0, 0, 0, 0,
        0, 0, 0, 0, 0,
        0, 0, 0, 1, 0,
      ]);
      const onlyG = matrix(SVG_NS, 'blurred', 'onlyG', [
        0, 0, 0, 0, 0,
        0, 1, 0, 0, 0,
        0, 0, 0, 0, 0,
        0, 0, 0, 1, 0,
      ]);
      const onlyB = matrix(SVG_NS, 'blurred', 'onlyB', [
        0, 0, 0, 0, 0,
        0, 0, 0, 0, 0,
        0, 0, 1, 0, 0,
        0, 0, 0, 1, 0,
      ]);
      this.filter.appendChild(onlyR);
      this.filter.appendChild(onlyG);
      this.filter.appendChild(onlyB);

      // Blue refracts more than red (shorter wavelength → higher index of
      // refraction). At ab=1 the R/B scales differ by ±35% from green; default
      // chromaticAberration around 0.4 puts the rim fringe in the visible
      // range without going prismatic.
      this.feDispR = disp(SVG_NS, 'onlyR', 'dispMap', baseScale * (1 - 0.35 * ab), 'dispR');
      this.feDispG = disp(SVG_NS, 'onlyG', 'dispMap', baseScale, 'dispG');
      this.feDispB = disp(SVG_NS, 'onlyB', 'dispMap', baseScale * (1 + 0.35 * ab), 'dispB');
      this.filter.appendChild(this.feDispR);
      this.filter.appendChild(this.feDispG);
      this.filter.appendChild(this.feDispB);

      const blendRG = blend(SVG_NS, 'dispR', 'dispG', 'screen', 'dispRG');
      const blendAll = blend(SVG_NS, 'dispRG', 'dispB', 'screen', 'distorted');
      this.filter.appendChild(blendRG);
      this.filter.appendChild(blendAll);
    } else {
      this.feDispR = null;
      this.feDispB = null;
      this.feDispG = disp(SVG_NS, 'blurred', 'dispMap', 2 * initial.refraction, 'distorted');
      this.filter.appendChild(this.feDispG);
    }

    this.feSaturate = document.createElementNS(SVG_NS, 'feColorMatrix');
    this.feSaturate.setAttribute('in', 'distorted');
    this.feSaturate.setAttribute('type', 'saturate');
    this.feSaturate.setAttribute('values', String(initial.saturation / 100));
    this.feSaturate.setAttribute('result', 'saturated');
    this.filter.appendChild(this.feSaturate);

    // Subtle brightness lift — Liquid Glass "concentrates light", reading a touch
    // brighter than a plain blur. Kept gentle so the backdrop stays true.
    const feBrightness = document.createElementNS(SVG_NS, 'feComponentTransfer');
    feBrightness.setAttribute('in', 'saturated');
    feBrightness.setAttribute('result', 'brightened');
    for (const ch of ['R', 'G', 'B'] as const) {
      const fn = document.createElementNS(SVG_NS, `feFunc${ch}`);
      fn.setAttribute('type', 'linear');
      fn.setAttribute('slope', '1.05'); // brightness(105%)
      fn.setAttribute('intercept', '0');
      feBrightness.appendChild(fn);
    }
    this.filter.appendChild(feBrightness);

    // 3. Optional baked specular rim — the environment light, screen-blended so
    //    the highlight only ever adds light along the lensing edge.
    if (initial.specularMapUrl) {
      this.feImageSpec = document.createElementNS(SVG_NS, 'feImage');
      this.feImageSpec.setAttribute('href', initial.specularMapUrl);
      this.feImageSpec.setAttribute('x', '0');
      this.feImageSpec.setAttribute('y', '0');
      this.feImageSpec.setAttribute('width', String(initial.width));
      this.feImageSpec.setAttribute('height', String(initial.height));
      this.feImageSpec.setAttribute('preserveAspectRatio', 'none');
      this.feImageSpec.setAttribute('result', 'specMap');
      this.filter.appendChild(this.feImageSpec);

      const blendSpec = blend(SVG_NS, 'brightened', 'specMap', 'screen', 'final');
      this.filter.appendChild(blendSpec);
    } else {
      this.feImageSpec = null;
    }

    this.defs.appendChild(this.filter);
  }

  get url(): string {
    return `url(#${this.id})`;
  }

  updateDisplacement(url: string, width: number, height: number, padding: number): void {
    this.feImageDisp.setAttribute('href', url);
    this.feImageDisp.setAttribute('x', String(-padding));
    this.feImageDisp.setAttribute('y', String(-padding));
    this.feImageDisp.setAttribute('width', String(width + padding * 2));
    this.feImageDisp.setAttribute('height', String(height + padding * 2));
    const padX = (padding / width) * 100;
    const padY = (padding / height) * 100;
    this.filter.setAttribute('x', `${-padX}%`);
    this.filter.setAttribute('y', `${-padY}%`);
    this.filter.setAttribute('width', `${100 + padX * 2}%`);
    this.filter.setAttribute('height', `${100 + padY * 2}%`);
  }

  updateSpecular(url: string | null, width: number, height: number): void {
    if (!this.feImageSpec || !url) return;
    this.feImageSpec.setAttribute('href', url);
    this.feImageSpec.setAttribute('width', String(width));
    this.feImageSpec.setAttribute('height', String(height));
  }

  updateRefraction(refraction: number): void {
    if (this.chromaticEnabled && this.feDispR && this.feDispB) {
      const base = 2 * refraction;
      // Match the ab math in the constructor — blue refracts more than red.
      this.feDispR.setAttribute('scale', String(base * 0.82));
      this.feDispG.setAttribute('scale', String(base));
      this.feDispB.setAttribute('scale', String(base * 1.18));
    } else {
      this.feDispG.setAttribute('scale', String(2 * refraction));
    }
  }

  updateBlur(blur: number): void {
    this.feBlur.setAttribute('stdDeviation', String(blur));
  }

  updateSaturation(saturation: number): void {
    this.feSaturate.setAttribute('values', String(saturation / 100));
  }

  destroy(): void {
    this.filter.remove();
  }
}

function disp(
  ns: string,
  inAttr: string,
  in2: string,
  scale: number,
  result: string
): SVGFEDisplacementMapElement {
  const el = document.createElementNS(ns, 'feDisplacementMap') as SVGFEDisplacementMapElement;
  el.setAttribute('in', inAttr);
  el.setAttribute('in2', in2);
  el.setAttribute('scale', String(scale));
  el.setAttribute('xChannelSelector', 'R');
  el.setAttribute('yChannelSelector', 'G');
  el.setAttribute('result', result);
  return el;
}

function matrix(ns: string, inAttr: string, result: string, values: number[]): SVGFEColorMatrixElement {
  const el = document.createElementNS(ns, 'feColorMatrix') as SVGFEColorMatrixElement;
  el.setAttribute('in', inAttr);
  el.setAttribute('type', 'matrix');
  el.setAttribute('values', values.join(' '));
  el.setAttribute('result', result);
  return el;
}

function blend(
  ns: string,
  inAttr: string,
  in2: string,
  mode: string,
  result: string
): SVGFEBlendElement {
  const el = document.createElementNS(ns, 'feBlend') as SVGFEBlendElement;
  el.setAttribute('in', inAttr);
  el.setAttribute('in2', in2);
  el.setAttribute('mode', mode);
  el.setAttribute('result', result);
  return el;
}
