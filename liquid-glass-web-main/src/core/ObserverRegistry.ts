type ResizeCallback = (entry: ResizeObserverEntry) => void;
type IntersectionCallback = (entry: IntersectionObserverEntry) => void;

let resizeObserver: ResizeObserver | null = null;
const resizeTargets = new Map<Element, Set<ResizeCallback>>();

export function observeElementResize(
  element: Element,
  callback: ResizeCallback
): (() => void) | null {
  if (typeof ResizeObserver === 'undefined') return null;
  if (!resizeObserver) {
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const callbacks = resizeTargets.get(entry.target);
        if (!callbacks) continue;
        for (const fn of callbacks) fn(entry);
      }
    });
  }

  let callbacks = resizeTargets.get(element);
  if (!callbacks) {
    callbacks = new Set();
    resizeTargets.set(element, callbacks);
    resizeObserver.observe(element, { box: 'border-box' });
  }
  callbacks.add(callback);

  return () => {
    const active = resizeTargets.get(element);
    if (!active) return;
    active.delete(callback);
    if (active.size === 0) {
      resizeTargets.delete(element);
      resizeObserver?.unobserve(element);
    }
  };
}

interface IntersectionGroup {
  observer: IntersectionObserver;
  targets: Map<Element, Set<IntersectionCallback>>;
}

const intersectionGroups = new Map<string, IntersectionGroup>();

export function observeElementIntersection(
  element: Element,
  callback: IntersectionCallback,
  options: IntersectionObserverInit = {}
): (() => void) | null {
  if (typeof IntersectionObserver === 'undefined') return null;
  const key = intersectionKey(options);
  let group = intersectionGroups.get(key);
  if (!group) {
    const targets = new Map<Element, Set<IntersectionCallback>>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const callbacks = targets.get(entry.target);
        if (!callbacks) continue;
        for (const fn of callbacks) fn(entry);
      }
    }, options);
    group = { observer, targets };
    intersectionGroups.set(key, group);
  }

  let callbacks = group.targets.get(element);
  if (!callbacks) {
    callbacks = new Set();
    group.targets.set(element, callbacks);
    group.observer.observe(element);
  }
  callbacks.add(callback);

  return () => {
    const active = group?.targets.get(element);
    if (!active || !group) return;
    active.delete(callback);
    if (active.size === 0) {
      group.targets.delete(element);
      group.observer.unobserve(element);
    }
    if (group.targets.size === 0) {
      group.observer.disconnect();
      intersectionGroups.delete(key);
    }
  };
}

function intersectionKey(options: IntersectionObserverInit): string {
  const rootMargin = options.rootMargin ?? '0px';
  const threshold = Array.isArray(options.threshold)
    ? options.threshold.join(',')
    : options.threshold ?? 0;
  return `${rootMargin}|${threshold}`;
}
