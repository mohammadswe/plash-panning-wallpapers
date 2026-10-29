# Liquid Glass Design Guidelines

Welcome to the Liquid Glass library. This engine relies on physical optics (Snell's Law, physical surface normals) instead of basic CSS hacks to create genuine, volume-based glass. To get the most out of it, follow these design guidelines inspired by modern Spatial UI (like Apple's visionOS).

## 1. Motion & Animation (`.lg-interactive`)

Apple designed the look and the motion of Liquid Glass *as one*: it "responds to
interaction by instantly flexing and energizing with light … it comes to life on
touch" (Meet Liquid Glass, WWDC25). The `.lg-interactive` class layers these
official behaviours on top of the core optics:

- **Interaction illumination** — *"the material illuminates from within … starting
  right under your fingertips, the glow spreads throughout the element."* On
  press, the engine marks the press point and blooms a soft glow outward from the
  finger (`--lg-press` 0→1 grows the radial). Quiet at rest, alive on touch.
- **Pointer-tracked edge light** — the environment light "travels around the
  material, defining its silhouette": a bright rim segment follows the cursor and
  fades in by proximity (this is core, on *every* glass element — see §5).
- **Gel-like flex (press)** — *"an inherent gel-like flexibility … as it moves in
  tandem with your interaction."* The press squishes like a liquid drop
  (`scale3d(1.03, 0.92, 1)`) and springs back.
- **3D parallax tilt** — on hover the glass tilts toward the pointer (`rotateX/Y`)
  for a sense of physical volume.
- **Lift on touch** — the element lifts slightly on hover so the resting state
  stays visually quiet and comes to life on interaction.
- **Materialize in / out (`.lg-entrance` / `.lg-materialize` / `.lg-dematerialize`)**
  — *"Instead of fading, Liquid Glass objects materialize in and out by gradually
  modulating the light bending and lensing."* We spring the scale (which scales
  the lensing with it) rather than relying on opacity alone.
- **Reduced Motion** — *"Reduced Motion … disables any elastic properties."* Under
  `prefers-reduced-motion: reduce` the elastic tilt/jelly/lift/spring are dropped;
  the light still responds, just without springy motion.

## 1.5 Background Liquid Morphing (Gooey Effect)

The true magic of Liquid Glass is revealed when it refracts something dynamic. 
- To achieve the iconic "iOS 26 Liquid Drop Merge", apply an SVG Gooey filter (thresholding alpha via `feColorMatrix`) to the *background container* (e.g. glowing orbs or gradients).
- When the background elements organically merge and separate behind the glass, the `feDisplacementMap` bends the light exactly at the merging seams, creating a breathtaking fluid aesthetic.

## 2. Typography & Contrast (Vibrant Text)

Liquid Glass fundamentally alters the background. Text legibility is your primary concern.

- **Do NOT use standard dark text on light glass** unless you have a completely static, light background.
- **DO use Vibrant Text**: White text with a slight, diffuse dark shadow (`text-shadow: 0 1px 2px rgba(0,0,0,0.2)`) is the industry standard for glass overlays. It ensures the text remains readable regardless of whether the glass floats over a dark or bright background element.
- The default `.liquid-glass` class automatically applies a Vibrant Text configuration.

## 3. Layering & Depth

Liquid glass looks best when it has something to refract!
- **Rich Backgrounds**: Place Liquid Glass elements over vibrant, colorful, or high-contrast backgrounds (images, gradients, moving blobs). Glass over a solid gray background will just look gray.
- **Stacking**: You can stack Liquid Glass elements (e.g., a glass button inside a glass card). However, because each layer runs a complex SVG filter, avoid stacking more than 3 layers deep to prevent visual "mud" and maintain 60fps performance.

## 4. Parameter Tuning

The engine accepts parameters via data attributes or JS options. Prefer
`profile: 'auto'` and `preset: 'auto'` over manually hand-tuning every surface.
The library uses one reference material (`thickness: 44`, `refraction: 46`,
`variant: 'regular'`) and then applies profile + preset multipliers for the
final look.

- `profile: 'bar'`: headers and toolbars. More blur/dissolve, restrained
  refraction, soft material edge.
- `profile: 'control'`: independent buttons, sliders, switches, and media
  controls. Stronger lensing and gloss.
- `profile: 'selection'`: active tab/segmented capsules. Medium-high lensing
  with a lifted capsule feel.
- `profile: 'card'`: compact content cards. Vivid refraction with balanced
  frost for text.
- `profile: 'panel'`: sheets, menus, sidebars, and popovers. More readable
  frost and softer lensing across larger surfaces.
- `preset: 'auto'`: chooses good intensity from the resolved profile. Controls
  and selections become vivid; larger/static surfaces stay balanced.
- `preset: 'subtle' | 'balanced' | 'vivid' | 'dramatic'`: use these only for
  product-specific art direction.
- `thickness`: reference lens depth. Deeper values make every profile feel more
  convex.
- `refraction`: reference lensing strength. Profiles scale and size-cap it so
  small controls do not fold.
- `blur`: reference frost. Profiles apply their own size floor so short bars do
  not collapse into plain transparency.

Avoid nesting `LiquidGlass` inside another `LiquidGlass` just to draw a button.
Inside an existing glass surface, prefer a tint/fill overlay unless the nested
control needs to behave like a distinct floating object.

## 5. Edges & Lighting

Per Apple's *Meet Liquid Glass* (WWDC25), the material defines itself through
**lensing** — it *"dynamically bends, shapes, and concentrates light"* with
*"responsive lensing along its edges"* — and is lit by an environment whose
*"highlights respond to geometry … causing light to travel around the material,
defining its silhouette."* The engine reproduces both from one shared surface:

- **Refraction** is a single smooth lens whose displacement rises monotonically
  from zero at the centre (clear body) to the edge (so there is no inner-ring
  seam), computed with **Snell's law** — the GLSL `refract()` of a straight-down
  view ray through the air→glass interface (n = 1.5) on the lens normal.
- **Static light** is a razor-thin crisp line on the very edge, brightest at the
  top, tracing the silhouette (baked into the filter, no per-frame JS).
- **Dynamic light** (core — *every* glass element, via `PointerField`) makes the
  edge light *follow the pointer*: the bright segment of the rim tracks the
  cursor and **fades in by proximity** (lights up as the cursor approaches from a
  distance, ~220px, not only on direct hover) — Apple's *"light travels around
  the material … comes to life on touch."*
- **Interaction illumination** — on press the glow blooms from under the finger
  and *"spreads throughout the element and onto any Liquid Glass elements
  nearby"*: `PointerField` broadcasts the press so neighbouring glass also lights
  (strongest on the pressed element, falling off with distance).
- You do not need to add your own CSS inner shadows or borders. The engine
  handles the edge lensing and lighting; keep the surrounding content rich so the
  lens has something to bend.

## 6. Morph transitions (`LiquidMenu`, `LiquidSheet`)

Apple flexes and morphs glass between sizes: *"presenting a menu from a toolbar
button … as glass morphs to larger sizes it casts deeper, richer shadows, has
more pronounced lensing and refraction."*

- **`LiquidMenu(trigger, menu)`** — the menu flows out of its trigger (springs up
  from a small seed anchored to the control) and collapses back on dismiss.
- **`LiquidSheet(sheet)`** — materializes a sheet up from the bottom over a
  dimming scrim (the scrim is the "dimming layer" that keeps content legible),
  and slides back down on dismiss.

Both honor `prefers-reduced-motion` (no elastic morph) and close on outside
click / Escape. Give the menu/sheet element a `.liquid-glass` + its own
`LiquidGlass` instance, then attach the component.
