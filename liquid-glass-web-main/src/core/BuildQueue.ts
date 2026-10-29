/**
 * Time-sliced build scheduler.
 *
 * Generating the displacement / specular maps (a Canvas2D pixel loop plus an
 * image encode) is the one blocking cost in this engine. When many glass
 * elements initialize at once — e.g. `autoEnhance()` over 30 boxes on load —
 * doing it all synchronously freezes the main thread for hundreds of ms and the
 * page janks. Instead each element enqueues its build here and the queue runs a
 * bounded time-slice per frame, so the main thread stays responsive and the
 * glass "materializes" over a few frames instead of one long stall.
 *
 * Cached (repeat-size) builds are near-instant, so they drain immediately; only
 * the genuinely expensive first-of-a-size builds get spread out.
 */

type BuildTask = () => void | Promise<void>;

const queue: BuildTask[] = [];
let scheduled = false;

/** Main-thread budget per slice (ms). Small enough to keep input responsive. */
const SLICE_MS = 6;

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function pump(): void {
  scheduled = false;
  const start = nowMs();
  // Always run at least one task so progress is guaranteed even if a single
  // build exceeds the slice.
  do {
    const task = queue.shift();
    if (!task) break;
    try {
      void Promise.resolve(task()).catch(() => {
        /* one async build failure must not stall the queue */
      });
    } catch {
      /* one bad build must not stall the queue */
    }
  } while (queue.length && nowMs() - start < SLICE_MS);
  if (queue.length) schedule();
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => pump(), { timeout: 250 });
  } else if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => pump());
  } else {
    setTimeout(pump, 16);
  }
}

/**
 * Enqueue a build task. Returns a cancel function that removes it if it hasn't
 * run yet (call it from `destroy()` / before a re-build).
 */
export function enqueueBuild(task: BuildTask): () => void {
  queue.push(task);
  schedule();
  return () => {
    const i = queue.indexOf(task);
    if (i >= 0) queue.splice(i, 1);
  };
}
