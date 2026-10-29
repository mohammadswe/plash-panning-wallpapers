# liquid-glass-web

Apple-style **Liquid Glass** for the web. Real optical refraction via SVG
`feDisplacementMap`, baked specular rim, Chromium-native `backdrop-filter`.

Zero WebGL contexts, zero `requestAnimationFrame` loops per instance — everything
is composited by the browser GPU pipeline.

**▶ Live demo: https://meapri.github.io/liquid-glass-web/**

## Contents

- [Approach](#approach) — how the optical model works
- [Install](#install) — add it to a project
- [Quick start](#quick-start) — declarative (`autoEnhance`) and imperative
- [Options](#options) — the full `LiquidGlassOptions` table
- [Instance API](#instance-api) — `update` / `suspend` / `syncToBackdrop` / …
- [Adaptive appearance](#adaptive-appearance) — auto light/dark from the backdrop
- [Optical profiles](#optical-profiles) · [Material presets](#material-presets) · [Quality tiers](#quality-tiers)
- [Motion & transitions](#motion--transitions) — interactive, menus, sheets, selections
- [Performance](#performance-notes) · [Chrome extensions](#use-in-a-chrome-extension) · [Browser support](#browser-support)

## Approach

- **Context-adaptive lensing** (Snell's law), the way Apple describes Liquid
  Glass — it *"dynamically bends, shapes, and concentrates light in real time"*
  with *"responsive lensing along its edges"* (Meet Liquid Glass, WWDC25). The
  rim is a **convex roundover** — a quarter-ellipse `h = B·√(1 − (1 − t)²)` over a
  band of width `thickness`, near-vertical at the very edge and flat on the
  interior plateau. We take that surface normal and refract a straight-down
  viewing ray through the air→glass interface (n = 1.5) with the GLSL `refract()`
  formula; the lateral shift is the displacement. The surface is **one smooth
  lens**, not a rim band: the displacement increases *monotonically* from zero at
  the exact centre to its maximum at the edge (a C∞ `(1−u²)(1−v²)` field shaped
  by an exponent so the middle stays nearly flat — "letting content shine through
  underneath it" — and the bend ramps up only near the rim). Because it is
  monotonic there is **no inner ring**: nowhere does the bend stop, so no rounded
  rectangle is ever drawn inside the glass. Smooth everywhere ⇒ no diagonal "X"
  crease on any shape. The map is padded so the rim can sample backdrop beyond
  the box ("samples content from an area larger than itself"); the backdrop is
  blurred *before* it's bent so refraction over text stays clean.
- **Padded displacement canvas** (`±refraction` px on each side) so the rim
  can sample real backdrop beyond the element box without clipping.
- **Liquid Glass-style optical profiles** — the best result is not one global
  blur/refraction value. This library ships semantic profiles tuned for a vivid
  web Liquid Glass look: `bar` keeps navigation and toolbars dissolved but
  readable, `control` gives buttons and sliders stronger lensing,
  `selection` lifts active tab/segmented capsules, and `panel`/`card` prioritize
  legibility on larger surfaces. `profile: 'auto'` infers from semantic tags,
  ARIA roles, size, and aspect ratio.
- **Three-pass chromatic aberration** — R / G / B channels run through
  feDisplacementMap at slightly different scales (blue refracts more than red,
  matching glass physics).
- **Geometry-driven specular rim** PNG — Apple's *"highlights that respond to
  geometry … causing light to travel around the material, defining its
  silhouette."* Computed from the exact rounded-rect edge (SDF) in a thin rim
  band: a bright primary arc where the edge faces the key light (top), a thin
  continuous highlight tracing the whole silhouette, and a soft secondary catch
  on the opposite edge. Screen-blended inside the filter — no per-frame JS. It
  hugs the crisp edge so the glass reads as a defined shape, while the refraction
  lens stays a smooth bend — the clear interior emits no light.
- **Context-aware edge treatment** — bars use a soft dissolved hairline, while
  compact controls and selections keep more visible glass border artwork and
  gloss. The profiles are tuned so the material reads as glass without making
  every surface look like the same button.
- **Pointer-tracked edge light (core, all glass)** — Apple's environment light
  "travels around the material, defining its silhouette" and reacts as you
  approach. A single shared `PointerField` (one rAF-coalesced `pointermove`)
  feeds every glass element `--lg-pointer-x/y` plus a proximity `--lg-glow`;
  `.liquid-glass::after` paints a crisp bright segment of the rim that follows
  the cursor and **fades in by distance** (it lights up from ~220px away, not
  only on direct hover), masked to a 1.5px border so only the edge lights up.
- **Motion, designed as one with the look** — Apple's official motion:
  **interaction illumination** — on press the glow blooms from under the finger,
  *"spreads throughout the element and onto any Liquid Glass elements nearby"*
  (the core `PointerField` broadcasts the press, so neighbouring glass lights up
  too); a **gel-like flex** squish, 3D parallax tilt and lift-on-touch
  (`.lg-interactive`); and **materialize in/out** (`.lg-materialize` /
  `.lg-dematerialize`) that springs the scale/lensing rather than fading. Honors
  `prefers-reduced-motion` (drops the elastic motion, keeps the light).
- **Morph transitions** — `LiquidMenu` summons a menu that flexes and **flows out
  of its trigger** (thicker glass as it grows — deeper shadow + more lensing),
  and `LiquidSheet` **materializes a sheet up from the bottom** over a dimming
  scrim. Both collapse back on dismiss and honor reduced motion. *"Presenting a
  menu from a toolbar button … as glass morphs to larger sizes it casts deeper,
  richer shadows, has more pronounced lensing and refraction."*
- **Tasteful depth** — a soft, diffuse cool float shadow and a gentle inner top
  sheen give the glass volume (a lozenge floating above content), without the
  hard embossed look of a raised button.
- **Shared `MapCache` + Worker rasterization** — same-sized elements reuse the
  same encoded maps, and supported browsers move fresh map pixel loops off the
  main thread via `OffscreenCanvas` in a module Worker.

## Install

```bash
npm install            # in this repo
npm run dev            # demo at http://localhost:5173
npm run build          # bundle the demo into dist-demo/
npm run build:lib      # bundle the library into dist/
```

The library is framework-agnostic and ships ESM + UMD builds plus type
definitions (`dist/index.d.ts`). Import from `liquid-glass-web` once published,
or from `./src` inside this repo.

## Quick start

### Declarative — `autoEnhance` (recommended)

Mark elements in your HTML and let the engine wire them up in one call. The
`data-liquid-glass` attribute holds that element's JSON
[options](#options) (empty = defaults); anything matching `.lg-interactive`
also gets the pointer-tilt / press motion.

```html
<nav class="lg-nav" data-liquid-glass='{"profile":"bar","radius":"pill"}'>…</nav>

<button class="lg-interactive"
        data-liquid-glass='{"radius":"pill","preset":"vivid"}'>Save</button>
```

```ts
import { autoEnhance } from 'liquid-glass-web';

const glass = autoEnhance();             // scans the document
glass.get(document.querySelector('.lg-nav')!)?.update({ blur: 10 });
// glass.instances — Map<HTMLElement, LiquidGlass>
// glass.destroy() — tear every instance down
```

`autoEnhance({ root, attribute, interactiveSelector, defaults, onError })` lets
you scope to a Shadow root, rename the attribute, opt out of interactivity
(`interactiveSelector: false`), or set options that apply under every element.
On mobile pages with many glass elements, `autoEnhance()` tightens the lazy
margin automatically so off-screen filters do not prebuild too early.

### Imperative — `new LiquidGlass`

For full control, construct instances directly:

```ts
import { LiquidGlass, LiquidInteractive } from 'liquid-glass-web';

// Initialize the core refraction engine. Defaults are profile-aware.
const bar = new LiquidGlass(document.querySelector('.tab-bar')!, {
  radius: 'pill',
  profile: 'bar',   // dissolved navigation material
  thickness: 44,    // reference lens depth; profile scales it
  refraction: 46,   // reference lensing; profile scales and caps it
  variant: 'regular',
});

bar.update({ blur: 10 });   // live patch
bar.suspend();              // drop the GPU filter while hidden
bar.resume();               // re-attach instantly

// Auto-bind the pointer-tracked edge light (+ parallax tilt, jelly press)
LiquidInteractive.initAll();
```

## Options

| option | default | meaning |
| --- | --- | --- |
| `radius` | `'auto'` | px, `'pill'`, or `'auto'` (reads computed border-radius) |
| `thickness` | `44` | reference lens depth in px; the selected profile scales it. Deeper ⇒ more pronounced lensing when appropriate. |
| `refraction` | `46` | reference displacement in px; the selected profile scales it and caps it to the element size. |
| `chromaticAberration` | `0.03` | 0–1; subtle RGB fringing at the rim (kept low so the body stays clean) |
| `blur` | per-variant | reference backdrop frost stdDeviation, applied before refraction; default by variant (`regular` 7, `clear` 3, legacy `tinted` 14). Profiles and size scale this down for bars and compact controls. |
| `saturation` | `150` | % saturation applied after displacement (Apple keeps the backdrop close to neutral, not over-vivid) |
| `variant` | `'regular'` | `'regular'` \| `'clear'`; legacy `'tinted'` remains for compatibility. Apple guidance maps prominence through `tint`, not an extra variant. |
| `profile` | `'auto'` | semantic optical context: `'auto'`, `'bar'`, `'control'`, `'card'`, `'panel'`, or `'selection'`. `auto` uses element semantics and geometry. |
| `preset` | `'auto'` | material intensity: `'auto'`, `'subtle'`, `'balanced'`, `'vivid'`, or `'dramatic'`. `auto` chooses `vivid` for controls/selections and `balanced` elsewhere. |
| `scheme` | `'auto'` | `'light'` \| `'dark'` \| `'auto'` (follows the OS) \| `'adaptive'` (follows the content behind it — light glass with dark labels over light backdrops, dark glass with light labels over dark ones, re-sampled on scroll; falls back to OS when the backdrop can't be read) |
| `tint` | — | explicit CSS color for prominence; preferred over `variant:'tinted'` |
| `specular` | `true` | bake the geometry-driven edge light |
| `specularIntensity` | `0.5` | 0–1 |
| `edges` | `true` | inline glass edge treatment (scheme-aware): bright rim hairline, inner top glow, bottom lip, soft float shadow. `false` to style `box-shadow` yourself |
| `mapPixelRatio` | `2` | DPR cap for the generated maps |
| `quality` | `'auto'` | `'high'` \| `'balanced'` \| `'low'` \| `'auto'` — gates the expensive bits (see below) |
| `lazy` | `false` | defer building the filter until the element scrolls into view (IntersectionObserver) |
| `lazyMargin` | `'200px'` | root-margin for the lazy observer |
| `root` | auto | tree scope for the shared `<svg defs>`; auto-detected from `getRootNode()` so it works inside a Shadow DOM |
| `fallbackFilter` | profile-aware | CSS `backdrop-filter` used on non-Chromium / `quality:'low'` / reduced-transparency. Leave unset to derive blur/saturation from the resolved profile; pass a string to override. |
| `refractBackground` | — | opt-in real refraction for the Safari/Firefox fallback: a CSS background equal to the page's *fixed* backdrop, displaced inside the glass via a regular `filter:`. Ignored on Chromium. See [Browser support](#browser-support). |
| `backdropSource` | — | `HTMLElement` or selector for a discrete *scene* element behind the glass. Gives Chromium-level refraction in **all three engines** (Firefox via `-moz-element()`, Safari/others via a position-synced DOM clone, Chromium via its native path). Refracts real, arbitrary scene content. See [Browser support](#browser-support). |
| `respectReducedMotion` | `true` | fall back to the cheap filter when `prefers-reduced-transparency` is set |

## Instance API

| member | description |
| --- | --- |
| `update(partial)` | Patch options live. `blur`, `saturation`, `tint`, `scheme`, `variant` and refraction scale apply as live filter/CSS attributes; map-changing options (`radius`, `thickness`, `profile`, `preset`, specular intensity, refraction padding) regenerate the cached maps. |
| `suspend()` / `resume()` | Cheaply detach / re-attach the GPU filter for show/hide — no pixel work, instance preserved. |
| `syncToBackdrop()` | Re-read the backdrop and re-resolve the content-aware shadow and, for `scheme:'adaptive'`, the light/dark appearance. Call it when the content *behind* a stationary element changes. See [Adaptive appearance](#adaptive-appearance). |
| `flexRefraction(px \| null)` | Live-override the lensing strength in px without rebuilding maps — a per-frame GPU attribute change used by the morph helpers. `null` restores the configured value. |
| `configuredRefraction` | The resolved refraction the morph helpers ramp toward (read-only). |
| `resolved` | The final engine contract (resolved profile/preset/blur/refraction/…), for debugging and design-system tooling. |
| `destroy()` | Remove the filter, inline styles and listeners. |

```ts
const glass = new LiquidGlass(el); // profile:'auto', preset:'auto'
console.log(glass.resolved);
// {
//   profile: 'bar',
//   preset: 'balanced',
//   blur: 4.13,
//   refraction: 20.24,
//   thickness: 16.72,
//   ...
// }
```

## Adaptive appearance

`scheme: 'adaptive'` is Apple's *"automatically adapts to what's beneath it."*
The engine samples the luminance of the content behind the element and resolves
the glass to match, so labels stay legible:

- over **light** content → a **light** glass with **dark** labels
- over **dark** content → a **dark** glass with **light** labels
- backdrop it can't read (gradient/image/transparent) → falls back to OS `auto`

```html
<span class="lg-interactive"
      data-liquid-glass='{"scheme":"adaptive","radius":"pill"}'>Glass</span>
```

The switch **crossfades** (tint, label color and float shadow transition over
~460 ms), so it glides instead of snapping. A `0.45–0.55` luminance hysteresis
band prevents flicker on borderline backdrops.

The element re-samples automatically on layout and on scroll (a passive,
rAF-throttled listener). When the content behind a *stationary* element changes
— a theme swap, a background image finishing load, a recolored hero — call
`syncToBackdrop()` to glide it to the new appearance:

```ts
const g = new LiquidGlass(el, { scheme: 'adaptive' });
document.querySelector('#theme-toggle')!.addEventListener('click', () => {
  swapTheme();
  g.syncToBackdrop();   // re-read backdrop → crossfade if it crossed the threshold
});
```

### Optical profiles

These profiles are the library's tuned web material presets. They keep Liquid
Glass expressive without forcing the same blur/refraction amount onto every
component.

| profile | intended use | behavior |
| --- | --- | --- |
| `bar` | headers, nav bars, toolbars, notification bars | stronger blur/dissolve, restrained lensing, soft rim |
| `control` | independent buttons, chips, tags, badges, switches, sliders, media controls | strongest lensing and gloss; use with bold glyphs/labels |
| `selection` | selected tab capsules, segmented selections | pronounced floating capsule with medium-high lensing |
| `card` | compact cards in the floating functional layer | vivid refraction, balanced frost, readable text |
| `panel` | sheets, menus, sidebars, popovers | more frost and softer lensing for larger readable surfaces |
| `auto` | default | infers from tag/role/class first (`button`, `chip`, `tag`, `badge`, `nav`, `toolbar`, `dialog`, `tablist`, etc.), then from size/aspect ratio |

Avoid applying glass to content-layer elements like ordinary article/list cells.
For controls inside an existing glass surface, use a tint/fill overlay instead
of a second `LiquidGlass` instance.
`destroy()` cleans up the filter and styles.

### Material presets

`profile` decides what the element is; `preset` decides how strongly the glass
reads. Most apps should leave both on `auto`.

| preset | behavior |
| --- | --- |
| `subtle` | reduced blur, rim, and lensing for dense/productivity UI |
| `balanced` | default material strength |
| `vivid` | more convex lensing, gloss, and blur for controls and playful UI |
| `dramatic` | strongest look for hero/media surfaces |
| `auto` | resolves by profile: controls/selections use `vivid`, larger/static surfaces use `balanced` |

### Quality tiers

| tier | displacement | chromatic | map DPR (disp / spec) |
| --- | --- | --- | --- |
| `high` | single or 3-pass | yes | ~0.4 desktop, ~0.3 mobile / ~1.3 desktop, ~0.6 mobile spec |
| `balanced` | single pass | off | ~0.4 desktop, ~0.3 mobile / ~1.3 desktop, ~0.6 mobile spec |
| `low` | none — CSS `fallbackFilter` only | — | — |
| `auto` | desktop picks `high`/`balanced`; mobile keeps SVG refraction at `balanced` for normal Tensor-class headroom and only drops to `low` under severe device pressure | adaptive | adaptive |

The displacement map is a smooth field that `feImage` bilinear-upscales, so the
mobile renderer keeps it around 0.3×. The specular rim is kept higher because it
is a visible hairline, but mobile caps that rim map lower to reduce Tensor-class
GPU and encode pressure. This is where most of the per-instance cost is saved
with little visible change.
On Android Chrome / WebView, `auto` also protects scroll: mobile scroll intent
(`touchstart`/`touchmove`/`wheel`/`scroll`) no longer swaps active glass to CSS
frost, so refraction remains visible while the page moves. Fast wheel/touch
velocity or Long Task pressure keeps adaptive backdrop reads paused a little
longer, then resumes them after scroll idle. If an element ever does return from
frost to SVG, a short frost veil fades away over the SVG filter so the handoff
reads like the glass sharpening instead of snapping.
Explicit `quality` values are left alone.

## Motion & transitions

Apple designed the motion and the look as one. These helpers ship the official
gestures; all of them honor `prefers-reduced-motion` (they drop the elastic
motion but keep the light).

### `LiquidInteractive` — pointer tilt + jelly press

Adds 3D parallax tilt on hover, a gel-like squish on press, and lift-on-touch to
any element. The pointer-tracked **edge light** and **press illumination** are
already core to every `.liquid-glass`; this adds the spatial motion on top.

```ts
LiquidInteractive.initAll();                 // every .lg-interactive
LiquidInteractive.initAll('.my-buttons');    // or a custom selector
new LiquidInteractive(el);                    // a single element
```

CSS-only motion is available without JS: add `.lg-materialize` /
`.lg-dematerialize` to spring an element's scale + lensing in or out (a
materialize, not a fade).

### `LiquidMenu` — menu that morphs out of its trigger

The menu **flows out of the control** and reads thicker as it grows (deeper
shadow, more pronounced lensing). Pass the menu's own `LiquidGlass` instance and
the morph also ramps its refraction from ~0 to full as it materializes.

```ts
const menuGlass = new LiquidGlass(menuEl, { profile: 'panel', radius: 24 });
const menu = new LiquidMenu(triggerEl, menuEl, {
  placement: 'bottom-start',   // see LiquidMenuPlacement
  offset: 10,
  glass: menuGlass,            // enables the lensing ramp during the morph
});
menu.open(); menu.close(); menu.toggle();
```

`LiquidMenuOptions`: `placement`, `offset`, `dismissOnOutside` (default `true`),
`glass`. Works for popovers and iOS long-press context menus alike (same engine,
grouped icon rows).

### `LiquidSheet` — sheet that materializes up from the bottom

A sheet/modal that grows up from the bottom edge over a dimming scrim. The sheet
element should be its own `.liquid-glass`.

```ts
const sheet = new LiquidSheet(sheetEl, { bottomGap: 28 });
sheet.present(); sheet.dismiss(); sheet.toggle();
```

`LiquidSheetOptions`: `dismissOnScrim` (default `true`), `bottomGap` (default
`24`). The scrim only dims (Clear-style transparency needs a darkening layer);
it does not add its own blur, so the sheet isn't buried.

### `LiquidSelection` — gliding selection capsule

A tinted glass capsule that springs between items (tab bars, segmented controls).

```ts
const sel = new LiquidSelection(containerEl, {
  items: '.tab',                       // selector or HTMLElement[]
  initial: 0,
  tint: 'rgba(255, 255, 255, 0.16)',
  onChange: (index, item) => console.log('selected', index, item),
});
sel.select(2);                          // move programmatically
```

## Performance notes

Fresh-instance setup does a Canvas2D map render, then encodes the canvas
asynchronously via `toBlob()`/FileReader so image encoding no longer blocks like
the old synchronous data-URL path. In supported browsers, the remaining pixel
loop runs in a module Worker with `OffscreenCanvas`; if Worker/CSP support is
missing, it falls back to the same rasterizer on the main thread. Once built, the
glass is GPU-composited and a repeat show is free. Measured on a retina (DPR 2)
machine, median per instance:

| scenario | tier | cost |
| --- | --- | --- |
| 360×460 panel, fresh | balanced | ~8 ms |
| 360×460 panel, fresh | high | ~16 ms |
| 120×44 button, fresh | balanced | ~2 ms |
| same-size repeat (MapCache hit) | any | ~0.1 ms |
| `suspend()` → `resume()` | any | ~0 ms |
| static, composited (no scroll) | any | ~0 — GPU |

The expensive map work runs once per near-identical size and is shared through
`MapCache`, so the cost above is paid only on first appearance at a given size
bucket. For many instances, set `lazy: true` so off-screen glass builds nothing
until it scrolls in. Runtime observers are shared across instances, pointer-light
rects are cached between scroll/resize changes, and adaptive backdrop sampling is
throttled during scroll. Mobile scroll-safe mode starts on scroll intent, keeps
the SVG refraction path attached during kinetic scrolling, pauses adaptive
backdrop reads while active, and only resumes that sampling after idle. The optional WebGL
fallback caps its viewport DPR to 1x on Android and 1.25x on other mobile-class
devices to avoid fill-rate spikes.

## Testing and fixtures

```bash
npm test                 # typecheck + auto profile / auto quality resolver tests
npm run test:auto-profile
```

Minimal visual fixtures live in `fixtures/`:

- `fixtures/bar.html`
- `fixtures/control.html`
- `fixtures/card.html`
- `fixtures/panel.html`
- `fixtures/selection.html`

They are intentionally smaller than the demo and are meant for visual regression
screenshots or quick manual inspection of each material profile.

## Use in a Chrome extension

The engine is framework-agnostic and has no `chrome.*` dependencies, so it drops
into a content script. For a content-script UI (e.g. a translation panel) the
defaults that matter:

```ts
// inside your Shadow DOM host (root is auto-detected from getRootNode())
const glass = new LiquidGlass(panelEl, {
  quality: 'auto',       // mobile may fall back to CSS frost under pressure
  radius: 16,
  refraction: 16,
  blur: 6,
});

// show / hide the panel without rebuilding the GPU filter:
glass.suspend();  // text deselected → drop GPU cost, keep the instance
glass.resume();   // shown again → instant
```

- **Shadow DOM** — `backdrop-filter: url(#id)` resolves the filter id against the
  element's own tree scope, so the shared `<svg defs>` is injected into the same
  Shadow root automatically. No setup needed; pass `root` only to override.
- **auto** is the recommended tier in a content script: it keeps balanced
  refraction on normal Android/Tensor-class pages and reserves the cheaper frost
  path for severe device pressure. Use explicit `low` only when scroll budget is
  more important than visible lensing.
- **Resizing panels** (variable translation length) regenerate the maps, debounced
  ~80 ms; at the balanced tier each rebuild is ~8 ms and same heights are cached.

## Browser support

**Full lensing — Chromium.** Real refraction of an arbitrary backdrop needs an
SVG `feDisplacementMap` running *inside* `backdrop-filter`, and only Chromium
supports SVG filter references there. There is also no web API to read the
composited backdrop pixels, so the lensing can't be reproduced manually in
WebGL/Canvas for arbitrary content. So on Chromium you get the complete material.

**Safari / Firefox — enhanced fallback.** These engines can't run an SVG filter
in `backdrop-filter`, so the *arbitrary-backdrop* lens is unavailable. But
everything else is — and the fallback now ships it, because it's all plain
CSS/JS, not the SVG filter:

- frosted `backdrop-filter: blur() saturate()` (profile-aware), plus tint;
- the baked **specular rim** PNG, screen-blended as an overlay (the crisp light
  edge the filter would have added);
- the pointer-tracked **edge light** and press **illumination**;
- **adaptive** light/dark (`scheme:'adaptive'`) + content-aware shadow;
- all of [Motion & transitions](#motion--transitions).

So Safari reads as Liquid Glass — only the literal backdrop lens-distortion is
missing.

**Opt-in real refraction in Safari — `refractBackground`.** When the backdrop is
a layer you control (a fixed hero image or gradient), tell the engine what it is
and it gets true lensing even in Safari: a copy of that background is placed
inside the glass and displaced by the same map via a regular `filter:` (which
WebKit supports).

```ts
new LiquidGlass(el, {
  // a CSS background identical to the page's FIXED background
  refractBackground: 'url(/hero.jpg) center/cover fixed',
});
```

Use `background-attachment: fixed` values so the replicated copy lines up with
the real page background. Ignored on Chromium (the real backdrop is already
refracted). You can preview this path on any browser by forcing the fallback
with `quality: 'low'` (see the "Safari path" card in the demo).

**The hard limit — scrolling refraction can't match Chrome off-Chromium.**
Chrome refracts the backdrop *in the compositor*, synchronized with scrolling,
so it never lags. Other engines don't expose the composited backdrop to JS, and
**iOS Safari scrolls on a separate thread** — so any JS/WebGL refraction of a
*fixed* backdrop is redrawn a frame late and visibly **stutters during scroll**.
This is structural, not a tuning issue: the only thing that scrolls smoothly on
iOS Safari is CSS `backdrop-filter` (frost), which can't do lensing. So the
honest default off-Chromium is the **smooth CSS frost** (what the demo uses) — a
stuttering lens is worse than clean frost.

**`backdropSource` (opt-in) — Chrome-quality lensing for NON-scrolling panels.**
Where the glass and its scene don't scroll relative to each other (a fixed hero
panel, a modal over a still background, a non-scrolling app shell), the shared
**WebGL** refractor gives real GPU lensing on Safari/Firefox too — the same
displacement map Chrome bakes, uploaded as a texture, plus chromatic aberration,
frost and specular, in one full-viewport canvas / one pass:

```ts
new LiquidGlass(glassEl, { backdropSource: '#scene' }); // a <canvas>/<img>/<video>
```

- **Chromium** → native `backdrop-filter` (the option is ignored — refracts the
  real live backdrop for free).
- **Safari / Firefox** → the WebGL canvas refracts the scene texture. The scene
  must be a **`<canvas>`/`<img>`/`<video>`** (uploads to a GPU texture taint-free;
  a DOM element would taint it). Falls back to a position-synced DOM clone /
  `-moz-element` if WebGL2 isn't available.

Constraints: the scene must be a *separate* element (not the glass or an
ancestor). Best for **discrete, non-scrolling** surfaces — over scrolling
content it will lag on iOS Safari (see above). Preview on any browser by forcing
the path with `quality: 'low'`.

**Reduced transparency.** `prefers-reduced-transparency: reduce` takes the
calmest path: a plain profile-aware frost with none of the above enhancements
(honoring the user's preference). `quality: 'low'` also uses the plain frost
path so pressured mobile pages avoid extra map generation.

## References

The optical model is informed by Apple's public Liquid Glass material, then
tuned for a practical web engine:

- [Meet Liquid Glass — WWDC25](https://developer.apple.com/videos/play/wwdc2025/219/)
  — the canonical description of lensing, environment lighting, silhouette
  highlights, adaptive shadow and the Regular/Clear variants
- [Liquid Glass — Technology Overviews](https://developer.apple.com/documentation/technologyoverviews/liquid-glass)
- [Adopting Liquid Glass — Technology Overviews](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass)
- [Materials — Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/materials)

## License

MIT
