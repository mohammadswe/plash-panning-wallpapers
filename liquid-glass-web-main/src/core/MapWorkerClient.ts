import type {
  DisplacementMapParams,
  DisplacementMapResult,
  SpecularMapParams,
} from './MapRaster';

type MapWorkerRequest =
  | { id: number; kind: 'displacement'; params: DisplacementMapParams }
  | { id: number; kind: 'specular'; params: SpecularMapParams };

type MapWorkerResponse =
  | { id: number; ok: true; result: DisplacementMapResult | string }
  | { id: number; ok: false; error: string };

type PendingRequest = {
  resolve: (result: DisplacementMapResult | string) => void;
  reject: (error: Error) => void;
};

const MAX_WORKER_FAILURES = 2;

let worker: Worker | null = null;
let sequence = 0;
let workerFailures = 0;
const pending = new Map<number, PendingRequest>();

function canUseMapWorker(): boolean {
  return (
    workerFailures < MAX_WORKER_FAILURES &&
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined'
  );
}

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (!canUseMapWorker()) return null;

  try {
    worker = new Worker(new URL('./MapWorker.ts', import.meta.url), {
      type: 'module',
      name: 'liquid-glass-map-worker',
    });
    worker.onmessage = (event: MessageEvent<MapWorkerResponse>) => {
      const message = event.data;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.ok) request.resolve(message.result);
      else request.reject(new Error(message.error));
    };
    worker.onerror = () => {
      workerFailures++;
      rejectPending(new Error('[liquid-glass] map worker failed'));
      disposeWorker();
    };
    worker.onmessageerror = () => {
      workerFailures++;
      rejectPending(new Error('[liquid-glass] map worker message failed'));
      disposeWorker();
    };
  } catch {
    workerFailures++;
    worker = null;
  }

  return worker;
}

function rejectPending(error: Error): void {
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}

function disposeWorker(): void {
  worker?.terminate();
  worker = null;
}

function requestMap<T extends DisplacementMapResult | string>(
  message: Omit<MapWorkerRequest, 'id'>
): Promise<T> | null {
  const activeWorker = ensureWorker();
  if (!activeWorker) return null;

  const id = ++sequence;
  const request = { ...message, id } as MapWorkerRequest;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: (result) => resolve(result as T),
      reject,
    });
    try {
      activeWorker.postMessage(request);
    } catch (error) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export function requestDisplacementMap(
  params: DisplacementMapParams
): Promise<DisplacementMapResult> | null {
  return requestMap<DisplacementMapResult>({ kind: 'displacement', params });
}

export function requestSpecularMap(params: SpecularMapParams): Promise<string> | null {
  return requestMap<string>({ kind: 'specular', params });
}
