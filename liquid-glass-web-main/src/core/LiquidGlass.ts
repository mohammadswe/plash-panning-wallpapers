/**
 * Apple-style Liquid Glass for the web.
 *
 * One backdrop-filter per element, one SVG filter per element, no WebGL
 * contexts, no requestAnimationFrame loops. Refraction is GPU-accelerated by
 * Chromium's compositor via feDisplacementMap; specular rim is baked as a
 * static PNG and blended in screen mode inside the same filter pass.
 *
 * Production / Chrome-extension features:
 *   - Shadow DOM aware (filter is injected into the element's own tree scope)
 *   - quality tiers (high / balanced / low / auto) gate the expensive bits
 *   - lazy init via IntersectionObserver — off-screen glass costs nothing
 *   - suspend()/resume() for cheap show/hide (translation tooltips etc.)
 *   - graceful CSS fallback on non-Chromium and reduced-transparency
 *
 * Usage:
 *   const glass = new LiquidGlass(myEl, { variant: 'regular' });
 *   glass.update({ refraction: 24 });
 *   glass.suspend();  // tooltip hidden — drop GPU cost, keep instance
 *   glass.resume();   // tooltip shown again — cheap
 *   glass.destroy();
 */

import type {
  LiquidGlassOptions,
  LiquidGlassMaterialPreset,
  LiquidGlassOpticalProfile,
  LiquidGlassResolvedState,
  ResolvedOptions,
  LiquidGlassQuality,
  LiquidGlassVariant,
} from './types';
import { resolveLiquidGlassAutoProfile } from './AutoProfile';
import { FilterChain } from './FilterChain';
import { getDisplacementMap, getSpecularMap } from './MapCache';
import { registerPointerLight, unregisterPointerLight } from './PointerField';
import { getWebGLRefractor } from './WebGLRefractor';
import type { RefractorBoxParams } from './WebGLRefractor';
import { SceneOpticalLens } from './SceneOpticalLens';
import { enqueueBuild } from './BuildQueue';
import { observeElementIntersection, observeElementResize } from './ObserverRegistry';
import {
  isLiquidGlassAndroid,
  isLiquidGlassHoverless,
  isLiquidGlassMobileLike,
  resolveLiquidGlassAutoQuality,
} from './DeviceProfile';

const VARIANT_TINT: Record<LiquidGlassVariant, { light: string; dark: string }> = {
  regular: {
    light: 'rgba(255, 255, 255, 0.14)', // light, transparent — content shines through
    dark: 'rgba(0, 0, 0, 0.2)',
  },
  clear: {
    light: 'rgba(255, 255, 255, 0.04)',
    dark: 'rgba(0, 0, 0, 0.04)',
  },
  tinted: {
    // Legacy shortcut. Official Apple guidance uses Regular/Clear plus tinting.
    light: 'rgba(255, 255, 255, 0.32)',
    dark: 'rgba(30, 30, 36, 0.42)',
  },
};

/**
 * Default frost per variant when `blur` isn't given. Liquid Glass blurs the
 * backdrop *before* refracting it, so sharp content (text, edges) is smoothed
 * into colour first and the lens bends a clean image — without enough blur,
 * strong refraction over text looks busy. `regular` is the default system-like
 * variant; `clear` stays more transparent for bold media; `tinted` is retained
 * as a compatibility alias for regular+tint. Explicit `blur` always wins.
 */
const VARIANT_BLUR: Record<LiquidGlassVariant, number> = {
  regular: 4.5, // light frost — kept low so the backdrop keeps structure to bend
  clear: 2.5,   // near-transparent for bold media
  tinted: 11,
};

// The glass edge treatment is built per-instance in applyEdges() — a faint
// hairline + top sheen (volume) + a profile-scaled float shadow (larger glass
// casts deeper, richer shadows).

const DEFAULT_OPTIONS: ResolvedOptions = {
  radius: 22, // Apple's standard corner radius
  thickness: 44, // lens depth — drives how pronounced/thick the edge lensing is
  refraction: 46, // edge lensing strength (px) — concentrated at the border
  chromaticAberration: 0.03,
  blur: 7, // light frost, backdrop reads through so the lensing is visible
  saturation: 150, // gentle lift, backdrop stays close to natural
  variant: 'regular',
  profile: 'auto',
  preset: 'auto',
  scheme: 'auto',
  tint: null,
  specular: true,
  specularIntensity: 0.5,
  edges: true,
  refractBackground: null,
  backdropSource: null,
  applyRadius: true,
  mapPixelRatio: 2,
  quality: 'auto',
  lazy: false,
  lazyMargin: '200px',
  root: null,
  fallbackFilter: 'blur(20px) saturate(1.8)',
  respectReducedMotion: true,
  rimPosition: 'top',
};

/** rAF-debounced regen so dragging/resizing doesn't run the pixel loop hot. */
const RESIZE_DEBOUNCE_MS = 80;
const DESKTOP_DISPLACEMENT_DPR_SCALE = 0.2;
const MOBILE_DISPLACEMENT_DPR_SCALE = 0.15;
const MOBILE_DISPLACEMENT_DPR_CAP = 0.3;
const DESKTOP_SPECULAR_DPR_SCALE = 0.65;
const MOBILE_SPECULAR_DPR_SCALE = 0.3;
const MOBILE_SPECULAR_DPR_CAP = 0.6;

/**
 * A regular content card in the demo is roughly 200px tall; use that as the
 * optical reference for configured blur values. Short bars keep the same
 * material clarity by scaling the absolute blur down from this baseline.
 */
const DEFAULT_SURFACE_REFERENCE_SHORT_SIDE = 200;
const DEFAULT_MIN_SIZE_BLUR_SCALE = 0.32;

interface OpticalTuning {
  /** Scales the configured optical depth. */
  thickness: number;
  /** Scales the configured displacement. */
  refraction: number;
  /** Scales the configured frost. */
  blur: number;
  /** Scales the baked geometry highlight. */
  specular: number;
  /**
   * Scales the float shadow depth. Apple: glass at larger sizes "casts deeper,
   * richer shadows" — so panels cast more, small controls less.
   */
  shadow: number;
  /**
   * Size used as the point where the configured blur reaches full strength.
   * Smaller controls proportionally reduce frost so short bars don't look
   * heavier than larger surfaces.
   */
  blurReferenceShortSide: number;
  /**
   * Minimum size scale for blur. Bars need a higher floor: Apple-style
   * navigation materials dissolve moving content for legibility even when
   * their vertical footprint is short.
   */
  minBlurScale: number;
}

interface PresetTuning {
  thickness: number;
  refraction: number;
  blur: number;
  specular: number;
}

// Apple, official (Meet Liquid Glass, WWDC25; Adopting Liquid Glass): "as glass
// morphs to LARGER sizes … it casts deeper, richer shadows, has more pronounced
// lensing and refraction effects, and a softer scattering of light … aid in the
// legibility." So lensing / refraction / scatter (blur) / specular increase
// MONOTONICALLY with size — control < card < panel. Navigation bars are part of
// the "functional layer for controls and navigation … letting content shine
// through" — kept optically quiet (low lensing) but frosted for legibility.
const OPTICAL_PROFILE: Record<Exclude<LiquidGlassOpticalProfile, 'auto'>, OpticalTuning> = {
  // Navigation bar / header — functional layer, content is the hero. Quiet
  // lensing, but a legibility frost that holds even when the bar is short.
  bar: {
    thickness: 0.42,
    refraction: 0.3,
    blur: 0.95,
    specular: 0.5,
    shadow: 0.7,
    blurReferenceShortSide: 150,
    minBlurScale: 0.72,
  },
  // Small controls (buttons, switches, sliders, media controls) — thinner glass
  // ⇒ less pronounced lensing than a card; clear so bold symbols/content shine
  // through (low frost).
  control: {
    thickness: 0.9,
    refraction: 0.9,
    blur: 0.75,
    specular: 1.0,
    shadow: 0.65,
    blurReferenceShortSide: 140,
    minBlurScale: 0.45,
  },
  // Cards — the reference (separation without competing with content).
  card: {
    thickness: 1,
    refraction: 1,
    blur: 1,
    specular: 1,
    shadow: 1,
    blurReferenceShortSide: DEFAULT_SURFACE_REFERENCE_SHORT_SIDE,
    minBlurScale: DEFAULT_MIN_SIZE_BLUR_SCALE,
  },
  // Large sidebars, sheets, menus, panels — thicker, more substantial material:
  // MORE pronounced lensing/refraction, a softer (heavier) scatter, richer
  // highlights. The lens stays edge-concentrated so the large body still reads.
  panel: {
    thickness: 1.2,
    refraction: 1.18,
    blur: 1.15,
    specular: 1.12,
    shadow: 1.5,
    blurReferenceShortSide: 260,
    minBlurScale: 0.5,
  },
  // Selected capsule — lifted from the same plane, slightly below a card so it
  // never becomes a separate glass-on-glass object.
  selection: {
    thickness: 0.95,
    refraction: 0.88,
    blur: 0.9,
    specular: 1,
    shadow: 0.6,
    blurReferenceShortSide: 150,
    minBlurScale: 0.55,
  },
};

const MATERIAL_PRESET: Record<Exclude<LiquidGlassMaterialPreset, 'auto'>, PresetTuning> = {
  subtle: {
    thickness: 0.82,
    refraction: 0.78,
    blur: 0.82,
    specular: 0.78,
  },
  balanced: {
    thickness: 1,
    refraction: 1,
    blur: 1,
    specular: 1,
  },
  vivid: {
    thickness: 1.08,
    refraction: 1.12,
    blur: 1.08,
    specular: 1.14,
  },
  dramatic: {
    thickness: 1.18,
    refraction: 1.28,
    blur: 1.16,
    specular: 1.28,
  },
};

/** SVG-in-backdrop-filter only works on Chromium. */
const IS_CHROMIUM =
  typeof navigator !== 'undefined' && /Chrome\//.test(navigator.userAgent);

/**
 * Phone/tablet class. backdrop-filter + an SVG filter is very heavy on mobile
 * GPUs — it is re-run every frame the backdrop scrolls — so on mobile we render
 * the maps much smaller, frost lighter, drop the chromatic pass, and lazily
 * tear down off-screen glass so only what's visible costs anything.
 */
const IS_MOBILE =
  isLiquidGlassMobileLike();
