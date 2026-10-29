import { requestDisplacementMap } from './MapWorkerClient';
import {
  rasterizeDisplacementMap,
  type DisplacementMapParams,
  type DisplacementMapResult,
} from './MapRaster';

export type { DisplacementMapParams, DisplacementMapResult } from './MapRaster';

export function generateDisplacementMap(
  params: DisplacementMapParams
): Promise<DisplacementMapResult> {
  const workerResult = requestDisplacementMap(params);
  return workerResult?.catch(() => rasterizeDisplacementMap(params)) ?? rasterizeDisplacementMap(params);
}
