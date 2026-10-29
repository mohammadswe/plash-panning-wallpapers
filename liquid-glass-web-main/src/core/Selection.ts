/**
 * LiquidSelection — a selection indicator that fluidly glides between items, the
 * way Liquid Glass tab bars / segmented controls move the active highlight.
 * "Glass flows smoothly" between states; the selected item is a tinted capsule
 * that springs to the chosen item rather than cutting.
 *
 * Attach to a container of items (e.g. a tab bar). It inserts a translucent
 * tinted capsule behind the items and animates it to the active one.
 */

export interface LiquidSelectionOptions {
  /** Items to select between — elements, or a CSS selector within the container. */
  items: HTMLElement[] | string;
  /** Index selected initially. Default 0. */
  initial?: number;
  /** Capsule tint (CSS color). Default a soft white. */
  tint?: string;
  /** Called when the selection changes (also fires for programmatic select). */
  onChange?: (index: number, item: HTMLElement) => void;
}

const SPRING = 'cubic-bezier(0.34, 1.4, 0.5, 1)';

export class LiquidSelection {
  readonly container: HTMLElement;
  readonly items: HTMLElement[];
  private indicator: HTMLDivElement;
  private index = -1;
  private anim: Animation | null = null;
  private reduceMotion: boolean;
  private onChange?: (index: number, item: HTMLElement) => void;

  constructor(container: HTMLElement, options: LiquidSelectionOptions) {
    this.container = container;
    this.items =
      typeof options.items === 'string'
        ? Array.from(container.querySelectorAll<HTMLElement>(options.items))
        : options.items;
    this.onChange = options.onChange;
    this.reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

    this.indicator = document.createElement('div');
    Object.assign(this.indicator.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      borderRadius: '9999px',
      background: options.tint ?? 'rgba(255, 255, 255, 0.18)',
      boxShadow: 'inset 0 0 0 0.5px rgba(255, 255, 255, 0.25)',
      pointerEvents: 'none',
      zIndex: '0',
      willChange: 'transform, width',
    } satisfies Partial<CSSStyleDeclaration>);
    container.insertBefore(this.indicator, container.firstChild);

    // Items sit above the indicator.
    for (const it of this.items) {
      if (getComputedStyle(it).position === 'static') it.style.position = 'relative';
      it.style.zIndex = '1';
      it.addEventListener('click', () => this.select(this.items.indexOf(it)));
    }

    this.select(options.initial ?? 0, true);
  }

  get selectedIndex(): number {
    return this.index;
  }

  select(index: number, instant = false): void {
    const item = this.items[index];
    if (!item) return;
    const changed = index !== this.index;
    this.index = index;

    const x = item.offsetLeft;
    const y = item.offsetTop;
    const w = item.offsetWidth;
    const h = item.offsetHeight;
    const toTransform = `translate(${x}px, ${y}px)`;
    const toW = `${w}px`;
    const toH = `${h}px`;

    this.anim?.cancel();
    if (instant || this.reduceMotion) {
      this.indicator.style.transform = toTransform;
      this.indicator.style.width = toW;
      this.indicator.style.height = toH;
    } else {
      const fromTransform = this.indicator.style.transform || toTransform;
      const fromW = this.indicator.style.width || toW;
      const fromH = this.indicator.style.height || toH;
      this.anim = this.indicator.animate(
        [
          { transform: fromTransform, width: fromW, height: fromH },
          { transform: toTransform, width: toW, height: toH },
        ],
        { duration: 460, easing: SPRING, fill: 'forwards' }
      );
      this.indicator.style.transform = toTransform;
      this.indicator.style.width = toW;
      this.indicator.style.height = toH;
    }

    for (let i = 0; i < this.items.length; i++) {
      this.items[i].classList.toggle('lg-selected', i === index);
    }
    if (changed) this.onChange?.(index, item);
  }

  destroy(): void {
    this.anim?.cancel();
    this.indicator.remove();
  }
}
