/**
 * LiquidMenu — Apple's signature "menu summoned from a control" morph.
 *
 * "When glass flexes and morphs to larger sizes – like when presenting a menu
 * from a toolbar button – its material characteristics change to simulate a
 * thicker, more substantial material. It casts deeper, richer shadows, has more
 * pronounced lensing and refraction effects" (Meet Liquid Glass, WWDC25).
 *
 * The menu grows OUT of the trigger with a gel-like spring: we set the menu's
 * transform-origin to the trigger's position and scale it up from a small seed.
 * Because the whole glass (its baked lensing + box-shadow) scales with the
 * transform, the material reads as thicker — deeper shadow and more pronounced
 * lensing — exactly as it reaches full size, then settles. Dismiss collapses it
 * back into the trigger.
 *
 * The menu element should be a `.liquid-glass` (give it its own `LiquidGlass`
 * instance). It is positioned with `position: fixed` and anchored to the trigger.
 */

export type LiquidMenuPlacement =
  | 'bottom-start'
  | 'bottom-end'
  | 'bottom'
  | 'top-start'
  | 'top-end'
  | 'top';

export interface LiquidMenuOptions {
  /** Where the menu sits relative to the trigger. Default 'bottom-start'. */
  placement?: LiquidMenuPlacement;
  /** Gap between trigger and menu, in px. Default 10. */
  offset?: number;
  /** Close on outside click / Escape. Default true. */
  dismissOnOutside?: boolean;
  /**
   * The menu's own `LiquidGlass` instance. When given, the morph also *ramps the
   * lensing* (the refraction grows from ~0 to full as the menu materializes) —
   * "objects materialize … by modulating the light bending and lensing", and a
   * menu morphing to a larger size gains "more pronounced lensing and refraction"
   * (Meet Liquid Glass, WWDC25).
   */
  glass?: LensFlexable;
}

/** Minimal surface of `LiquidGlass` needed to ramp the lensing during a morph. */
export interface LensFlexable {
  flexRefraction(px: number | null): void;
  readonly configuredRefraction: number;
}

const SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
const OUT_EASE = 'cubic-bezier(0.4, 0, 1, 1)';

export class LiquidMenu {
  readonly trigger: HTMLElement;
  readonly menu: HTMLElement;
  private placement: LiquidMenuPlacement;
  private offset: number;
  private dismiss: boolean;
  private open_ = false;
  private anim: Animation | null = null;
  private glass: LensFlexable | null;
  private lensRaf = 0;
  private reduceMotion: boolean;

  constructor(trigger: HTMLElement, menu: HTMLElement, options: LiquidMenuOptions = {}) {
    this.trigger = trigger;
    this.menu = menu;
    this.placement = options.placement ?? 'bottom-start';
    this.offset = options.offset ?? 10;
    this.glass = options.glass ?? null;
    this.dismiss = options.dismissOnOutside ?? true;
    this.reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    menu.style.position = 'fixed';
    menu.style.visibility = 'hidden';
    menu.style.pointerEvents = 'none';
    menu.style.zIndex = '1200';
    menu.dataset.lgMenu = 'closed';
    // Portal to <body> so the fixed menu escapes any ancestor stacking/transform
    // context and layers above page chrome (tab bars etc.).
    if (menu.parentElement !== document.body) document.body.appendChild(menu);

    trigger.addEventListener('click', this.onTriggerClick);
    if (this.dismiss) {
      document.addEventListener('pointerdown', this.onDocPointerDown, true);
      document.addEventListener('keydown', this.onKeyDown);
    }
  }

  get isOpen(): boolean {
    return this.open_;
  }

  open(): void {
    if (this.open_) return;
    this.open_ = true;
    this.menu.dataset.lgMenu = 'open';
    this.menu.style.visibility = 'visible';
    this.menu.style.pointerEvents = 'auto';
    this.position();
    this.morph(true);
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.menu.dataset.lgMenu = 'closed';
    this.morph(false);
  }

  toggle(): void {
    if (this.open_) this.close();
    else this.open();
  }

