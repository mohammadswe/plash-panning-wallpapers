import {
  rasterizeDisplacementMap,
  rasterizeSpecularMap,
  type DisplacementMapParams,
  type DisplacementMapResult,
  type SpecularMapParams,
} from './MapRaster';

type MapWorkerRequest =
  | { id: number; kind: 'displacement'; params: DisplacementMapParams }
  | { id: number; kind: 'specular'; params: SpecularMapParams };

type MapWorkerResponse =
  | { id: number; ok: true; result: DisplacementMapResult | string }
  | { id: number; ok: false; error: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<MapWorkerRequest>) => void) | null;
  postMessage: (message: MapWorkerResponse) => void;
};

scope.onmessage = (event: MessageEvent<MapWorkerRequest>) => {
  void handleMessage(event.data);
};

async function handleMessage(message: MapWorkerRequest): Promise<void> {
  try {
    const result =
      message.kind === 'displacement'
        ? await rasterizeDisplacementMap(message.params)
        : await rasterizeSpecularMap(message.params);
    scope.postMessage({ id: message.id, ok: true, result });
  } catch (error) {
    scope.postMessage({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export {};
