/**
 * autoEnhance — the one-call entry point for declarative usage.
 *
 * Mark elements in your HTML and let the engine wire them up, instead of
 * `new LiquidGlass(...)` for each by hand:
 *
 *   <nav  data-liquid-glass='{"profile":"bar"}'>…</nav>
 *   <button class="lg-interactive"
 *           data-liquid-glass='{"radius":"pill"}'>Save</button>
 *
 *   import { autoEnhance } from 'liquid-glass-web';
 *   const glass = autoEnhance();               // scans the document
 *   glass.get(nav)?.update({ blur: 10 });      // reach an instance later
 *
 * The attribute value is the JSON `LiquidGlassOptions` for that element (an
 * empty attribute means "use the defaults"). Elements matching
 * `interactiveSelector` additionally get the pointer-tilt / press behaviour.
 */

import { LiquidGlass } from './LiquidGlass';
import { LiquidInteractive } from './Interactive';
import { isLiquidGlassMobileLike } from './DeviceProfile';
import type { LiquidGlassOptions } from './types';

export interface AutoEnhanceOptions {
  /** Scope to scan. Default `document`. Pass a Shadow root for content scripts. */
  root?: ParentNode;
  /** Attribute carrying the per-element JSON options. Default `data-liquid-glass`. */
  attribute?: string;
  /**
   * Selector (within `root`) whose matches also get `LiquidInteractive`
   * (pointer tilt, jelly press). Default `.lg-interactive`; pass `false` to
   * skip interactivity entirely.
   */
  interactiveSelector?: string | false;
  /** Options merged UNDER each element's own attribute config. */
  defaults?: LiquidGlassOptions;
  /** Called instead of throwing when an element's JSON fails to parse. */
  onError?: (element: HTMLElement, error: unknown) => void;
}

export interface LiquidGlassRegistry {
  /** Every enhanced element mapped to its `LiquidGlass` instance. */
  readonly instances: Map<HTMLElement, LiquidGlass>;
  /** The `LiquidInteractive` instances that were attached. */
  readonly interactives: LiquidInteractive[];
  /** Look up the instance for an element. */
  get(element: HTMLElement): LiquidGlass | undefined;
  /** Destroy every glass instance and clear the registry. */
  destroy(): void;
}

/**
 * Scan `root` for `[attribute]` elements, build a `LiquidGlass` for each from
 * its JSON options, attach `LiquidInteractive` to `interactiveSelector` matches,
 * and return a registry you can query and tear down. Already-enhanced elements
 * (same attribute seen twice) are skipped, so it is safe to call again after
 * adding markup.
 */
export function autoEnhance(options: AutoEnhanceOptions = {}): LiquidGlassRegistry {
  const root = options.root ?? document;
  const attribute = options.attribute ?? 'data-liquid-glass';
  const interactiveSelector =
    options.interactiveSelector === undefined ? '.lg-interactive' : options.interactiveSelector;
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(`[${attribute}]`));
  const mobileDefaults: LiquidGlassOptions =
    isLiquidGlassMobileLike() && candidates.length >= 12 ? { lazy: true, lazyMargin: '80px' } : {};

  const instances = new Map<HTMLElement, LiquidGlass>();
  for (const el of candidates) {
    if (instances.has(el)) continue;
    let config: LiquidGlassOptions = {};
    const raw = el.getAttribute(attribute);
    if (raw) {
      try {
        config = JSON.parse(raw) as LiquidGlassOptions;
      } catch (error) {
        if (options.onError) {
          options.onError(el, error);
        } else {
          // Surface bad markup without aborting the whole sweep.
          console.warn('[liquid-glass] invalid', attribute, 'JSON on', el, error);
        }
        continue;
      }
    }
    instances.set(el, new LiquidGlass(el, { ...mobileDefaults, ...options.defaults, ...config }));
  }

  const interactives: LiquidInteractive[] = [];
  if (interactiveSelector) {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(interactiveSelector))) {
      interactives.push(new LiquidInteractive(el));
    }
  }

  return {
    instances,
    interactives,
    get: (element) => instances.get(element),
    destroy() {
      for (const glass of instances.values()) glass.destroy();
      instances.clear();
    },
  };
}
