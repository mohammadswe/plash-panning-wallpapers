import { requestSpecularMap } from './MapWorkerClient';
import { rasterizeSpecularMap, type SpecularMapParams } from './MapRaster';

export type { SpecularMapParams } from './MapRaster';

export function generateSpecularMap(params: SpecularMapParams): Promise<string> {
  const workerResult = requestSpecularMap(params);
  return workerResult?.catch(() => rasterizeSpecularMap(params)) ?? rasterizeSpecularMap(params);
}
