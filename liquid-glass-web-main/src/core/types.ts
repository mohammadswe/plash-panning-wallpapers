export type LiquidGlassVariant = 'regular' | 'clear' | 'tinted';
/**
 * 'auto' follows the OS color scheme. 'adaptive' follows the CONTENT behind the
 * element — Apple's Liquid Glass "automatically adapts to what's beneath it":
 * over dark content it takes a light appearance, over light content a dark one,
 * so it stays legible. Falls back to OS auto when the backdrop can't be read.
 */
export type LiquidGlassScheme = 'light' | 'dark' | 'auto' | 'adaptive';
export type LiquidGlassQuality = 'high' | 'balanced' | 'low' | 'auto';
/**
 * Semantic optical context for the glass. Apple doesn't expose numeric blur or
 * refraction constants; system components adapt the material based on role,
 * size, interaction, and legibility needs. These profiles encode that behavior
 * for the web renderer.
 */
export type LiquidGlassOpticalProfile =
  | 'auto'
  | 'bar'
  | 'control'
  | 'card'
  | 'panel'
  | 'selection';

/**
 * Material intensity preset layered on top of the semantic profile. `auto`
 * chooses a good default for the resolved profile.
 */
export type LiquidGlassMaterialPreset = 'auto' | 'subtle' | 'balanced' | 'vivid' | 'dramatic';

export interface LiquidGlassOptions {
  /** Corner radius in px. 'pill' = height/2. 'auto' reads current computed border-radius. Default: 'auto'. */
  radius?: number | 'auto' | 'pill';
  /** Reference lens depth in px. The selected profile scales this value. Default: 44. */
  thickness?: number;
  /** Reference edge refraction in px. The selected profile scales and caps this value. Default: 46. */
  refraction?: number;
  /** Chromatic dispersion (0–1). Pulls R/G/B apart at the edges. Default: 0.03. */
  chromaticAberration?: number;
  /** Reference backdrop blur in px. The selected variant and profile scale this value. */
  blur?: number;
  /** Saturation boost as %. 100 = neutral. Default: 150. */
  saturation?: number;
  /**
   * Variant. Apple defines Regular and Clear; `tinted` is kept as a legacy
   * compatibility shortcut. Prefer `variant: 'regular'` plus `tint`.
   * Default: 'regular'.
   */
  variant?: LiquidGlassVariant;
  /**
   * Optical profile. Keep 'auto' for Apple-style context adaptation: navigation
   * bars stay visually quiet, compact controls get stronger lensing, and larger
   * panels prioritize legibility. Explicit profiles are useful for custom
   * controls.
   * Default: 'auto'.
   */
  profile?: LiquidGlassOpticalProfile;
  /**
   * Material intensity preset. `auto` lets the engine choose based on the
   * resolved profile; use explicit presets for product-specific art direction.
   * Default: 'auto'.
   */
  preset?: LiquidGlassMaterialPreset;
  /** Color scheme. Default: 'auto'. */
  scheme?: LiquidGlassScheme;
  /** Optional explicit tint, overrides variant. CSS color. */
  tint?: string;
  /** Specular (edge light) enabled. Default: true. */
  specular?: boolean;
  /** Specular peak intensity (0–1). Default: 0.5. */
  specularIntensity?: number;
  /**
   * Apply the glass edge treatment inline (scheme-aware box-shadow): a crisp
   * bright rim hairline, a broad inner top glow that lifts the body, a subtle
   * bottom-lip highlight for thickness, and a soft cool float shadow. This is
   * what makes a bare element read as Liquid Glass without extra CSS. Set false
   * to manage box-shadow yourself. Default: true.
   */
  edges?: boolean;
  /**
   * Opt-in real lensing for the non-Chromium fallback (Safari/Firefox). Those
   * engines can't run an SVG filter inside `backdrop-filter`, so the arbitrary
   * backdrop can't be refracted. But if you tell the engine what's behind the
   * glass — a CSS background value identical to the page's FIXED background
   * (image or gradient) — it places a copy of that background inside the glass
   * and displaces *that* with a regular SVG `filter` (which Safari supports),
   * giving true refraction for that backdrop. Use `background-attachment: fixed`
   * style values; ignored on Chromium (the real backdrop is already refracted).
   * Example: `refractBackground: 'url(/hero.jpg) center/cover fixed'`.
   */
  refractBackground?: string;
  /**
   * Chromium-level refraction in ALL THREE engines, sourced from a designated
   * "scene" element behind the glass (a map, photo, video, gradient panel — any
   * discrete element the glass floats over). Pass the element or a CSS selector.
   * The engine refracts the SAME displacement map against that scene per engine:
   *   • Chromium → its native backdrop-filter (this option is ignored — the real
   *     backdrop is already refracted, live, for free);
   *   • Firefox  → `-moz-element()` renders the live scene as the lens source;
   *   • Safari/other → a position-synced DOM clone of the scene is the source.
   * The scene must NOT be the glass element or an ancestor of it (that would
   * recurse / loop). Re-aligned on scroll & resize. Unlike `refractBackground`
   * (a static CSS background), this refracts real, arbitrary scene content.
   */
  backdropSource?: HTMLElement | string;
  /** Apply the computed radius as the element's border-radius. Default: true. */
  applyRadius?: boolean;
  /** Device-pixel-ratio cap for the displacement map (1–3). Default: 2. */
  mapPixelRatio?: number;
  /** Rim bevel & chromatic aberration position for bar profiles ('top' | 'bottom'). Default: 'top'. */
  rimPosition?: 'top' | 'bottom';