  destroy(): void {
    this.trigger.removeEventListener('click', this.onTriggerClick);
    document.removeEventListener('pointerdown', this.onDocPointerDown, true);
    document.removeEventListener('keydown', this.onKeyDown);
    this.anim?.cancel();
    if (this.lensRaf) cancelAnimationFrame(this.lensRaf);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private onTriggerClick = (e: MouseEvent): void => {
    e.stopPropagation();
    this.toggle();
  };

  private onDocPointerDown = (e: Event): void => {
    if (!this.open_) return;
    const t = e.target as Node;
    if (this.menu.contains(t) || this.trigger.contains(t)) return;
    this.close();
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this.close();
  };

  /** Anchor the (fixed-positioned) menu to the trigger per placement. */
  private position(): void {
    const t = this.trigger.getBoundingClientRect();
    const m = this.menu.getBoundingClientRect();
    const g = this.offset;
    const below = this.placement.startsWith('bottom');

    let left: number;
    if (this.placement.endsWith('end')) left = t.right - m.width;
    else if (this.placement.endsWith('start')) left = t.left;
    else left = t.left + t.width / 2 - m.width / 2; // centred

    const top = below ? t.bottom + g : t.top - m.height - g;

    // Keep within the viewport with an 8px margin.
    const maxLeft = window.innerWidth - m.width - 8;
    this.menu.style.left = `${Math.max(8, Math.min(left, maxLeft))}px`;
    this.menu.style.top = `${Math.max(8, top)}px`;
  }

  /** Grow out of (open) / collapse into (close) the trigger. */
  private morph(opening: boolean): void {
    const t = this.trigger.getBoundingClientRect();
    const m = this.menu.getBoundingClientRect();

    // Anchor = the trigger's centre, in the menu's local coordinates: the menu
    // unfurls FROM the control it came from.
    const ox = Math.max(0, Math.min(m.width, t.left + t.width / 2 - m.left));
    const oy = Math.max(0, Math.min(m.height, t.top + t.height / 2 - m.top));
    this.menu.style.transformOrigin = `${ox}px ${oy}px`;

    this.anim?.cancel();

    if (this.reduceMotion) {
      // No elastic morph — just show/hide.
      this.menu.style.transform = '';
      this.menu.style.clipPath = '';
      this.glass?.flexRefraction(opening ? null : 0);
      if (!opening) this.hideAfterClose();
      return;
    }

    // Reveal as a circle expanding from the trigger anchor — the menu *unfurls
    // out of the button* (content stays full-size, never zoom-distorted) — with a
    // gentle scale spring and a brief light flare. The lensing ramp (rampLens)
    // makes the glass refraction draw in as it materialises.
    const radius = Math.max(
      Math.hypot(ox, oy),
      Math.hypot(m.width - ox, oy),
      Math.hypot(ox, m.height - oy),
      Math.hypot(m.width - ox, m.height - oy)
    );
    const seed = {
      clipPath: `circle(0px at ${ox}px ${oy}px)`,
      transform: 'scale(0.96)',
      opacity: 0,
      filter: 'brightness(1.3) saturate(1.25)',
    };
    const full = {
      clipPath: `circle(${radius}px at ${ox}px ${oy}px)`,
      transform: 'scale(1)',
      opacity: 1,
      filter: 'brightness(1) saturate(1)',
    };
    const dur = opening ? 480 : 240;
    this.anim = this.menu.animate(opening ? [seed, full] : [full, seed], {
      duration: dur,
      easing: opening ? SPRING : OUT_EASE,
      fill: 'forwards',
    });
    if (!opening) this.anim.onfinish = () => this.hideAfterClose();

    this.rampLens(opening, dur);
  }

  /**
   * Ramp the menu's lensing so the refraction grows in as it materialises (open)
   * / recedes as it collapses (close) — "modulating the light bending and
   * lensing." Cheap per-frame displacement-scale change, no map rebuild.
   */
  private rampLens(opening: boolean, dur: number): void {
    if (!this.glass) return;
    if (this.lensRaf) cancelAnimationFrame(this.lensRaf);
    const target = this.glass.configuredRefraction;
    const from = opening ? 0 : target;
    const to = opening ? target : 0;
    const start = performance.now();
    const step = (): void => {
      const t = Math.min(1, (performance.now() - start) / dur);
      // easeOutCubic — settles smoothly into the final lensing.
      const e = 1 - Math.pow(1 - t, 3);
      this.glass!.flexRefraction(from + (to - from) * e);
      if (t < 1) {
        this.lensRaf = requestAnimationFrame(step);
      } else {
        this.lensRaf = 0;
        if (opening) this.glass!.flexRefraction(null); // restore configured value
      }
    };
    this.lensRaf = requestAnimationFrame(step);
  }

  private hideAfterClose(): void {
    if (this.open_) return; // re-opened mid-animation
    this.menu.style.visibility = 'hidden';
    this.menu.style.pointerEvents = 'none';
    this.menu.style.transform = '';
    this.menu.style.clipPath = '';
  }
}

export interface LiquidSheetOptions {
  /** Dismiss when the dimming scrim is clicked / Escape pressed. Default true. */
  dismissOnScrim?: boolean;
  /** Gap from the bottom edge, in px. Default 24. */
  bottomGap?: number;
}

/**
 * LiquidSheet — a sheet/modal that materializes up from the bottom and grows to
 * full size, over a dimming scrim. Sheets present Liquid Glass, and the material
 * "materializes in and out by … modulating the light bending and lensing" while
 * morphing "to larger sizes … deeper shadows, more pronounced lensing" (Meet
 * Liquid Glass, WWDC25). The Clear-style transparency needs "a dimming layer to
 * darken the underlying content" — that's the scrim.
 *
 * The sheet element should be a `.liquid-glass` (give it its own `LiquidGlass`).
 */
export class LiquidSheet {
  readonly sheet: HTMLElement;
  private scrim: HTMLDivElement;
  private gap: number;
  private dismissOnScrim: boolean;
  private open_ = false;
  private openedAt = 0;
  private anim: Animation | null = null;
  private scrimAnim: Animation | null = null;
  private reduceMotion: boolean;

