/**
 * SceneOpticalLens — Apple-style Liquid Glass optical refraction engine.
 *
 * Implements real physical Snell's law refraction, 3-pass chromatic aberration,
 * and specular rim highlight for glass panels positioned over a live scene
 * (e.g. animated wallpaper, video, or canvas).
 *
 * Runs fully hardware-accelerated on all browser engines (WebKit, Safari, WKWebView,
 * Chromium, Firefox) with zero CORS or tainted-canvas security restrictions.
 */

export interface SceneOpticalLensOptions {
  refraction?: number; // displacement in px (default 36)
  chromaticAberration?: number; // 0..1 RGB channel separation (default 0.6)
  thickness?: number; // rim bevel height in px (default 22)
  blur?: number; // backdrop blur in px (default 0)
  saturation?: number; // saturation in % (default 100)
  specular?: boolean; // bake specular highlight (default true)
  specularIntensity?: number; // 0..1 (default 0.65)
  tint?: string | null; // glass tint overlay
  profile?: string;
  preset?: string;
  rimPosition?: 'top' | 'bottom'; // default 'top' (flipped 180 degrees)
}

function drawImageSafe(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number
): void {
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  if (nw <= 0 || nh <= 0) return;

  // Completely out of bounds
  if (sx >= nw || sy >= nh || sx + sw <= 0 || sy + sh <= 0) return;

  // Clip left
  if (sx < 0) {
    const diff = -sx;
    const ratio = diff / sw;
    dx += dw * ratio;
    dw -= dw * ratio;
    sw -= diff;
    sx = 0;
  }
  // Clip top
  if (sy < 0) {
    const diff = -sy;
    const ratio = diff / sh;
    dy += dh * ratio;
    dh -= dh * ratio;
    sh -= diff;
    sy = 0;
  }
  // Clip right
  if (sx + sw > nw) {
    const diff = (sx + sw) - nw;
    const ratio = diff / sw;
    dw -= dw * ratio;
    sw = nw - sx;
  }
  // Clip bottom
  if (sy + sh > nh) {
    const diff = (sy + sh) - nh;
    const ratio = diff / sh;
    dh -= dh * ratio;
    sh = nh - sy;
  }

  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return;
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
}

export class SceneOpticalLens {
  private element: HTMLElement;
  private sceneEl: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  readonly refractCanvas: HTMLCanvasElement;
  private refractCtx: CanvasRenderingContext2D;
  private buf: HTMLCanvasElement;
  private bufCtx: CanvasRenderingContext2D;
  private acc: HTMLCanvasElement;
  private accCtx: CanvasRenderingContext2D;
  private rafId = 0;
  private destroyed = false;
  private suspended = false;
  private options: Required<SceneOpticalLensOptions>;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private pad = 0;
  private lastRenderTime = 0;

  constructor(
    element: HTMLElement,
    scene: HTMLElement,
    options: SceneOpticalLensOptions = {}
  ) {
    this.element = element;
    this.sceneEl = scene;
    this.options = {
      refraction: options.refraction ?? 36,
      chromaticAberration: options.chromaticAberration ?? 0.6,
      thickness: options.thickness ?? 22,
      blur: options.blur ?? 0,
      saturation: options.saturation ?? 100,
      specular: options.specular ?? true,
      specularIntensity: options.specularIntensity ?? 0.65,
      tint: options.tint ?? 'rgba(20, 20, 20, 0.32)',
      profile: options.profile ?? 'bar',
      preset: options.preset ?? 'dramatic',
      rimPosition: options.rimPosition ?? 'top',
    };

    // Ensure parent element clips bleed padding from the blurred refract canvas
    const compOverflow = window.getComputedStyle(this.element).overflow;
    if (compOverflow === 'visible') {
      this.element.style.overflow = 'hidden';
    }

    // 1. Refraction layer (underneath, receives hardware-accelerated CSS blur & saturation)
    this.refractCanvas = document.createElement('canvas');
    this.refractCanvas.className = 'liquid-glass-refract-canvas';
    this.refractCanvas.setAttribute('aria-hidden', 'true');
    this.refractCanvas.style.cssText =
      'position:absolute;pointer-events:none;z-index:1;will-change:transform;';
    this.element.appendChild(this.refractCanvas);
    this.refractCtx = this.refractCanvas.getContext('2d', { alpha: true })!;

    // 2. Overlay layer (crisp specular rim highlight and tint, zero CSS blur)
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'liquid-glass-lens-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2;';
    this.element.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d', { alpha: true })!;

    this.buf = document.createElement('canvas');
    this.bufCtx = this.buf.getContext('2d', { alpha: true })!;

    this.acc = document.createElement('canvas');
    this.accCtx = this.acc.getContext('2d', { alpha: true })!;

    this.updateFilter();
    this.resize();
    window.addEventListener('resize', this.onResize, { passive: true });
    this.startLoop();
  }