  // ── Production / Chrome-extension knobs ──────────────────────────────────

  /**
   * Quality tier. Controls the expensive bits:
   *   high     — 3-pass chromatic, full map DPR
   *   balanced — single displacement pass (no chromatic), map DPR capped at 1.5
   *   low      — plain CSS backdrop blur+saturate, no SVG filter at all
   *   auto     — picks one from navigator.hardwareConcurrency / deviceMemory
   * Explicit options (e.g. chromaticAberration) still take effect within the
   * tier's ceiling. Default: 'auto'.
   */
  quality?: LiquidGlassQuality;

  /**
   * Defer building the SVG filter until the element first scrolls into view
   * (IntersectionObserver). Off-screen glass then costs nothing. The filter is
   * torn down again when the element leaves the viewport by `lazyMargin`.
   * Default: false.
   */
  lazy?: boolean;

  /** Root-margin for the lazy IntersectionObserver. Default: '200px'. */
  lazyMargin?: string;

  /**
   * Explicit tree scope to inject the shared <svg><defs> into. Normally
   * auto-detected from the element's getRootNode() so it works inside a Shadow
   * DOM (Chrome-extension content scripts). Pass this only to override.
   */
  root?: Document | ShadowRoot;

  /**
   * CSS backdrop-filter used when SVG-in-backdrop-filter is unsupported
   * (Safari/Firefox) or quality resolves to 'low'. Default:
   * 'blur(12px) saturate(1.6)'.
   */
  fallbackFilter?: string;

  /**
   * Honor prefers-reduced-transparency / prefers-reduced-motion by falling
   * back to a cheaper opaque-ish style. Default: true.
   */
  respectReducedMotion?: boolean;
}

export interface ResolvedOptions {
  radius: number;
  thickness: number;
  refraction: number;
  chromaticAberration: number;
  blur: number;
  saturation: number;
  variant: LiquidGlassVariant;
  profile: LiquidGlassOpticalProfile;
  preset: LiquidGlassMaterialPreset;
  scheme: LiquidGlassScheme;
  tint: string | null;
  specular: boolean;
  specularIntensity: number;
  edges: boolean;
  refractBackground: string | null;
  backdropSource: HTMLElement | string | null;
  applyRadius: boolean;
  mapPixelRatio: number;
  quality: LiquidGlassQuality;
  lazy: boolean;
  lazyMargin: string;
  root: Document | ShadowRoot | null;
  fallbackFilter: string;
  respectReducedMotion: boolean;
  rimPosition: 'top' | 'bottom';
}

export interface LiquidGlassResolvedState {
  profile: Exclude<LiquidGlassOpticalProfile, 'auto'>;
  preset: Exclude<LiquidGlassMaterialPreset, 'auto'>;
  variant: LiquidGlassVariant;
  scheme: 'light' | 'dark';
  radius: number;
  thickness: number;
  refraction: number;
  blur: number;
  saturation: number;
  specularIntensity: number;
  tint: string;
  usesFallback: boolean;
  quality: Exclude<LiquidGlassQuality, 'auto'>;
  width: number;
  height: number;
}
