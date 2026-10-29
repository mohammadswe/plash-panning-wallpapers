/**
 * Shared LRU-ish cache for generated displacement + specular textures. Two
 * glass elements at the same size/radius/thickness reuse the same encoded URL
 * promise — the pixel loops only run once. Bounded to keep memory predictable.
 */

import {
  generateDisplacementMap,
  type DisplacementMapParams,
  type DisplacementMapResult,
} from './DisplacementMap';
import { generateSpecularMap, type SpecularMapParams } from './SpecularMap';

const MAX_ENTRIES = 64;
const displacementCache = new Map<string, Promise<DisplacementMapResult>>();
const specularCache = new Map<string, Promise<string>>();

function bucketForPixelRatio(pixelRatio: number): number {
  return pixelRatio <= 0.6 ? 8 : 4;
}

function quantize(value: number, bucket: number): number {
  return Math.max(bucket, Math.round(value / bucket) * bucket);
}

function trim<V>(map: Map<string, V>): void {
  while (map.size > MAX_ENTRIES) {
    const firstKey = map.keys().next().value;
    if (firstKey === undefined) break;
    map.delete(firstKey);
  }
}

function bump<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
}

function dispKey(p: DisplacementMapParams): string {
  const bucket = bucketForPixelRatio(p.pixelRatio);
  return `d:${quantize(p.width, bucket)}x${quantize(p.height, bucket)}_r${quantize(p.radius, 2)}_t${quantize(p.thickness, 2)}_p${p.pixelRatio.toFixed(3)}_f${quantize(p.refraction, 2)}`;
}

function specKey(p: SpecularMapParams): string {
  const bucket = bucketForPixelRatio(p.pixelRatio);
  return `s:${quantize(p.width, bucket)}x${quantize(p.height, bucket)}_r${quantize(p.radius, 2)}_t${quantize(p.thickness, 2)}_p${p.pixelRatio.toFixed(3)}_i${p.intensity.toFixed(2)}`;
}

export function getDisplacementMap(params: DisplacementMapParams): Promise<DisplacementMapResult> {
  const key = dispKey(params);
  const cached = displacementCache.get(key);
  if (cached !== undefined) {
    bump(displacementCache, key, cached);
    return cached;
  }
  const value = generateDisplacementMap(params);
  displacementCache.set(key, value);
  trim(displacementCache);
  return value;
}

export function getSpecularMap(params: SpecularMapParams): Promise<string> {
  const key = specKey(params);
  const cached = specularCache.get(key);
  if (cached !== undefined) {
    bump(specularCache, key, cached);
    return cached;
  }
  const value = generateSpecularMap(params);
  specularCache.set(key, value);
  trim(specularCache);
  return value;
}

export function clearMapCache(): void {
  displacementCache.clear();
  specularCache.clear();
}
