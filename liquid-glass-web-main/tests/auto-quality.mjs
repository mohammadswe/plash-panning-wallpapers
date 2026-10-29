import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/core/DeviceProfile.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`;
const { resolveLiquidGlassAutoQuality } = await import(moduleUrl);

const cases = [
  [
    'desktop with enough memory resolves to high',
    { mobile: false, hardwareConcurrency: 8, deviceMemory: 8 },
    'high',
  ],
  [
    'desktop with limited memory resolves to balanced',
    { mobile: false, hardwareConcurrency: 8, deviceMemory: 4 },
    'balanced',
  ],
  [
    'single Android glass stays balanced',
    {
      mobile: true,
      android: true,
      hoverNone: true,
      hardwareConcurrency: 8,
      deviceMemory: 8,
      devicePixelRatio: 2.75,
      visibleGlassCount: 1,
      profile: 'card',
      width: 360,
      height: 180,
    },
    'balanced',
  ],
  [
    'many visible Android card surfaces preserve balanced refraction with good headroom',
    {
      mobile: true,
      android: true,
      hoverNone: true,
      hardwareConcurrency: 8,
      deviceMemory: 8,
      devicePixelRatio: 2.75,
      visibleGlassCount: 10,
      profile: 'card',
      width: 360,
      height: 180,
    },
    'balanced',
  ],
  [
    'weak high-DPR Android device resolves to low even with fewer surfaces',
    {
      mobile: true,
      android: true,
      hoverNone: true,
      hardwareConcurrency: 4,
      deviceMemory: 4,
      devicePixelRatio: 3,
      visibleGlassCount: 4,
      profile: 'panel',
      width: 360,
      height: 420,
    },
    'low',
  ],
  [
    'many mobile control surfaces avoid low when device headroom is good',
    {
      mobile: true,
      android: false,
      hoverNone: true,
      hardwareConcurrency: 8,
      deviceMemory: 8,
      devicePixelRatio: 2,
      visibleGlassCount: 9,
      profile: 'control',
      width: 96,
      height: 44,
    },
    'balanced',
  ],
];

for (const [name, input, expected] of cases) {
  assert.equal(resolveLiquidGlassAutoQuality(input), expected, name);
}

console.log(`auto quality tests passed (${cases.length})`);
