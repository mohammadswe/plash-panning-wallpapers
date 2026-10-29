/**
 * Spatial interaction for `.lg-interactive` glass — the motion half of Liquid
 * Glass, which Apple designed together with the look: it "responds to
 * interaction by instantly flexing and energizing with light … it comes to life
 * on touch" (Meet Liquid Glass, WWDC25).
 *
 * This drives the 3D parallax tilt from the hover position (`--lg-tilt-x/y`).
 * The jelly "flex" squish is pure CSS (:active).
 *
 * The pointer-tracked EDGE light, proximity glow AND the press interaction
 * illumination (which spreads onto nearby glass) are owned by the core
 * `PointerField`; this class only adds the per-element tilt.
 * Honors `prefers-reduced-motion` by dropping the elastic tilt.
 */
export class LiquidInteractive {
  /**
   * Attach spatial interaction to every element matching `selector`
   * (default `.lg-interactive`). Returns the created instances.
   */
  static initAll(selector = '.lg-interactive'): LiquidInteractive[] {
    return Array.from(document.querySelectorAll<HTMLElement>(selector)).map(
      (el) => new LiquidInteractive(el)
    );
  }

  private element: HTMLElement;
  private rafId: number | null = null;
  private isHovered = false;
  private reduceMotion = false;
  private previousWillChange: string | null = null;

  // Smoothing states for fluid tilt.
  private targetX = 0.5;
  private targetY = 0.5;
  private currentX = 0.5;
  private currentY = 0.5;

  constructor(element: HTMLElement) {
    this.element = element;
    this.reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Pointer events cover both mouse and touch (so press illumination works on
    // touch devices, where there is no hover).
    element.addEventListener('pointerenter', this.onEnter);
    element.addEventListener('pointermove', this.onMove);
    element.addEventListener('pointerleave', this.onLeave);

    element.style.setProperty('--lg-tilt-x', '0deg');
    element.style.setProperty('--lg-tilt-y', '0deg');
  }

  // ── Hover: 3D parallax tilt ──────────────────────────────────────────────
  private onEnter = (): void => {
    this.isHovered = true;
    if (!this.reduceMotion) {
      this.previousWillChange = this.element.style.willChange;
      this.element.style.willChange = 'transform';
      if (this.rafId === null) this.loop();
    }
  };

  private onLeave = (): void => {
    this.isHovered = false;
    this.targetX = 0.5;
    this.targetY = 0.5;
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.isHovered || this.reduceMotion) return;
    const rect = this.element.getBoundingClientRect();
    this.targetX = (e.clientX - rect.left) / rect.width;
    this.targetY = (e.clientY - rect.top) / rect.height;
  };

  private loop = (): void => {
    this.currentX += (this.targetX - this.currentX) * 0.15;
    this.currentY += (this.targetY - this.currentY) * 0.15;

    const tiltX = (0.5 - this.currentY) * 20;
    const tiltY = (this.currentX - 0.5) * 20;
    this.element.style.setProperty('--lg-tilt-x', `${tiltX.toFixed(2)}deg`);
    this.element.style.setProperty('--lg-tilt-y', `${tiltY.toFixed(2)}deg`);

    if (
      !this.isHovered &&
      Math.abs(this.targetX - this.currentX) < 0.001 &&
      Math.abs(this.targetY - this.currentY) < 0.001
    ) {
      this.rafId = null;
      this.element.style.setProperty('--lg-tilt-x', '0deg');
      this.element.style.setProperty('--lg-tilt-y', '0deg');
      this.element.style.willChange = this.previousWillChange ?? '';
      this.previousWillChange = null;
      return;
    }
    this.rafId = requestAnimationFrame(this.loop);
  };

  destroy(): void {
    this.element.removeEventListener('pointerenter', this.onEnter);
    this.element.removeEventListener('pointermove', this.onMove);
    this.element.removeEventListener('pointerleave', this.onLeave);
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.element.style.willChange = this.previousWillChange ?? '';
  }
}