  constructor(sheet: HTMLElement, options: LiquidSheetOptions = {}) {
    this.sheet = sheet;
    this.gap = options.bottomGap ?? 24;
    this.dismissOnScrim = options.dismissOnScrim ?? true;
    this.reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    sheet.style.position = 'fixed';
    sheet.style.left = '50%';
    sheet.style.bottom = `${this.gap}px`;
    sheet.style.transform = 'translateX(-50%)';
    sheet.style.visibility = 'hidden';
    sheet.style.zIndex = '1201';
    sheet.dataset.lgSheet = 'closed';
    if (sheet.parentElement !== document.body) document.body.appendChild(sheet);

    // Dim only — NO backdrop blur. The sheet has its own backdrop-filter and
    // sits above the scrim, so blurring the scrim would make the sheet sample a
    // dark, doubly-blurred backdrop and read as a murky, buried panel.
    this.scrim = document.createElement('div');
    Object.assign(this.scrim.style, {
      position: 'fixed',
      inset: '0',
      background: 'rgba(0, 0, 0, 0.32)',
      opacity: '0',
      visibility: 'hidden',
      zIndex: '1200',
      pointerEvents: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(this.scrim);

    if (this.dismissOnScrim) {
      this.scrim.addEventListener('click', this.onDismiss);
      document.addEventListener('keydown', this.onKey);
    }
  }

  get isOpen(): boolean {
    return this.open_;
  }

  present(): void {
    if (this.open_) return;
    this.open_ = true;
    this.openedAt = performance.now();
    this.sheet.dataset.lgSheet = 'open';
    this.sheet.style.visibility = 'visible';
    this.scrim.style.visibility = 'visible';
    this.scrim.style.pointerEvents = 'auto';

    this.scrimAnim?.cancel();
    this.scrimAnim = this.scrim.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 300,
      easing: 'ease',
      fill: 'forwards',
    });

    this.anim?.cancel();
    if (this.reduceMotion) {
      this.sheet.style.transform = 'translateX(-50%)';
      return;
    }
    this.anim = this.sheet.animate(
      [
        { transform: 'translateX(-50%) translateY(110%) scale(0.96)', opacity: 0.4 },
        { transform: 'translateX(-50%) translateY(0) scale(1)', opacity: 1 },
      ],
      { duration: 540, easing: SPRING, fill: 'forwards' }
    );
  }

  dismiss(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.sheet.dataset.lgSheet = 'closed';
    this.scrim.style.pointerEvents = 'none';

    this.scrimAnim?.cancel();
    this.scrimAnim = this.scrim.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 260,
      easing: OUT_EASE,
      fill: 'forwards',
    });
    this.scrimAnim.onfinish = () => {
      if (!this.open_) this.scrim.style.visibility = 'hidden';
    };

    this.anim?.cancel();
    if (this.reduceMotion) {
      this.sheet.style.visibility = 'hidden';
      return;
    }
    this.anim = this.sheet.animate(
      [
        { transform: 'translateX(-50%) translateY(0) scale(1)', opacity: 1 },
        { transform: 'translateX(-50%) translateY(110%) scale(0.96)', opacity: 0.4 },
      ],
      { duration: 300, easing: OUT_EASE, fill: 'forwards' }
    );
    this.anim.onfinish = () => {
      if (!this.open_) this.sheet.style.visibility = 'hidden';
    };
  }

  toggle(): void {
    if (this.open_) this.dismiss();
    else this.present();
  }

  destroy(): void {
    this.scrim.removeEventListener('click', this.onDismiss);
    document.removeEventListener('keydown', this.onKey);
    this.anim?.cancel();
    this.scrimAnim?.cancel();
    this.scrim.remove();
  }

  private onDismiss = (): void => {
    // Ignore the tail of the gesture that opened the sheet — otherwise the same
    // click that presented it can immediately fall through to the scrim.
    if (performance.now() - this.openedAt < 300) return;
    this.dismiss();
  };
  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this.dismiss();
  };
}