const IS_ANDROID = isLiquidGlassAndroid();

/** Touch devices with no hover gain nothing from the pointer-tracked edge light,
 * and updating it during a touch-scroll just costs style recalcs. */
const NO_HOVER =
  isLiquidGlassHoverless();


// One shared window-resize listener for ALL instances (a page with hundreds of
// glass elements shouldn't register hundreds of listeners). Subscribers run on
// resize and unsubscribe on destroy.
const sharedResizeSubs = new Set<() => void>();
let sharedResizeBound = false;
function subscribeResize(fn: () => void): () => void {
  sharedResizeSubs.add(fn);
  if (!sharedResizeBound && typeof window !== 'undefined') {
    sharedResizeBound = true;
    window.addEventListener(
      'resize',
      () => {
        for (const f of sharedResizeSubs) {
          try {
            f();
          } catch {
            /* one subscriber must not break the rest */
          }
        }
      },
      { passive: true }
    );
  }
  return () => sharedResizeSubs.delete(fn);
}

type ScrollSafeMode = 'svg' | 'frost';

interface ScrollSafeSubscriber {
  setMode(mode: ScrollSafeMode): void;
  restoreScore(): number;
}

interface ScrollSafeRestoreTarget {
  subscriber: ScrollSafeSubscriber;
  mode: ScrollSafeMode;
}

const scrollSafeSubs = new Set<ScrollSafeSubscriber>();
let scrollSafeBound = false;
let scrollSafeMode: ScrollSafeMode = 'svg';
let scrollSafeEndTimer: number | null = null;
let scrollSafeRestoreRaf = 0;
let scrollSafeRestoreIdle = 0;
let scrollSafeBudgetTimer: number | null = null;
let scrollSafeRestoreQueue: ScrollSafeRestoreTarget[] = [];
let scrollSafeLastY = typeof window !== 'undefined' ? window.scrollY : 0;
let scrollSafeLastAt = 0;
let scrollSafePressureUntil = 0;
let scrollSafeScrolling = false;
let scrollSafeLongTaskObserver: PerformanceObserver | null = null;

const SCROLL_SAFE_IDLE_MS = 320;
const SCROLL_SAFE_RESTORE_BATCH = 2;
const SCROLL_SAFE_RESTORE_TIMEOUT_MS = 180;
const SCROLL_SAFE_FAST_VELOCITY = 1.15;
const SCROLL_SAFE_FAST_PRESSURE_MS = 650;
const SCROLL_SAFE_LONG_TASK_PRESSURE_MS = 2500;
const SCROLL_SAFE_SVG_BUDGET = 8;
const SCROLL_SAFE_PRESSURE_SVG_BUDGET = 3;
const SCROLL_SAFE_TRANSITION_MS = 180;

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function cancelScrollSafeRestore(): void {
  if (scrollSafeRestoreRaf) {
    cancelAnimationFrame(scrollSafeRestoreRaf);
    scrollSafeRestoreRaf = 0;
  }
  if (scrollSafeRestoreIdle && typeof cancelIdleCallback === 'function') {
    cancelIdleCallback(scrollSafeRestoreIdle);
    scrollSafeRestoreIdle = 0;
  }
  if (scrollSafeBudgetTimer !== null && typeof window !== 'undefined') {
    window.clearTimeout(scrollSafeBudgetTimer);
    scrollSafeBudgetTimer = null;
  }
  scrollSafeRestoreQueue = [];
}

function scrollSafePressureActive(): boolean {
  return nowMs() < scrollSafePressureUntil;
}

function extendScrollSafePressure(duration = SCROLL_SAFE_FAST_PRESSURE_MS): void {
  scrollSafePressureUntil = Math.max(scrollSafePressureUntil, nowMs() + duration);
}

function updateScrollSafePressure(event?: Event): void {
  const now = nowMs();
  if (typeof window !== 'undefined') {
    const y = window.scrollY;
    if (scrollSafeLastAt > 0) {
      const dt = Math.max(1, now - scrollSafeLastAt);
      const velocity = Math.abs(y - scrollSafeLastY) / dt;
      if (velocity >= SCROLL_SAFE_FAST_VELOCITY) extendScrollSafePressure();
    }
    scrollSafeLastY = y;
    scrollSafeLastAt = now;
  }
  if (
    typeof WheelEvent !== 'undefined' &&
    event instanceof WheelEvent &&
    Math.abs(event.deltaY) >= 90
  ) {
    extendScrollSafePressure();
  }
}

function queueScrollSafeRestoreBatch(): void {
  if (typeof requestIdleCallback === 'function') {
    scrollSafeRestoreIdle = requestIdleCallback(
      () => {
        scrollSafeRestoreIdle = 0;
        runScrollSafeRestoreBatch();
      },
      { timeout: SCROLL_SAFE_RESTORE_TIMEOUT_MS }
    );
    return;
  }
  scrollSafeRestoreRaf = requestAnimationFrame(runScrollSafeRestoreBatch);
}

function runScrollSafeRestoreBatch(): void {
  scrollSafeRestoreRaf = 0;
  scrollSafeRestoreIdle = 0;
  const batch = scrollSafeRestoreQueue.splice(0, SCROLL_SAFE_RESTORE_BATCH);
  for (const target of batch) {
    if (!scrollSafeSubs.has(target.subscriber)) continue;
    try {
      target.subscriber.setMode(target.mode);
    } catch {
      /* one subscriber must not break the rest */
    }
  }
  if (scrollSafeRestoreQueue.length) {
    queueScrollSafeRestoreBatch();
  }
}

