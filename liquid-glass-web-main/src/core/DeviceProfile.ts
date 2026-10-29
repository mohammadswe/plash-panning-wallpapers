import type { LiquidGlassOpticalProfile, LiquidGlassQuality } from './types';

export interface LiquidGlassAutoQualityInput {
  mobile?: boolean;
  android?: boolean;
  hoverNone?: boolean;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  devicePixelRatio?: number;
  visibleGlassCount?: number;
  profile?: LiquidGlassOpticalProfile;
  width?: number;
  height?: number;
}

function userAgent(): string {
  return typeof navigator !== 'undefined' ? navigator.userAgent : '';
}

export function isLiquidGlassAndroid(): boolean {
  return /Android/i.test(userAgent());
}

export function isLiquidGlassMobileLike(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  return nav.userAgentData?.mobile === true || /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent);
}

export function isLiquidGlassHoverless(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(hover: none)').matches
  );
}

function currentHardwareConcurrency(): number {
  return typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 4 : 4;
}

function currentDeviceMemory(): number {
  return typeof navigator !== 'undefined'
    ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4
    : 4;
}

function currentDevicePixelRatio(): number {
  return typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
}

/**
 * Conservative auto quality policy. It never sniffs Tensor/Pixel model names;
 * it reacts to the real pressure signals that make Android Chrome jank:
 * touch/mobile compositing, high DPR, limited memory/cores, large surfaces and
 * many visible glass filters competing for the same frame budget.
 */
export function resolveLiquidGlassAutoQuality(
  input: LiquidGlassAutoQualityInput = {}
): Exclude<LiquidGlassQuality, 'auto'> {
  const mobile = input.mobile ?? isLiquidGlassMobileLike();
  const cores = input.hardwareConcurrency ?? currentHardwareConcurrency();
  const memory = input.deviceMemory ?? currentDeviceMemory();
  const dpr = input.devicePixelRatio ?? currentDevicePixelRatio();
  const visible = input.visibleGlassCount ?? 1;

  if (!mobile) {
    return cores <= 4 || memory <= 4 ? 'balanced' : 'high';
  }

  let pressure = 0;
  if (input.android ?? isLiquidGlassAndroid()) pressure += 1;
  if (input.hoverNone ?? isLiquidGlassHoverless()) pressure += 1;
  if (memory <= 3) pressure += 3;
  else if (memory <= 4) pressure += 2;
  else if (memory <= 6) pressure += 1;
  if (cores <= 4) pressure += 2;
  else if (cores <= 6) pressure += 1;
  if (dpr >= 3) pressure += 1.5;
  else if (dpr >= 2.5) pressure += 1;
  if (visible >= 24) pressure += 2;
  else if (visible >= 14) pressure += 1;

  const profile = input.profile === 'auto' ? undefined : input.profile;
  const area = Math.max(0, input.width ?? 0) * Math.max(0, input.height ?? 0);
  if ((profile === 'card' || profile === 'panel') && visible >= 14) pressure += 1;
  if (area >= 140_000 && visible >= 8) pressure += 1;

  return pressure >= 7 ? 'low' : 'balanced';
}
