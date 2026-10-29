import assert from 'node:assert/strict';
import { resolveLiquidGlassAutoProfile } from '../dist/liquid-glass.js';

const cases = [
  ['header tag resolves to bar', { tagName: 'header', width: 960, height: 52, radius: 26 }, 'bar'],
  ['navigation role resolves to bar', { role: 'navigation', width: 720, height: 56, radius: 28 }, 'bar'],
  ['button tag resolves to control', { tagName: 'button', width: 108, height: 44, radius: 999 }, 'control'],
  ['slider role resolves to control', { role: 'slider', width: 240, height: 44, radius: 22 }, 'control'],
  ['tablist role resolves to selection', { role: 'tablist', width: 280, height: 64, radius: 999 }, 'selection'],
  [
    'button-only nav resolves to selection',
    { tagName: 'nav', width: 300, height: 64, radius: 999, buttonCount: 4, linkCount: 0 },
    'selection',
  ],
  ['dialog role resolves to panel', { role: 'dialog', width: 460, height: 320, radius: 34 }, 'panel'],
  ['aside tag resolves to panel', { tagName: 'aside', width: 320, height: 720, radius: 24 }, 'panel'],
  ['article tag resolves to card', { tagName: 'article', width: 360, height: 200, radius: 28 }, 'card'],
  ['card class resolves to card', { className: 'feature-card', width: 360, height: 180, radius: 28 }, 'card'],
  ['long short geometry resolves to bar', { width: 900, height: 52, radius: 26, textLength: 64 }, 'bar'],
  ['small pill geometry resolves to control', { width: 96, height: 40, radius: 20, textLength: 8 }, 'control'],
  ['wide chip class resolves to control', { className: 'stack-chip', width: 320, height: 52, radius: 999, textLength: 26 }, 'control'],
  ['cta anchor class resolves to control', { tagName: 'a', className: 'primary-action', width: 240, height: 64, radius: 999, textLength: 18 }, 'control'],
  ['badge aria label resolves to control', { ariaLabel: 'status badge', width: 132, height: 44, radius: 22, textLength: 20 }, 'control'],
  ['large block geometry resolves to panel', { width: 480, height: 340, radius: 32, textLength: 200 }, 'panel'],
  ['medium block geometry resolves to card', { width: 360, height: 180, radius: 28, textLength: 80 }, 'card'],
];

for (const [name, input, expected] of cases) {
  assert.equal(resolveLiquidGlassAutoProfile(input), expected, name);
}

console.log(`auto profile tests passed (${cases.length})`);