function scheduleScrollSafeRestore(): void {
  cancelScrollSafeRestore();
  const pressureActive = scrollSafePressureActive();
  const sorted = Array.from(scrollSafeSubs)
    .map((subscriber, index) => ({
      subscriber,
      index,
      score: subscriber.restoreScore(),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const svgBudget = pressureActive ? SCROLL_SAFE_PRESSURE_SVG_BUDGET : SCROLL_SAFE_SVG_BUDGET;
  const svgTargets = new Set(sorted.slice(0, svgBudget).map((item) => item.subscriber));
  scrollSafeRestoreQueue = sorted.map(({ subscriber }) => ({
    subscriber,
    mode: svgTargets.has(subscriber) ? 'svg' : 'frost',
  }));
  if (!scrollSafeRestoreQueue.length) return;
  if (pressureActive && typeof window !== 'undefined') {
    const pressureDelay = Math.max(0, scrollSafePressureUntil - nowMs()) + 40;
    scrollSafeBudgetTimer = window.setTimeout(() => {
      scrollSafeBudgetTimer = null;
      if (scrollSafeMode === 'svg' && scrollSafeSubs.size > 0) {
        scheduleScrollSafeRestore();
      }
    }, pressureDelay);
  }
  if (typeof requestAnimationFrame !== 'function') {
    const queue = scrollSafeRestoreQueue.splice(0);
    for (const target of queue) {
      try {
        target.subscriber.setMode(target.mode);
      } catch {
        /* one subscriber must not break the rest */
      }
    }
    return;
  }
  queueScrollSafeRestoreBatch();
}

function notifyScrollSafe(mode: ScrollSafeMode): void {
  if (scrollSafeMode === mode) return;
  scrollSafeMode = mode;
  if (mode === 'svg') {
    scheduleScrollSafeRestore();
    requestBackdropSample(true);
    return;
  }
  cancelScrollSafeRestore();
  for (const subscriber of scrollSafeSubs) {
    try {
      subscriber.setMode(mode);
    } catch {
      /* one subscriber must not break the rest */
    }
  }
}

function armScrollSafeIdleTimer(): void {
  if (typeof window === 'undefined') return;
  if (scrollSafeEndTimer !== null) window.clearTimeout(scrollSafeEndTimer);
  const pressureDelay = scrollSafePressureActive()
    ? Math.max(SCROLL_SAFE_IDLE_MS, scrollSafePressureUntil - nowMs())
    : SCROLL_SAFE_IDLE_MS;
  scrollSafeEndTimer = window.setTimeout(() => {
    scrollSafeEndTimer = null;
    scrollSafeScrolling = false;
    requestBackdropSample(true);
  }, pressureDelay);
}

function beginScrollSafe(event?: Event): void {
  if (scrollSafeSubs.size === 0) return;
  updateScrollSafePressure(event);
  scrollSafeScrolling = true;
  cancelScrollSafeRestore();
  armScrollSafeIdleTimer();
}

function setupScrollSafeLongTaskObserver(): void {
  if (
    scrollSafeLongTaskObserver ||
    typeof PerformanceObserver === 'undefined' ||
    typeof window === 'undefined'
  ) {
    return;
  }
  try {
    scrollSafeLongTaskObserver = new PerformanceObserver((list) => {
      if (list.getEntries().length === 0) return;
      extendScrollSafePressure(SCROLL_SAFE_LONG_TASK_PRESSURE_MS);
      if (scrollSafeScrolling) {
        armScrollSafeIdleTimer();
      }
    });
    scrollSafeLongTaskObserver.observe({ entryTypes: ['longtask'] });
  } catch {
    scrollSafeLongTaskObserver = null;
  }
}

function subscribeScrollSafe(subscriber: ScrollSafeSubscriber): () => void {
  scrollSafeSubs.add(subscriber);
  if (scrollSafeMode !== 'svg') {
    try {
      subscriber.setMode(scrollSafeMode);
    } catch {
      /* one subscriber must not break the rest */
    }
  }
  if (!scrollSafeBound && typeof window !== 'undefined') {
    scrollSafeBound = true;
    setupScrollSafeLongTaskObserver();
    const onPointerDown = (event: PointerEvent): void => {
      if (event.pointerType === 'mouse') return;
      beginScrollSafe(event);
    };
    window.addEventListener(
      'scroll',
      beginScrollSafe,
      { passive: true, capture: true }
    );
    window.addEventListener('touchstart', beginScrollSafe, { passive: true, capture: true });
    window.addEventListener('touchmove', beginScrollSafe, { passive: true, capture: true });
    window.addEventListener('pointerdown', onPointerDown, { passive: true, capture: true });
    window.addEventListener('wheel', beginScrollSafe, { passive: true, capture: true });
  }
  return () => {
    scrollSafeSubs.delete(subscriber);
    if (scrollSafeSubs.size === 0) notifyScrollSafe('svg');
  };
}

type BackdropSampleSubscriber = () => void;

const backdropSampleSubs = new Set<BackdropSampleSubscriber>();
const BACKDROP_SAMPLE_INTERVAL_MS = IS_MOBILE ? 180 : 96;
const BACKDROP_SAMPLE_IDLE_MS = IS_MOBILE ? 220 : 140;
let backdropSampleBound = false;
let backdropSampleRaf = 0;
let backdropSampleThrottleTimer: number | null = null;
let backdropSampleIdleTimer: number | null = null;
let backdropSampleLastAt = 0;

function notifyBackdropSampleSubscribers(): void {
  for (const fn of backdropSampleSubs) {
    try {
      fn();
    } catch {
      /* one subscriber must not break the rest */
    }
  }
}

function requestBackdropSample(force = false): void {
  if (typeof window === 'undefined' || typeof requestAnimationFrame !== 'function') return;
  if (scrollSafeScrolling && !force) return;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const wait = BACKDROP_SAMPLE_INTERVAL_MS - (now - backdropSampleLastAt);
  if (!force && wait > 0) {
    if (backdropSampleThrottleTimer === null) {
      backdropSampleThrottleTimer = window.setTimeout(() => {
        backdropSampleThrottleTimer = null;
        requestBackdropSample(true);
      }, wait);
    }
    return;
  }
  if (backdropSampleRaf) return;
  backdropSampleRaf = requestAnimationFrame(() => {
    backdropSampleRaf = 0;
    backdropSampleLastAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    notifyBackdropSampleSubscribers();
  });
}

function subscribeBackdropSampling(fn: BackdropSampleSubscriber): () => void {
  backdropSampleSubs.add(fn);
  if (!backdropSampleBound && typeof window !== 'undefined') {
    backdropSampleBound = true;
    window.addEventListener(
      'scroll',
      () => {
        if (backdropSampleSubs.size === 0) return;
        requestBackdropSample(false);
        if (backdropSampleIdleTimer !== null) window.clearTimeout(backdropSampleIdleTimer);
        backdropSampleIdleTimer = window.setTimeout(() => {
          backdropSampleIdleTimer = null;
          if (scrollSafeScrolling) return;
          requestBackdropSample(true);
        }, BACKDROP_SAMPLE_IDLE_MS);
      },
      { passive: true, capture: true }
    );
  }
  return () => {
    backdropSampleSubs.delete(fn);
    if (backdropSampleSubs.size === 0) {
      if (backdropSampleThrottleTimer !== null) window.clearTimeout(backdropSampleThrottleTimer);
      if (backdropSampleIdleTimer !== null) window.clearTimeout(backdropSampleIdleTimer);
      backdropSampleThrottleTimer = null;
      backdropSampleIdleTimer = null;
    }
  };
}

/**
 * Relative luminance (0..1) of a CSS `backgroundColor`, or null when it's
 * effectively transparent (a gradient/image-only layer we can't read).
 */
function parseBgLuminance(color: string): number | null {
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(',').map((s) => parseFloat(s));
  const a = p.length > 3 ? p[3] : 1;
  if (!(a >= 0.5)) return null; // transparent → can't tell what's behind
  return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
}

type WebkitStyle = CSSStyleDeclaration & { webkitBackdropFilter?: string };

function roundCss(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** Parse a CSS rgb/rgba color to [r,g,b,a] in 0..1 (for the GPU tint uniform). */
function parseRgba(color: string): [number, number, number, number] {
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (!m) return [1, 1, 1, 0];
  const p = m[1].split(',').map((s) => parseFloat(s));
  return [(p[0] || 0) / 255, (p[1] || 0) / 255, (p[2] || 0) / 255, p[3] == null ? 1 : p[3]];
}

export class LiquidGlass {
  private static readonly autoQualityInstances = new Set<LiquidGlass>();
  private static autoQualityRaf = 0;

  private static requestAutoQualityRecalc(): void {
    if (LiquidGlass.autoQualityRaf || typeof requestAnimationFrame !== 'function') return;
    LiquidGlass.autoQualityRaf = requestAnimationFrame(() => {
      LiquidGlass.autoQualityRaf = 0;
      const visible = Array.from(LiquidGlass.autoQualityInstances).filter(
        (glass) => glass.autoQualityVisible && !glass.destroyed && !glass.suspended
      ).length;
      for (const glass of LiquidGlass.autoQualityInstances) {
        if (!glass.destroyed) glass.refreshAutoQuality(visible);
      }
    });
  }

  readonly element: HTMLElement;
  private options: ResolvedOptions;
  private quality: Exclude<LiquidGlassQuality, 'auto'>;
  private root: Document | ShadowRoot;
  private filter: FilterChain | null = null;
  private unsubElementResize: (() => void) | null = null;
  private unsubLazyIntersection: (() => void) | null = null;
  private unsubAutoQualityIntersection: (() => void) | null = null;
  private mqlScheme: MediaQueryList | null = null;
  private mqlListener: ((e: MediaQueryListEvent) => void) | null = null;
  private currentWidth = 0;
  private currentHeight = 0;
  private destroyed = false;
  private suspended = false;
  private usesFallback = false;
  /** True when prefers-reduced-transparency is honored — keep the glass calm. */
  private reducedTransparency = false;
  /** Injected child layer for the enhanced fallback (specular rim / refraction). */
  private fxLayer: HTMLElement | null = null;
  /** Brief frost veil used to hide CSS-frost → SVG-filter restore snaps. */
  private scrollSafeLayer: HTMLElement | null = null;
  private scrollSafeLayerTimer: number | null = null;
  /** backdropSource refraction state (Firefox -moz-element / Safari DOM clone). */
  private backdropSceneEl: HTMLElement | null = null;
  private refractClone: HTMLElement | null = null;
  private backdropMode: 'webgl' | 'moz' | 'clone' | null = null;
  private sceneLens: SceneOpticalLens | null = null;
  private backdropSyncRaf = 0;
  /** Primary GPU refraction (shared WebGL canvas) is active for this element. */
  private usesGpu = false;
  private gpuHandle: { destroy: () => void; refresh: () => void } | null = null;
  /** Tracks devicePixelRatio so a browser-zoom / monitor switch re-bakes maps. */
  private lastDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  /** Cancels a queued (time-sliced) initial build if it hasn't run yet. */
  private pendingBuild: (() => void) | null = null;
  /** Unsubscribe from the shared window-resize listener. */
  private unsubResize: (() => void) | null = null;
  /** Unsubscribe from the shared mobile scroll-safe listener. */
  private unsubScrollSafe: (() => void) | null = null;
  /** Unsubscribe from the shared backdrop sampling listener. */
  private unsubBackdropSampling: (() => void) | null = null;
  private regenTimer: number | null = null;
  /** Invalidates async map encodes that finish after a newer build wins. */
  private buildGeneration = 0;
  /** Backdrop-aware shadow multiplier (1 = neutral; >1 darker backdrop). */
  private shadowAdapt = 1;
  /** Resolved light/dark for scheme:'adaptive' (null = fall back to OS). */
  private resolvedAdaptiveScheme: 'light' | 'dark' | null = null;
  private backdropSampleKey = '';
  private backdropSampleAt = 0;
  private backdropSampleLum: number | null = null;
  private autoQualityVisible = true;
  private scrollSafeMode: ScrollSafeMode = 'svg';
  private readonly scrollSafeSubscriber: ScrollSafeSubscriber = {
    setMode: (mode) => this.setScrollSafeMode(mode),
    restoreScore: () => this.scrollSafeRestoreScore(),
  };

  constructor(element: HTMLElement, options: LiquidGlassOptions = {}) {
    this.element = element;
    this.options = this.resolve(options);
    this.quality = 'balanced';
    this.root = this.resolveRoot();

    const computed = getComputedStyle(element);
    if (computed.position === 'static') element.style.position = 'relative';
    if (computed.isolation !== 'isolate') element.style.isolation = 'isolate';
    if (computed.overflow === 'visible') element.style.overflow = 'hidden';

    const rect = element.getBoundingClientRect();
    this.currentWidth = Math.max(1, rect.width);
    this.currentHeight = Math.max(1, rect.height);
    this.quality = this.resolveQuality(1);

    this.applyTint();
    if (this.options.applyRadius) {
      element.style.borderRadius = `${this.computedRadius()}px`;
    }

    // Reduced-transparency users get the calmest path: a plain frosted fallback
    // with none of the pointer light / adaptive / specular enhancements.
    this.reducedTransparency =
      this.options.respectReducedMotion &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-transparency: reduce)').matches;

    // Decide the rendering path once.
    this.usesFallback = this.shouldFallback();

    // Chromium keeps its superior native backdrop-filter. On the fallback path
    // (Safari/Firefox, or forced via quality:'low') a refraction scene routes
    // the box through the shared WebGL renderer instead of the CSS-only frost.
    // The expensive map build is time-sliced (BuildQueue) so a page full of
    // glass doesn't freeze on load — the tint + edges show immediately and the
    // refraction/frost materializes within a few frames.
    if (this.usesFallback && !this.reducedTransparency && this.tryInstallGpu()) {
      this.usesGpu = true;
    } else if (this.usesFallback) {
      this.applyFallback();
    } else if (this.options.lazy && typeof IntersectionObserver !== 'undefined') {
      this.setupLazy();
    } else {
      this.scheduleBuild(() => this.installFilter());
    }

    // Size tracking for EVERY path (native, frost fallback, GPU) — so the glass
    // stays correct through responsive layouts, window resizes, orientation
    // changes, and being shown after starting at zero size. ResizeObserver fires
    // on the element's own box change, which covers all of the above.
    this.unsubElementResize = observeElementResize(element, this.onElementResize);

    // Browser zoom / moving to a different-DPR display changes devicePixelRatio
    // without changing the element's CSS size, so ResizeObserver won't catch it —
    // re-bake the maps at the new pixel density when that happens. One shared
    // window listener serves every instance.
    this.unsubResize = subscribeResize(this.onWindowResize);

    if (this.options.quality === 'auto') this.setupAutoQualityTracking();
    if (this.shouldUseScrollSafe()) this.unsubScrollSafe = subscribeScrollSafe(this.scrollSafeSubscriber);

    if (this.options.scheme === 'auto' && typeof window.matchMedia === 'function') {
      this.mqlScheme = window.matchMedia('(prefers-color-scheme: dark)');
      this.mqlListener = (): void => this.applyTint();
      this.mqlScheme.addEventListener('change', this.mqlListener);
    }

    // Pointer-tracked edge light for every glass element (core, not just
    // .lg-interactive). The CSS `.liquid-glass::after` consumes the vars — pure
    // CSS/JS, so it works on the Safari/Firefox fallback too. Skipped on
    // hover-less touch devices: it gains nothing there and updating it during a
    // touch-scroll only costs style recalcs.
    if (!this.reducedTransparency && !NO_HOVER) registerPointerLight(this.element);

    // Sample the backdrop once laid out (content-aware shadow + adaptive scheme).
    // Also runs on the fallback path: luminance sampling is plain DOM, so Safari
    // gets adaptive light/dark and content-aware shadows too.
    if (!this.reducedTransparency && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        if (!this.destroyed) this.adaptToBackdrop();
      });
    }
    // Adaptive elements share one throttled scroll sampler instead of each
    // attaching an elementsFromPoint/getComputedStyle loop to scroll.
    this.refreshBackdropSamplingSubscription();
  }

  /** Access the optical lens engine on the scene refraction path. */
  get lens(): SceneOpticalLens | null {
    return this.sceneLens;
  }

  /** Access the cloned scene element on the fallback refraction path. */
  get clone(): HTMLElement | null {
    return this.refractClone;
  }

  /** Access the refraction overlay layer. */
  get fx(): HTMLElement | null {
    return this.fxLayer;
  }

  update(partial: LiquidGlassOptions): void {
    const prev = this.options;
    const prevQuality = this.quality;
    this.options = this.resolve({ ...this.optionsAsInput(), ...partial });
    this.quality = this.resolveQuality(this.currentVisibleAutoQualityCount());
    if (prev.quality !== this.options.quality) {
      if (this.options.quality === 'auto') this.setupAutoQualityTracking();
      else this.teardownAutoQualityTracking();
    }
    this.applyTint();
    this.refreshBackdropSamplingSubscription();
    if (this.options.applyRadius) {
      this.element.style.borderRadius = `${this.computedRadius()}px`;
    }

    // A changed quality tier, fallback decision, or specular toggle flips the
    // filter-chain shape (pass count / nodes) — rebuild from scratch then.
    if (
      prevQuality !== this.quality ||
      prev.specular !== this.options.specular ||
      this.usesFallback !== this.shouldFallback()
    ) {
      this.rebuild();
      return;
    }

    if (prevQuality !== this.quality) this.refreshScrollSafeSubscription();

    if (this.usesGpu) {
      this.gpuHandle?.refresh(); // live param change → re-upload uniforms/maps
      return;
    }

    if (this.sceneLens) {
      this.sceneLens.update({
        refraction: this.options.refraction,
        chromaticAberration: this.options.chromaticAberration,
        thickness: this.options.thickness,
        blur: this.options.blur,
        saturation: this.options.saturation,
        specular: this.options.specular,
        specularIntensity: this.options.specularIntensity,
        tint: this.options.tint,
        profile: this.options.profile,
        preset: this.options.preset,
        rimPosition: this.options.rimPosition,
      });
    }

    if (this.filter) {
      this.filter.updateBlur(this.effectiveBlur());
      this.filter.updateRefraction(this.effectiveRefraction());
      this.filter.updateSaturation(this.options.saturation);
    }

    // The displacement/specular PNGs are the expensive part. blur, saturation,
    // refraction scale, tint and scheme are applied as live filter/CSS attrs
    // above, so only regenerate the maps when a param that changes their pixels
    // moved — radius, thickness, specular intensity, or the displacement
    // padding (= ceil(refraction)). This keeps live theme/tint toggles free.
    const mapsChanged =
      prev.radius !== this.options.radius ||
      prev.thickness !== this.options.thickness ||
      prev.profile !== this.options.profile ||
      prev.preset !== this.options.preset ||
      prev.specularIntensity !== this.options.specularIntensity ||
      Math.max(
        8,
        Math.ceil(
          prev.refraction *
            this.opticalTuningFor(prev.profile).refraction *
            this.presetTuningFor(prev.preset, prev.profile).refraction
        )
      ) !==
        Math.max(8, Math.ceil(this.profiledRefraction()));
    if (mapsChanged) this.scheduleRegen();
  }

  /**
   * Re-read the backdrop and re-resolve the content-aware shadow and, for
   * `scheme: 'adaptive'`, the light/dark appearance. The engine already does
   * this on layout and on scroll; call it manually when the content *behind* a
   * stationary adaptive element changes (a theme swap, a background image load,
   * a recolored hero) and you want the glass to glide to the new appearance.
   * Works on the fallback path too; only the reduced-transparency path opts out.
   */
  syncToBackdrop(): void {
    this.adaptToBackdrop(true);
  }

  /**
   * Live-override the lensing (displacement) strength in px WITHOUT rebuilding
   * the maps — a cheap per-frame GPU attribute change for morph / materialize
   * animations (e.g. `LiquidMenu` ramping the refraction as the menu grows).
   * Pass `null` to restore the configured value.
   */
  flexRefraction(px: number | null): void {
    if (!this.filter) return;
    this.filter.updateRefraction(px == null ? this.effectiveRefraction() : Math.max(0, px));
  }

  get resolved(): LiquidGlassResolvedState {
    const profile = this.resolveOpticalProfile();
    const preset = this.resolveMaterialPreset();
    return {
      profile,
      preset,
      variant: this.options.variant,
      scheme: this.resolveScheme(),
      radius: this.computedRadius(),
      thickness: this.computedThickness(),
      refraction: this.effectiveRefraction(),
      blur: this.effectiveBlur(),
      saturation: this.options.saturation,
      specularIntensity: this.profiledSpecularIntensity(),
      tint: this.options.tint ?? this.variantTint(),
      usesFallback: this.usesFallback,
      quality: this.quality,
      width: this.currentWidth,
      height: this.currentHeight,
    };
  }

  /** The configured (size-capped) lensing strength in px. */
  get configuredRefraction(): number {
    return this.effectiveRefraction();
  }

  /** Detach the GPU filter but keep the instance alive (cheap show/hide). */
  suspend(): void {
    if (this.suspended || this.destroyed) return;
    this.sceneLens?.suspend();
    this.setScrollSafeMode('svg');
    this.suspended = true;
    this.cancelPendingBuild();
    this.removeScrollSafeTransitionLayer();
    this.removeFallbackFx();
    this.teardownGpu();
    this.element.style.backdropFilter = 'none';
    (this.element.style as WebkitStyle).webkitBackdropFilter = 'none';
  }

  /** Re-attach the previously built filter. No pixel work if size is unchanged. */
  resume(): void {
    if (!this.suspended || this.destroyed) return;
    this.suspended = false;
    this.sceneLens?.resume();
    if (this.usesFallback && !this.reducedTransparency && this.tryInstallGpu()) {
      this.usesGpu = true;
    } else if (this.usesFallback) {
      this.applyFallback();
    } else if (this.filter) {
      const css = this.filter.url;
      this.element.style.backdropFilter = css;
      (this.element.style as WebkitStyle).webkitBackdropFilter = css;
    } else {
      this.installFilter();
    }
    this.refreshScrollSafeSubscription();
    LiquidGlass.requestAutoQualityRecalc();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.regenTimer !== null) {
      clearTimeout(this.regenTimer);
      this.regenTimer = null;
    }
    this.unsubElementResize?.();
    this.unsubElementResize = null;
    this.unsubLazyIntersection?.();
    this.unsubLazyIntersection = null;
    this.teardownAutoQualityTracking();
    if (this.mqlScheme && this.mqlListener) {
      this.mqlScheme.removeEventListener('change', this.mqlListener);
    }
    this.unsubBackdropSampling?.();
    this.unsubBackdropSampling = null;
    this.unsubResize?.();
    this.unsubResize = null;
    this.unsubScrollSafe?.();
    this.unsubScrollSafe = null;
    this.setScrollSafeMode('svg');
    this.cancelPendingBuild();
    this.removeScrollSafeTransitionLayer();
    this.removeFallbackFx();
    this.teardownGpu();
    this.filter?.destroy();
    this.filter = null;
    unregisterPointerLight(this.element);
    this.element.style.backdropFilter = '';
    (this.element.style as WebkitStyle).webkitBackdropFilter = '';
    if (this.options.edges) this.element.style.boxShadow = '';
  }

  // ── internals ────────────────────────────────────────────────────────────

  private resolveQuality(visibleGlassCount = 1): Exclude<LiquidGlassQuality, 'auto'> {
    if (this.options.quality !== 'auto') return this.options.quality;
    return resolveLiquidGlassAutoQuality({
      mobile: IS_MOBILE,
      android: IS_ANDROID,
      hoverNone: NO_HOVER,
      hardwareConcurrency: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined,
      deviceMemory:
        typeof navigator !== 'undefined'
          ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory
          : undefined,
      devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : undefined,
      visibleGlassCount,
      profile: this.resolveOpticalProfile(),
      width: this.currentWidth,
      height: this.currentHeight,
    });
  }

  private currentVisibleAutoQualityCount(): number {
    return Math.max(
      1,
      Array.from(LiquidGlass.autoQualityInstances).filter(
        (glass) => glass.autoQualityVisible && !glass.destroyed && !glass.suspended
      ).length
    );
  }

  private setupAutoQualityTracking(): void {
    LiquidGlass.autoQualityInstances.add(this);
    if (!IS_MOBILE) return;
    if (this.unsubAutoQualityIntersection || typeof IntersectionObserver === 'undefined') {
      LiquidGlass.requestAutoQualityRecalc();
      return;
    }
    this.unsubAutoQualityIntersection = observeElementIntersection(
      this.element,
      (entry) => {
        const visible = entry.isIntersecting;
        if (this.autoQualityVisible === visible) return;
        this.autoQualityVisible = visible;
        LiquidGlass.requestAutoQualityRecalc();
      },
      { rootMargin: '0px' }
    );
    LiquidGlass.requestAutoQualityRecalc();
  }

  private teardownAutoQualityTracking(): void {
    LiquidGlass.autoQualityInstances.delete(this);
    this.unsubAutoQualityIntersection?.();
    this.unsubAutoQualityIntersection = null;
    this.autoQualityVisible = true;
    LiquidGlass.requestAutoQualityRecalc();
  }

  private refreshAutoQuality(visibleGlassCount: number): void {
    if (this.options.quality !== 'auto') return;
    const next = this.resolveQuality(visibleGlassCount);
    if (next === this.quality) return;
    this.quality = next;
    this.rebuild();
  }

  private shouldUseScrollSafe(): boolean {
    if (!IS_MOBILE || !IS_CHROMIUM || this.options.quality !== 'auto') return false;
    if (this.reducedTransparency || this.usesFallback || this.usesGpu || this.suspended) return false;
    const profile = this.resolveOpticalProfile();
    const short = Math.min(this.currentWidth, this.currentHeight);
    const area = this.currentWidth * this.currentHeight;
    if (profile === 'control' || profile === 'selection') return short >= 64 && area >= 24_000;
    if (profile === 'bar') return short >= 56 && area >= 32_000;
    return profile === 'card' || profile === 'panel';
  }

  private refreshScrollSafeSubscription(): void {
    const shouldSubscribe = this.shouldUseScrollSafe();
    if (shouldSubscribe && !this.unsubScrollSafe) {
      this.unsubScrollSafe = subscribeScrollSafe(this.scrollSafeSubscriber);
    } else if (!shouldSubscribe && this.unsubScrollSafe) {
      this.unsubScrollSafe();
      this.unsubScrollSafe = null;
      this.setScrollSafeMode('svg');
    }
  }

  private refreshBackdropSamplingSubscription(): void {
    const shouldSubscribe = this.options.scheme === 'adaptive' && !this.reducedTransparency;
    if (shouldSubscribe && !this.unsubBackdropSampling) {
      this.unsubBackdropSampling = subscribeBackdropSampling(this.onBackdropScroll);
    } else if (!shouldSubscribe && this.unsubBackdropSampling) {
      this.unsubBackdropSampling();
      this.unsubBackdropSampling = null;
    }
  }

  private scrollSafeRestoreScore(): number {
    if (this.destroyed || this.suspended || !this.filter) return -1_000_000;
    if (typeof window === 'undefined') return 0;

    const rect = this.element.getBoundingClientRect();
    const viewportWidth = window.innerWidth || 1;
    const viewportHeight = window.innerHeight || 1;
    const visibleWidth = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
    const visibleHeight = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
    const visibleArea = visibleWidth * visibleHeight;
    if (visibleArea <= 0) return -1_000_000;

    const area = Math.max(1, rect.width * rect.height);
    const visibleRatio = visibleArea / area;
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const centerDistance = Math.hypot(
      (centerX - viewportWidth / 2) / viewportWidth,
      (centerY - viewportHeight / 2) / viewportHeight
    );
    const profile = this.resolveOpticalProfile();
    const profileBonus =
      profile === 'control' || profile === 'selection'
        ? 80
        : profile === 'bar'
          ? 70
          : profile === 'card'
            ? 35
            : 25;
    const sizePenalty = Math.min(40, area / 12_000);

    return profileBonus + visibleRatio * 60 - centerDistance * 45 - sizePenalty;
  }

  private scrollSafeCssForMode(mode: ScrollSafeMode): string {
    if (mode === 'frost') return this.profiledFallbackFilter();
    return this.filter?.url ?? 'none';
  }

  private setScrollSafeMode(mode: ScrollSafeMode): void {
    if (mode === this.scrollSafeMode) return;
    const previousMode = this.scrollSafeMode;
    this.scrollSafeMode = mode;
    if (this.destroyed || this.suspended || this.usesFallback || this.usesGpu) return;
    if (mode === 'svg' && !this.filter) return;
    if (previousMode === 'frost' && mode === 'svg') {
      this.startScrollSafeTransitionLayer(this.profiledFallbackFilter());
    } else if (mode === 'frost') {
      this.removeScrollSafeTransitionLayer();
    }
    const css = this.scrollSafeCssForMode(mode);
    this.element.style.backdropFilter = css;
    (this.element.style as WebkitStyle).webkitBackdropFilter = css;
  }

  private startScrollSafeTransitionLayer(filterCss: string): void {
    if (this.reducedTransparency || typeof window === 'undefined') return;
    if (this.scrollSafeLayerTimer !== null) {
      window.clearTimeout(this.scrollSafeLayerTimer);
      this.scrollSafeLayerTimer = null;
    }

    let layer = this.scrollSafeLayer;
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'lg-scroll-safe-layer';
      layer.setAttribute('aria-hidden', 'true');
      this.element.insertBefore(layer, this.element.firstChild);
      this.scrollSafeLayer = layer;
    }

    layer.style.transition = 'none';
    layer.style.opacity = '1';
    layer.style.setProperty('--lg-scroll-safe-filter', filterCss);
    layer.style.setProperty('--lg-scroll-safe-duration', `${SCROLL_SAFE_TRANSITION_MS}ms`);
    layer.style.setProperty(
      '--lg-scroll-safe-tint',
      this.element.style.backgroundColor || this.options.tint || this.variantTint()
    );

    requestAnimationFrame(() => {
      if (this.scrollSafeLayer !== layer) return;
      layer.style.transition = '';
      layer.style.opacity = '0';
    });

    this.scrollSafeLayerTimer = window.setTimeout(() => {
      if (this.scrollSafeLayer === layer) {
        layer.remove();
        this.scrollSafeLayer = null;
      }
      this.scrollSafeLayerTimer = null;
    }, SCROLL_SAFE_TRANSITION_MS + 80);
  }

  private removeScrollSafeTransitionLayer(): void {
    if (this.scrollSafeLayerTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(this.scrollSafeLayerTimer);
      this.scrollSafeLayerTimer = null;
    }
    this.scrollSafeLayer?.remove();
    this.scrollSafeLayer = null;
  }

  private resolveRoot(): Document | ShadowRoot {
    if (this.options.root) return this.options.root;
    const rootNode = this.element.getRootNode();
    return rootNode instanceof ShadowRoot ? rootNode : document;
  }

  private shouldFallback(): boolean {
    if (!IS_CHROMIUM) return true;
    if (this.quality === 'low') return true;
    if (this.options.respectReducedMotion && typeof window.matchMedia === 'function') {
      if (window.matchMedia('(prefers-reduced-transparency: reduce)').matches) return true;
    }
    return false;
  }

  /** Queue an expensive build (map gen / specular) on the time-sliced scheduler,
   * cancelling any build already pending for this element. */
  private scheduleBuild(fn: () => void | Promise<void>): void {
    this.cancelPendingBuild();
    this.pendingBuild = enqueueBuild(() => {
      this.pendingBuild = null;
      if (!this.destroyed && !this.suspended) return fn();
    });
  }

  private cancelPendingBuild(): void {
    this.buildGeneration++;
    if (this.pendingBuild) {
      this.pendingBuild();
      this.pendingBuild = null;
    }
  }

  private isBuildCurrent(generation: number): boolean {
    return !this.destroyed && !this.suspended && generation === this.buildGeneration;
  }

  private applyFallback(): void {
    this.usesFallback = true;
    // The CSS frost is instant; apply it now so the element reads as glass
    // immediately. Enhanced fallback overlays are skipped for quality:'low'.
    const css =
      this.options.fallbackFilter === DEFAULT_OPTIONS.fallbackFilter
        ? this.profiledFallbackFilter()
        : this.options.fallbackFilter;
    this.element.style.backdropFilter = css;
    (this.element.style as WebkitStyle).webkitBackdropFilter = css;
    if (this.fallbackEnhanced()) this.scheduleBuild(() => this.installFallbackFx());
  }

  private profiledFallbackFilter(): string {
    const blur = Math.max(4, Math.min(22, this.effectiveBlur() * 1.45));
    const saturation = Math.max(1, Math.min(2, this.options.saturation / 100));
    return `blur(${roundCss(blur)}px) saturate(${roundCss(saturation)})`;
  }

  /** Enhancements active on the fallback path (Safari/Firefox), but not for the
   * deliberately-calm reduced-transparency path. */
  private fallbackEnhanced(): boolean {
    return this.usesFallback && !this.reducedTransparency && this.quality !== 'low';
  }

  /**
   * Bring the Safari/Firefox fallback as close to Liquid Glass as the platform
   * allows. Two layers, injected as a single inset child behind the content:
   *   • refraction — if `refractBackground` is set, a copy of the page's fixed
   *     backdrop displaced by the SAME SVG filter, applied as a regular
   *     `filter:` (which Safari supports). This is real lensing of that
   *     backdrop. Otherwise…
   *   • specular rim — the baked rim/gloss PNG, screen-blended over the frost,
   *     restoring the crisp light edge the SVG filter would have added.
   * The pointer light, adaptive scheme and content-aware shadow are already
   * enabled on this path; this adds the parts that lived inside the filter.
   */
  /**
   * Primary GPU path: render this element's refraction through the shared WebGL
   * canvas (same on every browser). Needs `backdropSource` to resolve to an
   * uploadable scene (<canvas>/<img>/<video>) and WebGL2. The element becomes a
   * transparent window — its tint/refraction come from the shader, while its
   * box-shadow, rim light and text stay CSS. Returns false to fall through to
   * the native filter / CSS fallback.
   */
  private tryInstallGpu(): boolean {
    const scene = this.resolveBackdropSource();
    if (!scene) return false;
    const refractor = getWebGLRefractor();
    if (!refractor) return false;
    if (!refractor.canvas.isConnected) document.body.appendChild(refractor.canvas);
    const handle = refractor.register(this.element, scene, () => this.gpuParams());
    if (!handle) return false;
    this.gpuHandle = handle;
    // Transparent window: the shader paints the backdrop; drop the element's own
    // background tint and any backdrop-filter.
    this.element.style.backgroundColor = 'transparent';
    this.dropOwnBackdrop();
    return true;
  }

  private async gpuParams(): Promise<RefractorBoxParams> {
    const [disp, specularMapUrl] = await Promise.all([
      getDisplacementMap({
        width: this.currentWidth,
        height: this.currentHeight,
        radius: this.computedRadius(),
        thickness: this.computedThickness(),
        pixelRatio: this.displacementDpr(),
        refraction: this.profiledRefraction(),
      }),
      this.options.specular ? this.specularMapUrl() : Promise.resolve(null),
    ]);
    return {
      displacementMapUrl: disp.url,
      displacementPadding: disp.padding,
      specularMapUrl,
      refraction: this.effectiveRefraction(),
      blur: this.effectiveBlur(),
      chromaticAberration: this.effectiveChromatic(),
      saturation: this.options.saturation,
      radius: this.computedRadius(),
      tint: parseRgba(this.options.tint ?? this.variantTint()),
    };
  }

  private teardownGpu(): void {
    if (!this.gpuHandle) return;
    this.gpuHandle.destroy();
    this.gpuHandle = null;
    this.usesGpu = false;
  }

  private async installFallbackFx(): Promise<void> {
    const generation = ++this.buildGeneration;
    this.removeFallbackFx();
    if (!this.fallbackEnhanced() || this.suspended) return;

    // Best path first: a designated scene element gives Chromium-level
    // refraction here too (Firefox via -moz-element, others via a DOM clone).
    const scene = this.resolveBackdropSource();
    if (scene) {
      await this.installBackdropRefraction(scene, generation);
      return;
    }

    const layer = document.createElement('div');
    layer.setAttribute('aria-hidden', 'true');
    // z-index:-1 keeps it above the element's tint but below the in-flow
    // content (legible text), inside the element's isolated stacking context.
    layer.style.cssText =
      'position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:-1;';

    if (this.options.refractBackground) {
      // The replicated backdrop fully paints the body, so drop the element's own
      // (un-refracted) backdrop blur to avoid a muddy double frost.
      this.dropOwnBackdrop();
      layer.style.background = this.options.refractBackground;
      layer.style.backgroundSize = 'cover';
      const filterUrl = await this.buildRefractFilter(generation);
      if (!filterUrl || !this.isBuildCurrent(generation)) return;
      this.setLayerFilter(layer, filterUrl);
    } else if (this.options.specular) {
      // Specular rim only — screen-blend the baked highlight over the frost.
      const specularUrl = await this.specularMapUrl();
      if (!this.isBuildCurrent(generation)) return;
      layer.style.backgroundImage = `url("${specularUrl}")`;
      layer.style.backgroundSize = '100% 100%';
      layer.style.mixBlendMode = 'screen';
    } else {
      return; // nothing to add
    }

    this.element.insertBefore(layer, this.element.firstChild);
    this.fxLayer = layer;
  }

  /**
   * Real refraction sourced from a designated scene element — the cross-engine
   * route to Chromium-level lensing. The lens layer is glass-sized (so the
   * shared displacement map aligns 1:1) and carries the scene as its source:
   *   • Firefox → `-moz-element(#scene)` paints the LIVE scene as the lens image;
   *   • others  → a position-synced DOM clone of the scene.
   * A regular `filter:` (supported everywhere) then displaces that source with
   * the same map Chromium runs in backdrop-filter, so the result matches.
   */
  private async installBackdropRefraction(scene: HTMLElement, _generation: number): Promise<void> {
    if (this.sceneLens) {
      this.sceneLens.destroy();
      this.sceneLens = null;
    }

    this.sceneLens = new SceneOpticalLens(this.element, scene, {
      refraction: this.options.refraction,
      chromaticAberration: this.options.chromaticAberration,
      thickness: this.options.thickness,
      blur: this.options.blur,
      saturation: this.options.saturation,
      specular: this.options.specular,
      specularIntensity: this.options.specularIntensity,
      tint: this.options.tint,
      profile: this.options.profile,
      preset: this.options.preset,
      rimPosition: this.options.rimPosition,
    });

    this.backdropSceneEl = scene;
    this.element.dispatchEvent(
      new CustomEvent('liquidglass:ready', {
        detail: {
          lens: this.sceneLens,
          element: this.element,
          clone: null,
          layer: this.sceneLens.canvas,
        },
      })
    );
  }

  /** Keep the scene source aligned with where the scene really is on screen. */
  private syncBackdropRefraction(): void {
    if (!this.fxLayer || !this.backdropSceneEl) return;
    const g = this.element.getBoundingClientRect();
    const s = this.backdropSceneEl.getBoundingClientRect();
    const x = s.left - g.left;
    const y = s.top - g.top;
    if (this.backdropMode === 'moz') {
      this.fxLayer.style.backgroundPosition = `${roundCss(x)}px ${roundCss(y)}px`;
      this.fxLayer.style.backgroundSize = `${roundCss(s.width)}px ${roundCss(s.height)}px`;
    } else if (this.refractClone) {
      this.refractClone.style.left = `${roundCss(x)}px`;
      this.refractClone.style.top = `${roundCss(y)}px`;
      this.refractClone.style.width = `${roundCss(s.width)}px`;
      this.refractClone.style.height = `${roundCss(s.height)}px`;
    }
  }

  private onBackdropRefractSync = (): void => {
    if (this.backdropSyncRaf) return;
    this.backdropSyncRaf = requestAnimationFrame(() => {
      this.backdropSyncRaf = 0;
      if (!this.destroyed) this.syncBackdropRefraction();
    });
  };

  /** Resolve `backdropSource` to a usable scene element, or null. */
  private resolveBackdropSource(): HTMLElement | null {
    const src = this.options.backdropSource;
    if (!src) return null;
    const el =
      typeof src === 'string'
        ? (this.root as ParentNode).querySelector<HTMLElement>(src)
        : src;
    if (!el || el === this.element || el.contains(this.element)) {
      if (el) {
        console.warn(
          '[liquid-glass] backdropSource must be a separate element behind the glass, not the glass or an ancestor.'
        );
      }
      return null;
    }
    return el;
  }

  private async buildRefractFilter(generation: number): Promise<string | null> {
    const [disp, specularMapUrl] = await Promise.all([
      getDisplacementMap({
        width: this.currentWidth,
        height: this.currentHeight,
        radius: this.computedRadius(),
        thickness: this.computedThickness(),
        pixelRatio: this.displacementDpr(),
        refraction: this.profiledRefraction(),
      }),
      this.options.specular ? this.specularMapUrl() : Promise.resolve(null),
    ]);
    if (!this.isBuildCurrent(generation)) return null;
    this.filter?.destroy();
    this.filter = new FilterChain({
      refraction: this.effectiveRefraction(),
      chromaticAberration: this.effectiveChromatic(),
      blur: this.effectiveBlur(),
      saturation: this.options.saturation,
      width: this.currentWidth,
      height: this.currentHeight,
      displacementMapUrl: disp.url,
      displacementPadding: disp.padding,
      specularMapUrl,
      root: this.root,
    });
    return this.filter.url;
  }

  private setLayerFilter(layer: HTMLElement, url: string): void {
    (layer.style as CSSStyleDeclaration & { webkitFilter?: string }).webkitFilter = url;
    layer.style.filter = url;
  }

  private dropOwnBackdrop(): void {
    this.element.style.backdropFilter = 'none';
    (this.element.style as WebkitStyle).webkitBackdropFilter = 'none';
  }

  private removeFallbackFx(): void {
    if (this.sceneLens) {
      this.sceneLens.destroy();
      this.sceneLens = null;
    }
    window.removeEventListener(
      'scroll',
      this.onBackdropRefractSync,
      { capture: true } as EventListenerOptions
    );
    window.removeEventListener('resize', this.onBackdropRefractSync);
    if (this.backdropSyncRaf) {
      cancelAnimationFrame(this.backdropSyncRaf);
      this.backdropSyncRaf = 0;
    }
    this.refractClone = null;
    this.backdropSceneEl = null;
    this.backdropMode = null;
    this.fxLayer?.remove();
    this.fxLayer = null;
  }

  private specularMapUrl(): Promise<string> {
    return getSpecularMap({
      width: this.currentWidth,
      height: this.currentHeight,
      radius: this.computedRadius(),
      thickness: this.computedThickness(),
      pixelRatio: this.specularDpr(),
      intensity: this.profiledSpecularIntensity(),
    });
  }

  private setupLazy(): void {
    this.unsubLazyIntersection = observeElementIntersection(
      this.element,
      (entry) => {
        const visible = entry.isIntersecting;
        if (this.destroyed || this.suspended) return;
        if (visible) {
          if (!this.filter) {
            // First reveal: time-slice the map build so several boxes scrolling
            // into view at once don't block the scroll.
            this.scheduleBuild(() => this.installFilter());
          } else {
            const css = this.scrollSafeCssForMode(this.scrollSafeMode);
            this.element.style.backdropFilter = css;
            (this.element.style as WebkitStyle).webkitBackdropFilter = css;
          }
        } else {
          // Off-screen: don't build a filter we won't show, and drop the GPU
          // cost of any built one (keep it for a cheap re-attach on return).
          this.cancelPendingBuild();
          if (this.filter) {
            this.element.style.backdropFilter = 'none';
            (this.element.style as WebkitStyle).webkitBackdropFilter = 'none';
          }
        }
      },
      { rootMargin: this.options.lazyMargin }
    );
  }

  private effectiveChromatic(): number {
    // Only the 'high' tier pays for the 3-pass chromatic split.
    return this.quality === 'high' ? this.options.chromaticAberration : 0;
  }

  /**
   * Refraction is an inward displacement in px. The lensing lives in the rim
   * band, so if the displacement grows larger than that band, the backdrop
   * mapping folds back on itself and the fold reads as a hard caustic outline
   * just inside the edge (the "inner rectangle"). To stay a clean lens we cap the
   * displacement to the rim band width — Apple's lensing is bounded by the
   * material's thickness, not arbitrarily strong. Also capped to a fraction of
   * the short side so tiny controls stay coherent.
   */
  private effectiveRefraction(): number {
    const isBar = this.resolveOpticalProfile() === 'bar';
    const sideCap = Math.min(this.currentWidth, this.currentHeight) * (isBar ? 1.5 : 0.78);
    return Math.min(this.profiledRefraction(), sideCap);
  }

  /**
   * Backdrop blur is an absolute stdDeviation, so a fixed value looks stronger
   * on a short element (a nav bar) than on a regular card. Treat a 200px-short
   * surface as the reference and scale shorter controls down automatically,
   * while still preserving a small amount of frost on tiny pills.
   */
  private effectiveBlur(): number {
    const short = Math.min(this.currentWidth, this.currentHeight);
    const tuning = this.opticalTuning();
    const preset = this.presetTuning();
    const sizeScale = Math.max(tuning.minBlurScale, Math.min(1, short / tuning.blurReferenceShortSide));
    const cap = short * 0.14;
    const blur = Math.min(this.options.blur * tuning.blur * preset.blur * sizeScale, cap);
    // A Gaussian backdrop blur's GPU cost grows with its radius; cap it tighter
    // on mobile where backdrop-filter is re-run every scroll frame.
    return IS_MOBILE ? Math.min(blur * 0.85, 9) : blur;
  }

  /**
   * The displacement map is a smooth gradient that feImage bilinear-upscales to
   * the element box, so it can render well below 1× with no visible loss. Keep
   * the default output around 0.3×; the map is supersampled before downscale, so
   * the rim stays smooth while canvas area / encode work drops aggressively.
   */
  private displacementDpr(): number {
    // The lens is a smooth field and the maps are supersampled+downscaled (so
    // low output resolutions stay anti-aliased), letting us render the texture
    // small — ~0.3× at the default mapPixelRatio — which cuts the per-frame
    // backdrop-filter sampling cost with no visible stair-stepping.
    const dpr =
      this.options.mapPixelRatio *
      (IS_MOBILE ? MOBILE_DISPLACEMENT_DPR_SCALE : DESKTOP_DISPLACEMENT_DPR_SCALE);
    return IS_MOBILE ? Math.min(dpr, MOBILE_DISPLACEMENT_DPR_CAP) : dpr;
  }

  /**
   * The specular rim stays sharper than the displacement map, but mobile can
   * sample it lower; the rim is screen-blended and supersampled before encode.
   */
  private specularDpr(): number {
    const dpr =
      this.options.mapPixelRatio *
      (IS_MOBILE ? MOBILE_SPECULAR_DPR_SCALE : DESKTOP_SPECULAR_DPR_SCALE);
    return IS_MOBILE ? Math.min(dpr, MOBILE_SPECULAR_DPR_CAP) : dpr;
  }

  private async installFilter(): Promise<void> {
    if (this.suspended) return;
    this.cancelPendingBuild(); // a direct install supersedes any queued one
    const generation = this.buildGeneration;
    const [disp, specularMapUrl] = await Promise.all([
      getDisplacementMap({
        width: this.currentWidth,
        height: this.currentHeight,
        radius: this.computedRadius(),
        thickness: this.computedThickness(),
        pixelRatio: this.displacementDpr(),
        refraction: this.profiledRefraction(),
      }),
      this.options.specular
        ? getSpecularMap({
            width: this.currentWidth,
            height: this.currentHeight,
            radius: this.computedRadius(),
            thickness: this.computedThickness(),
            pixelRatio: this.specularDpr(),
            intensity: this.profiledSpecularIntensity(),
          })
        : Promise.resolve(null),
    ]);
    if (!this.isBuildCurrent(generation)) return;

    this.filter?.destroy();
    this.filter = new FilterChain({
      refraction: this.effectiveRefraction(),
      chromaticAberration: this.effectiveChromatic(),
      blur: this.effectiveBlur(),
      saturation: this.options.saturation,
      width: this.currentWidth,
      height: this.currentHeight,
      displacementMapUrl: disp.url,
      displacementPadding: disp.padding,
      specularMapUrl,
      root: this.root,
    });

    const css = this.scrollSafeCssForMode(this.scrollSafeMode);
    this.element.style.backdropFilter = css;
    (this.element.style as WebkitStyle).webkitBackdropFilter = css;
  }

  private rebuild(): void {
    this.cancelPendingBuild();
    this.filter?.destroy();
    this.filter = null;
    this.removeFallbackFx();
    this.removeScrollSafeTransitionLayer();
    this.teardownGpu();
    this.usesFallback = this.shouldFallback();
    if (this.usesFallback && !this.reducedTransparency && !this.suspended && this.tryInstallGpu()) {
      this.usesGpu = true;
    } else if (this.usesFallback) {
      this.applyFallback();
    } else if (!this.suspended) {
      this.installFilter();
    }
    this.refreshScrollSafeSubscription();
  }

  /**
   * Re-derive everything size-dependent after a resize (window/orientation/DPR/
   * layout). Debounced and routed by the active path so a resizing element stays
   * correct in every environment:
   *   • GPU   → refresh the shared-canvas box (new map at the new size);
   *   • frost → re-apply the profiled CSS blur + rebuild the specular overlay;
   *   • native→ regenerate the displacement/specular maps and live filter attrs.
   */
  private scheduleRegen(): void {
    if (this.destroyed) return;
    if (this.regenTimer !== null) clearTimeout(this.regenTimer);
    this.regenTimer = window.setTimeout(() => {
      void this.regenerateAfterResize();
    }, RESIZE_DEBOUNCE_MS);
  }

  private async regenerateAfterResize(): Promise<void> {
    this.regenTimer = null;
    if (this.destroyed || this.suspended) return;

    if (this.usesGpu) {
      this.gpuHandle?.refresh();
      this.refreshScrollSafeSubscription();
      return;
    }
    if (this.usesFallback) {
      // Re-apply the size-scaled frost (and rebuild the specular overlay).
      this.applyFallback();
      this.adaptToBackdrop();
      this.refreshScrollSafeSubscription();
      return;
    }
    if (!this.filter) return;
    const generation = ++this.buildGeneration;
    const [disp, specUrl] = await Promise.all([
      getDisplacementMap({
        width: this.currentWidth,
        height: this.currentHeight,
        radius: this.computedRadius(),
        thickness: this.computedThickness(),
        pixelRatio: this.displacementDpr(),
        refraction: this.profiledRefraction(),
      }),
      this.options.specular
        ? getSpecularMap({
            width: this.currentWidth,
            height: this.currentHeight,
            radius: this.computedRadius(),
            thickness: this.computedThickness(),
            pixelRatio: this.specularDpr(),
            intensity: this.profiledSpecularIntensity(),
          })
        : Promise.resolve(null),
    ]);
    if (!this.isBuildCurrent(generation) || !this.filter) return;
    this.filter.updateDisplacement(disp.url, this.currentWidth, this.currentHeight, disp.padding);
    // Blur and refraction are size-dependent (capped to the short side) — re-apply.
    this.filter.updateBlur(this.effectiveBlur());
    this.filter.updateRefraction(this.effectiveRefraction());
    if (specUrl) {
      this.filter.updateSpecular(specUrl, this.currentWidth, this.currentHeight);
    }
    this.adaptToBackdrop();
    this.refreshScrollSafeSubscription();
  }

  private applyTint(): void {
    const tint = this.options.tint ?? this.variantTint();
    // On the GPU path the shader applies the tint; the element stays a
    // transparent window. Otherwise the element background carries the tint.
    this.element.style.backgroundColor = this.usesGpu ? 'transparent' : tint;
    this.element.dataset.scheme = this.resolveScheme();
    // Mark adaptive elements so the stylesheet can flip the label color to keep
    // it legible against the resolved appearance (dark text on light glass,
    // light text on dark glass).
    if (this.options.scheme === 'adaptive') this.element.dataset.adaptive = '';
    if (this.usesGpu) this.gpuHandle?.refresh(); // tint/scheme changed → re-upload uniforms
    this.applyEdges();
  }

  /**
   * The edge is defined OPTICALLY — by lensing and the light-responsive specular
   * rim ("Liquid Glass defines itself through lensing … bends, shapes and
   * concentrates light"), NOT by a drawn white outline. So the inset border is
   * just a whisper baseline (so a bare element still reads over a flat backdrop),
   * plus a profile-scaled float shadow that is also backdrop-aware: Apple's glass
   * "is aware of what's behind it and increases the opacity of its shadow when it
   * is over text … lowers it over a solid light background."
   */
  private applyEdges(): void {
    if (!this.options.edges) return;
    const dark = this.resolveScheme() === 'dark';
    const s = this.opticalTuning().shadow;
    const oy = (4 * s).toFixed(1);
    const blur = (12 * s).toFixed(1);
    // Depth scales with the profile; opacity also follows the backdrop (more over
    // dark/busy content, less over a solid light background) via shadowAdapt.
    const baseAlpha = dark ? 0.22 : 0.085;
    const alpha = Math.min(
      dark ? 0.44 : 0.2,
      baseAlpha * Math.pow(s, 0.7) * this.shadowAdapt
    ).toFixed(3);
    const float = dark
      ? `0 ${oy}px ${blur}px rgba(0, 0, 0, ${alpha})`
      : `0 ${oy}px ${blur}px rgba(20, 24, 46, ${alpha})`;
    // Whisper-thin baseline border + a faint top sheen — the bright edge itself
    // comes from the baked specular rim and the pointer-tracked light.
    const inset = dark
      ? 'inset 0 0 0 0.5px rgba(255,255,255,0.07), inset 0 1.5px 2px rgba(255,255,255,0.1), inset 0 -3px 6px rgba(0,0,0,0.16)'
      : 'inset 0 0 0 0.5px rgba(255,255,255,0.1), inset 0 1.5px 2px rgba(255,255,255,0.18), inset 0 -3px 6px rgba(0,0,0,0.06)';
    this.element.style.boxShadow = `${inset}, ${float}`;
  }

  /**
   * Adapt to the content behind the element by sampling its backdrop luminance
   * (one sample drives both effects):
   *  - content-aware SHADOW: darker/busier content casts a deeper shadow for
   *    separation, a solid light background a fainter one;
   *  - adaptive SCHEME (`scheme: 'adaptive'`): Apple's glass "automatically
   *    adapts to what's beneath it" — a light appearance over dark content, a
   *    dark one over light content, so it stays legible.
   * Resolvable solid backgrounds adapt; gradients/images fall back to neutral.
   */
  private adaptToBackdrop(forceSample = false): void {
    if (this.reducedTransparency) return;
    const lum = this.sampleBackdropLuminance(forceSample);

    if (this.options.edges) {
      const next = lum == null ? 1 : 1.4 - lum * 0.8; // dark→1.4, light→0.6
      if (Math.abs(next - this.shadowAdapt) >= 0.03) {
        this.shadowAdapt = next;
        this.applyEdges();
      }
    }

    if (this.options.scheme === 'adaptive') {
      let next: 'light' | 'dark' | null;
      // Match the backdrop (like iOS controls): a light appearance over light
      // content (with dark labels), a dark appearance over dark content (light
      // labels). The label flip is handled by the [data-adaptive] CSS.
      if (lum == null) next = null; // can't read backdrop → fall back to OS
      else if (lum >= 0.55) next = 'light'; // light backdrop → light glass
      else if (lum <= 0.45) next = 'dark'; // dark backdrop → dark glass
      else next = this.resolvedAdaptiveScheme; // hysteresis band — keep current
      if (next !== this.resolvedAdaptiveScheme) {
        this.resolvedAdaptiveScheme = next;
        this.applyTint(); // re-resolves scheme → tint, dataset, edges
      }
    }
  }

  private onWindowResize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    if (Math.abs(dpr - this.lastDpr) < 0.01) return; // size changes handled by ResizeObserver
    this.lastDpr = dpr;
    this.scheduleRegen();
  };

  private onElementResize = (entry: ResizeObserverEntry): void => {
    const box = entry.borderBoxSize?.[0];
    const width = box ? box.inlineSize : entry.contentRect.width;
    const height = box ? box.blockSize : entry.contentRect.height;
    if (
      Math.abs(width - this.currentWidth) < 0.5 &&
      Math.abs(height - this.currentHeight) < 0.5
    ) {
      return;
    }
    this.currentWidth = Math.max(1, width);
    this.currentHeight = Math.max(1, height);
    if (this.options.applyRadius) {
      this.element.style.borderRadius = `${this.computedRadius()}px`;
    }
    this.scheduleRegen();
  };

  private onBackdropScroll = (): void => {
    if (!this.destroyed) this.adaptToBackdrop();
  };

  private sampleBackdropLuminance(force = false): number | null {
    const r = this.element.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const bucket = IS_MOBILE ? 24 : 12;
    const key = [
      Math.round(r.left / bucket),
      Math.round(r.top / bucket),
      Math.round(r.width / bucket),
      Math.round(r.height / bucket),
      window.innerWidth,
      window.innerHeight,
    ].join(':');
    if (!force && key === this.backdropSampleKey && now - this.backdropSampleAt < BACKDROP_SAMPLE_INTERVAL_MS) {
      return this.backdropSampleLum;
    }
    const pts: [number, number][] = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + 8, r.top + 8],
      [r.right - 8, r.bottom - 8],
    ];
    const prevPE = this.element.style.pointerEvents;
    this.element.style.pointerEvents = 'none';
    let total = 0;
    let n = 0;
    for (const [x, y] of pts) {
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
      for (const el of document.elementsFromPoint(x, y)) {
        if (el === this.element || this.element.contains(el)) continue;
        const lum = parseBgLuminance(getComputedStyle(el).backgroundColor);
        if (lum != null) {
          total += lum;
          n++;
          break;
        }
      }
    }
    this.element.style.pointerEvents = prevPE;
    const lum = n ? total / n : null;
    this.backdropSampleKey = key;
    this.backdropSampleAt = now;
    this.backdropSampleLum = lum;
    return lum;
  }

  private variantTint(): string {
    const scheme = this.resolveScheme();
    return VARIANT_TINT[this.options.variant][scheme];
  }

  private resolveScheme(): 'light' | 'dark' {
    const s = this.options.scheme;
    if (s === 'light' || s === 'dark') return s;
    // adaptive resolves from the sampled backdrop; until sampled (or unreadable)
    // it falls back to OS auto, same as 'auto'.
    if (s === 'adaptive' && this.resolvedAdaptiveScheme) return this.resolvedAdaptiveScheme;
    if (typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'light';
  }

  private computedRadius(): number {
    return Math.min(
      this.options.radius,
      Math.min(this.currentWidth, this.currentHeight) / 2
    );
  }

  /** Rim band, capped under half the short side so small pills keep lens volume. */
  private computedThickness(): number {
    const isBar = this.resolveOpticalProfile() === 'bar';
    const cap = Math.min(this.currentWidth, this.currentHeight) * (isBar ? 0.85 : 0.46);
    return Math.max(
      2,
      Math.min(this.options.thickness * this.opticalTuning().thickness * this.presetTuning().thickness, cap)
    );
  }

  private profiledRefraction(): number {
    return this.options.refraction * this.opticalTuning().refraction * this.presetTuning().refraction;
  }

  private profiledSpecularIntensity(): number {
    return Math.max(
      0,
      this.options.specularIntensity * this.opticalTuning().specular * this.presetTuning().specular
    );
  }

  private opticalTuning(): OpticalTuning {
    return OPTICAL_PROFILE[this.resolveOpticalProfile()];
  }

  private opticalTuningFor(profile: LiquidGlassOpticalProfile): OpticalTuning {
    return OPTICAL_PROFILE[profile === 'auto' ? this.resolveAutoOpticalProfile() : profile];
  }

  private presetTuning(): PresetTuning {
    return this.presetTuningFor(this.options.preset, this.options.profile);
  }

  private presetTuningFor(
    preset: LiquidGlassMaterialPreset,
    profile: LiquidGlassOpticalProfile
  ): PresetTuning {
    return MATERIAL_PRESET[preset === 'auto' ? this.resolveAutoMaterialPreset(profile) : preset];
  }

  private resolveAutoMaterialPreset(
    profile: LiquidGlassOpticalProfile
  ): Exclude<LiquidGlassMaterialPreset, 'auto'> {
    const resolvedProfile = profile === 'auto' ? this.resolveAutoOpticalProfile() : profile;
    if (resolvedProfile === 'control' || resolvedProfile === 'selection') return 'vivid';
    return 'balanced';
  }

  private resolveMaterialPreset(): Exclude<LiquidGlassMaterialPreset, 'auto'> {
    return this.options.preset === 'auto'
      ? this.resolveAutoMaterialPreset(this.options.profile)
      : this.options.preset;
  }

  private resolveOpticalProfile(): Exclude<LiquidGlassOpticalProfile, 'auto'> {
    return this.options.profile === 'auto' ? this.resolveAutoOpticalProfile() : this.options.profile;
  }

  private resolveAutoOpticalProfile(): Exclude<LiquidGlassOpticalProfile, 'auto'> {
    const className =
      typeof this.element.className === 'string' ? this.element.className.toLowerCase() : '';
    return resolveLiquidGlassAutoProfile({
      tagName: this.element.tagName,
      role: this.element.getAttribute('role'),
      ariaLabel: this.element.getAttribute('aria-label'),
      className,
      textLength: this.element.textContent?.trim().length ?? 0,
      buttonCount: this.element.querySelectorAll('button,[role="button"]').length,
      linkCount: this.element.querySelectorAll('a[href]').length,
      inputCount: this.element.querySelectorAll('input,select,textarea,[role="slider"]').length,
      width: this.currentWidth,
      height: this.currentHeight,
      radius: this.computedRadius(),
    });
  }

  private resolve(opts: LiquidGlassOptions): ResolvedOptions {
    const r = opts.radius;
    let radius: number;
    if (r === 'pill') {
      radius = 9999;
    } else if (r === 'auto' || r === undefined) {
      const cs = getComputedStyle(this.element);
      const parsed = parseFloat(cs.borderTopLeftRadius);
      radius = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OPTIONS.radius;
    } else {
      radius = r;
    }

    const variant = opts.variant ?? DEFAULT_OPTIONS.variant;

    return {
      radius,
      thickness: opts.thickness ?? DEFAULT_OPTIONS.thickness,
      refraction: opts.refraction ?? DEFAULT_OPTIONS.refraction,
      chromaticAberration: opts.chromaticAberration ?? DEFAULT_OPTIONS.chromaticAberration,
      blur: opts.blur ?? VARIANT_BLUR[variant],
      saturation: opts.saturation ?? DEFAULT_OPTIONS.saturation,
      variant,
      profile: opts.profile ?? DEFAULT_OPTIONS.profile,
      preset: opts.preset ?? DEFAULT_OPTIONS.preset,
      scheme: opts.scheme ?? DEFAULT_OPTIONS.scheme,
      tint: opts.tint ?? null,
      specular: opts.specular ?? DEFAULT_OPTIONS.specular,
      specularIntensity: opts.specularIntensity ?? DEFAULT_OPTIONS.specularIntensity,
      edges: opts.edges ?? DEFAULT_OPTIONS.edges,
      refractBackground: opts.refractBackground ?? DEFAULT_OPTIONS.refractBackground,
      backdropSource: opts.backdropSource ?? DEFAULT_OPTIONS.backdropSource,
      applyRadius: opts.applyRadius ?? DEFAULT_OPTIONS.applyRadius,
      mapPixelRatio: opts.mapPixelRatio ?? DEFAULT_OPTIONS.mapPixelRatio,
      quality: opts.quality ?? DEFAULT_OPTIONS.quality,
      // On mobile, default to lazy so off-screen glass tears its filter down —
      // only what's on screen costs GPU during scroll. Explicit `lazy` wins.
      lazy: opts.lazy ?? (IS_MOBILE ? true : DEFAULT_OPTIONS.lazy),
      lazyMargin: opts.lazyMargin ?? DEFAULT_OPTIONS.lazyMargin,
      root: opts.root ?? DEFAULT_OPTIONS.root,
      fallbackFilter: opts.fallbackFilter ?? DEFAULT_OPTIONS.fallbackFilter,
      respectReducedMotion: opts.respectReducedMotion ?? DEFAULT_OPTIONS.respectReducedMotion,
      rimPosition: opts.rimPosition ?? DEFAULT_OPTIONS.rimPosition,
    };
  }

  private optionsAsInput(): LiquidGlassOptions {
    const o = this.options;
    return {
      radius: o.radius,
      thickness: o.thickness,
      refraction: o.refraction,
      chromaticAberration: o.chromaticAberration,
      blur: o.blur,
      saturation: o.saturation,
      variant: o.variant,
      profile: o.profile,
      preset: o.preset,
      scheme: o.scheme,
      tint: o.tint ?? undefined,
      specular: o.specular,
      specularIntensity: o.specularIntensity,
      edges: o.edges,
      refractBackground: o.refractBackground ?? undefined,
      backdropSource: o.backdropSource ?? undefined,
      applyRadius: o.applyRadius,
      mapPixelRatio: o.mapPixelRatio,
      quality: o.quality,
      lazy: o.lazy,
      lazyMargin: o.lazyMargin,
      root: o.root ?? undefined,
      fallbackFilter: o.fallbackFilter,
      respectReducedMotion: o.respectReducedMotion,
      rimPosition: o.rimPosition,
    };
  }
}