  private onResize = (): void => {
    this.resize();
  };

  private updateFilter(): void {
    const effectiveBlur = Math.min(Math.max(0, this.options.blur), 60);
    const filters: string[] = [];
    if (effectiveBlur > 0) {
      filters.push(`blur(${effectiveBlur}px)`);
    }
    if (this.options.saturation !== undefined && this.options.saturation !== 100) {
      filters.push(`saturate(${this.options.saturation}%)`);
    }
    const filterStr = filters.length > 0 ? filters.join(' ') : 'none';
    if (this.refractCanvas.style.filter !== filterStr) {
      this.refractCanvas.style.filter = filterStr;
      this.refractCanvas.style.webkitFilter = filterStr;
    }
  }

  resize(): void {
    if (this.destroyed) return;
    this.dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.w = this.element.offsetWidth;
    this.h = this.element.offsetHeight;
    if (this.w <= 0 || this.h <= 0) return;

    const effectiveBlur = Math.min(Math.max(0, this.options.blur), 60);
    // Bleed padding ensures CSS blur does not vignette or fade at the navbar bounds
    this.pad = effectiveBlur > 0 ? Math.max(16, Math.ceil(effectiveBlur * 1.5)) : 0;

    const cw = Math.round(this.w * this.dpr);
    const ch = Math.round(this.h * this.dpr);

    const rw = Math.round((this.w + this.pad * 2) * this.dpr);
    const rh = Math.round((this.h + this.pad * 2) * this.dpr);

    // Position refractCanvas with bleed offset
    this.refractCanvas.style.left = `-${this.pad}px`;
    this.refractCanvas.style.top = `-${this.pad}px`;
    this.refractCanvas.style.width = `${this.w + this.pad * 2}px`;
    this.refractCanvas.style.height = `${this.h + this.pad * 2}px`;

    if (this.refractCanvas.width !== rw || this.refractCanvas.height !== rh) {
      this.refractCanvas.width = rw;
      this.refractCanvas.height = rh;
      this.buf.width = rw;
      this.buf.height = rh;
      this.acc.width = rw;
      this.acc.height = rh;
    }

    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
  }

  update(partial: SceneOpticalLensOptions): void {
    let filterChanged = false;
    let sizeChanged = false;

    if (partial.refraction !== undefined) this.options.refraction = partial.refraction;
    if (partial.chromaticAberration !== undefined) this.options.chromaticAberration = partial.chromaticAberration;
    if (partial.thickness !== undefined) this.options.thickness = partial.thickness;
    if (partial.blur !== undefined && partial.blur !== this.options.blur) {
      this.options.blur = partial.blur;
      filterChanged = true;
      sizeChanged = true;
    }
    if (partial.saturation !== undefined && partial.saturation !== this.options.saturation) {
      this.options.saturation = partial.saturation;
      filterChanged = true;
    }
    if (partial.specular !== undefined) this.options.specular = partial.specular;
    if (partial.specularIntensity !== undefined) this.options.specularIntensity = partial.specularIntensity;
    if (partial.tint !== undefined) this.options.tint = partial.tint;
    if (partial.profile !== undefined) this.options.profile = partial.profile;
    if (partial.preset !== undefined) this.options.preset = partial.preset;
    if (partial.rimPosition !== undefined) this.options.rimPosition = partial.rimPosition;

    if (filterChanged) {
      this.updateFilter();
    }
    if (sizeChanged) {
      this.resize();
    }
  }

