import type { LiquidGlassOpticalProfile } from './types';

export interface LiquidGlassAutoProfileInput {
  tagName?: string;
  role?: string | null;
  ariaLabel?: string | null;
  className?: string | null;
  textLength?: number;
  buttonCount?: number;
  linkCount?: number;
  inputCount?: number;
  width: number;
  height: number;
  radius: number;
}

export function resolveLiquidGlassAutoProfile(
  input: LiquidGlassAutoProfileInput
): Exclude<LiquidGlassOpticalProfile, 'auto'> {
  const semantic = resolveSemanticProfile(input);
  if (semantic) return semantic;

  const short = Math.min(input.width, input.height);
  const long = Math.max(input.width, input.height);
  const aspect = long / Math.max(1, short);
  const radiusRatio = input.radius / Math.max(1, short);
  const textLength = input.textLength ?? 0;

  if (short <= 92 && radiusRatio > 0.42 && (textLength <= 32 || long <= 360)) return 'control';
  if (short <= 88 && aspect >= 4.5) return 'bar';
  if (short <= 92 && (radiusRatio > 0.42 || textLength <= 18)) return 'control';
  if (short >= 260 || (input.width * input.height > 140_000 && aspect < 4)) return 'panel';
  return 'card';
}

function resolveSemanticProfile(
  input: LiquidGlassAutoProfileInput
): Exclude<LiquidGlassOpticalProfile, 'auto'> | null {
  const tag = input.tagName?.toLowerCase() ?? '';
  const role = input.role?.toLowerCase() ?? '';
  const ariaLabel = input.ariaLabel?.toLowerCase() ?? '';
  const className = input.className?.toLowerCase() ?? '';
  const controlCount = (input.buttonCount ?? 0) + (input.inputCount ?? 0);
  const linkCount = input.linkCount ?? 0;
  const short = Math.min(input.width, input.height);
  const radiusRatio = input.radius / Math.max(1, short);

  if (
    role === 'tablist' ||
    ariaLabel.includes('tab') ||
    className.includes('tabbar') ||
    className.includes('segmented')
  ) {
    return 'selection';
  }
  if (
    tag === 'button' ||
    role === 'button' ||
    role === 'switch' ||
    role === 'slider' ||
    role === 'checkbox' ||
    role === 'radio'
  ) {
    return 'control';
  }
  if (hasAnyToken(className, ['chip', 'tag', 'badge', 'pill', 'button', 'btn', 'control'])) {
    return 'control';
  }
  if (
    hasAnyToken(className, ['action', 'cta']) &&
    (short <= 104 || radiusRatio > 0.36)
  ) {
    return 'control';
  }
  if (
    (ariaLabel.includes('chip') || ariaLabel.includes('tag') || ariaLabel.includes('badge')) &&
    short <= 112
  ) {
    return 'control';
  }
  if (tag === 'nav' && controlCount >= 2 && linkCount === 0) return 'selection';
  if (
    tag === 'header' ||
    tag === 'nav' ||
    tag === 'footer' ||
    role === 'navigation' ||
    role === 'toolbar' ||
    role === 'banner'
  ) {
    return 'bar';
  }
  if (
    tag === 'aside' ||
    role === 'dialog' ||
    role === 'menu' ||
    role === 'menubar' ||
    role === 'listbox' ||
    role === 'complementary' ||
    className.includes('sheet') ||
    className.includes('popover') ||
    className.includes('menu') ||
    className.includes('panel')
  ) {
    return 'panel';
  }
  if (
    tag === 'article' ||
    tag === 'section' ||
    className.includes('card') ||
    className.includes('widget') ||
    className.includes('notification')
  ) {
    return 'card';
  }
  return null;
}

function hasAnyToken(value: string, tokens: string[]): boolean {
  if (!value) return false;
  const parts = value.split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some((token) => parts.includes(token));
}