  suspend(): void {
    this.suspended = true;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  resume(): void {
    if (!this.suspended || this.destroyed) return;
    this.suspended = false;
    this.startLoop();
  }

  private getActiveLayers(): Array<{
    img: HTMLImageElement;
    opacity: number;
    scale: number;
    imgX: number;
    imgY: number;
  }> {
    if (!this.sceneEl) return [];

    const imgs = this.sceneEl.querySelectorAll<HTMLImageElement>('.layer, img');
    const layers: Array<{
      img: HTMLImageElement;
      opacity: number;
      scale: number;
      imgX: number;
      imgY: number;
    }> = [];

    const candidates = imgs.length > 0
      ? Array.from(imgs)
      : (this.sceneEl instanceof HTMLImageElement ? [this.sceneEl] : []);

    for (const img of candidates) {
      if (!img.complete || !img.naturalWidth || !img.naturalHeight) continue;

      let opacity = 1;
      const comp = window.getComputedStyle(img);
      const parsed = parseFloat(comp.opacity);
      if (!isNaN(parsed)) opacity = parsed;

      if (opacity <= 0.005) continue;

      const rect = img.getBoundingClientRect();
      const nw = img.naturalWidth;
      const nh = img.naturalHeight;

      let scale = rect.width / nw;
      let imgX = rect.left;
      let imgY = rect.top;

      // Handle object-fit: cover / contain (accurately accounts for aspect ratio & centering)
      if (comp.objectFit === 'cover' || comp.objectFit === 'contain') {
        const isCover = comp.objectFit === 'cover';
        scale = isCover
          ? Math.max(rect.width / nw, rect.height / nh)
          : Math.min(rect.width / nw, rect.height / nh);
        const renderW = nw * scale;
        const renderH = nh * scale;

        let posX = 0.5;
        let posY = 0.5;
        const posParts = comp.objectPosition ? comp.objectPosition.split(' ') : [];
        if (posParts.length >= 2) {
          if (posParts[0].endsWith('%')) posX = parseFloat(posParts[0]) / 100;
          if (posParts[1].endsWith('%')) posY = parseFloat(posParts[1]) / 100;
        }

        imgX = rect.left + (rect.width - renderW) * posX;
        imgY = rect.top + (rect.height - renderH) * posY;
      }

      layers.push({
        img,
        opacity,
        scale,
        imgX,
        imgY,
      });
    }

    return layers;
  }

  private render(): void {
    if (this.destroyed || this.suspended) return;
    if (this.w <= 0 || this.h <= 0) {
      this.resize();
      if (this.w <= 0 || this.h <= 0) return;
    }

    const layers = this.getActiveLayers();
    if (layers.length === 0) return;

    const dpr = this.dpr;
    const w = this.w;
    const h = this.h;
    const pad = this.pad;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const rw = this.refractCanvas.width;
    const rh = this.refractCanvas.height;

    const elRect = this.element.getBoundingClientRect();

    // Optical parameters
    const refractionMax = this.options.refraction * dpr;
    const chroma = this.options.chromaticAberration;
    // Chromatic dispersion spread: ensures colorful prism edge even if refraction is 0 or low
    const chromaSpread = Math.max(refractionMax, 10 * dpr) * chroma;
    // Bevel is confined strictly to the edge rim (max 12 CSS px),
    // ensuring the rest of the navbar has bend = 0 and is 100% seamless with the wallpaper.
    const bevelPx = Math.min(ch * 0.45, Math.max(6 * dpr, (this.options.thickness || 14) * dpr * 0.35));
    const bevelCss = bevelPx / dpr;
    const isTop = this.options.rimPosition !== 'bottom';

    // Helper to render one displaced pass across active layers into bufCtx
    // channelOffset: -1 for Red, 0 for Green, +1 for Blue
    const renderChannel = (channelOffset: number, colorTint: string): void => {
      this.bufCtx.clearRect(0, 0, rw, rh);

      for (const layer of layers) {
        this.bufCtx.globalAlpha = layer.opacity;
        this.bufCtx.globalCompositeOperation = 'source-over';

        const sw = (w + pad * 2) / layer.scale;
        const sh = (1 / dpr) / layer.scale;
        const sx = (elRect.left - pad - layer.imgX) / layer.scale;

        for (let y = 0; y < rh; y++) {
          const cssY = -pad + (y / dpr);
          let bend = 0;

          if (isTop) {
            if (cssY >= 0 && cssY < bevelCss) {
              const dist = cssY;
              const t = (bevelCss - dist) / bevelCss;
              // Snell's law convex roundover curve (quarter-ellipse lens normal)
              bend = Math.sqrt(Math.max(0, 1 - Math.pow(1 - t, 2))) * Math.pow(t, 1.25);
            }
          } else {
            if (cssY > (h - bevelCss) && cssY <= h) {
              const dist = h - cssY;
              const t = (bevelCss - dist) / bevelCss;
              bend = Math.sqrt(Math.max(0, 1 - Math.pow(1 - t, 2))) * Math.pow(t, 1.25);
            }
          }

          const dy = bend * (refractionMax + channelOffset * chromaSpread * 0.5);
          const screenY = elRect.top + cssY + (dy / dpr);
          const sy = (screenY - layer.imgY) / layer.scale;

          drawImageSafe(this.bufCtx, layer.img, sx, sy, sw, sh, 0, y, rw, 1);
        }
      }

      // Tint with pure channel mask
      this.bufCtx.globalAlpha = 1.0;
      this.bufCtx.globalCompositeOperation = 'multiply';
      this.bufCtx.fillStyle = colorTint;
      this.bufCtx.fillRect(0, 0, rw, rh);
    };

    // 1. Red pass (dispersed inward)
    renderChannel(-1.0, '#ff0000');
    this.accCtx.globalCompositeOperation = 'source-over';
    this.accCtx.drawImage(this.buf, 0, 0);

    // 2. Green pass (reference line)
    renderChannel(0.0, '#00ff00');
    this.accCtx.globalCompositeOperation = 'lighter';
    this.accCtx.drawImage(this.buf, 0, 0);

    // 3. Blue pass (dispersed outward)
    renderChannel(1.0, '#0000ff');
    this.accCtx.drawImage(this.buf, 0, 0);

    // Draw combined aberrated refraction to refractCanvas (which has CSS filter for blur/saturation)
    this.refractCtx.clearRect(0, 0, rw, rh);
    this.refractCtx.drawImage(this.acc, 0, 0);

    // Draw overlay canvas: sharp chromatic rim (when blur is active), dark tint, and specular rim highlight
    this.ctx.clearRect(0, 0, cw, ch);

    const effectiveBlur = Math.min(Math.max(0, this.options.blur), 60);
    const startX = Math.round(pad * dpr);
    const startY = Math.round(pad * dpr);

    // When blur is active, refractCanvas blurs the whole background.
    // To keep the chromatic prism crisp and vivid at the rim bevel, slice the sharp acc bevel over the top.
    if (effectiveBlur > 0) {
      if (isTop) {
        const lines = Math.min(ch, Math.ceil(bevelPx));
        for (let y = 0; y < lines; y++) {
          const t = (bevelPx - y) / bevelPx;
          this.ctx.globalAlpha = Math.pow(t, 0.75);
          this.ctx.drawImage(this.acc, startX, startY + y, cw, 1, 0, y, cw, 1);
        }
      } else {
        const lines = Math.min(ch, Math.ceil(bevelPx));
        const startLine = ch - lines;
        for (let y = startLine; y < ch; y++) {
          const dist = (ch - 1) - y;
          const t = (bevelPx - dist) / bevelPx;
          this.ctx.globalAlpha = Math.pow(t, 0.75);
          this.ctx.drawImage(this.acc, startX, startY + y, cw, 1, 0, y, cw, 1);
        }
      }
      this.ctx.globalAlpha = 1.0;
    }

    // Dark mode tint overlay
    if (this.options.tint) {
      this.ctx.fillStyle = this.options.tint;
      this.ctx.fillRect(0, 0, cw, ch);
    }

    // Specular Rim Highlight along the configured edge
    if (this.options.specular && this.options.specularIntensity > 0) {
      const specH = Math.min(ch * 0.25, 5 * dpr);
      const intensity = this.options.specularIntensity;
      if (isTop) {
        const specGrad = this.ctx.createLinearGradient(0, specH, 0, 0);
        specGrad.addColorStop(0, 'rgba(255, 255, 255, 0)');
        specGrad.addColorStop(0.5, `rgba(255, 255, 255, ${0.35 * intensity})`);
        specGrad.addColorStop(1, `rgba(255, 255, 255, ${0.85 * intensity})`);
        this.ctx.fillStyle = specGrad;
        this.ctx.fillRect(0, 0, cw, specH);
      } else {
        const specGrad = this.ctx.createLinearGradient(0, ch - specH, 0, ch);
        specGrad.addColorStop(0, 'rgba(255, 255, 255, 0)');
        specGrad.addColorStop(0.5, `rgba(255, 255, 255, ${0.35 * intensity})`);
        specGrad.addColorStop(1, `rgba(255, 255, 255, ${0.85 * intensity})`);
        this.ctx.fillStyle = specGrad;
        this.ctx.fillRect(0, ch - specH, cw, specH);
      }
    }
  }

  private startLoop(): void {
    const tick = (now: number): void => {
      if (this.destroyed || this.suspended) return;
      // Cap at ~60fps
      if (now - this.lastRenderTime >= 15) {
        this.render();
        this.lastRenderTime = now;
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    window.removeEventListener('resize', this.onResize);
    this.canvas.remove();
    this.refractCanvas.remove();
  }
}
