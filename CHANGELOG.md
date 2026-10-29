### [2026-10-28] Refactor index.html & Remove Redundant Code
- **Scope:** `index.html`
- **State Changes:** Removed unused CSS custom variables (--menubar-height, --menubar-tint-light, --menubar-border-light) and redundant @media (prefers-color-scheme: dark) block in index.html. Removed dead data-layer DOM attributes. Extracted startKenBurnsAnimation helper to eliminate duplicate Web Animations API code in initWallpaper and cycleWallpaper. Streamlined layer reference swapping and optional-chained cleanup.
- **Dependencies Introduced/Modified:** None
- **Side Effects / Boundaries:** Zero visual or behavioral changes; maintains 100% parity with existing wallpaper transitions and LiquidGlass parameters.
- **Verification Token:** JavaScript syntax validation passed

### [2026-10-27] Hardware-Accelerated Frosted Glass Layer with Sharp Specular & Chromatic Rim
- **Scope:** `liquid-glass-web-main/src/core/SceneOpticalLens.ts`, `liquid-glass.umd.js`, `index.html`, `index.personal.html`
- **State Changes:** Replaced unsupported Canvas2D `ctx.filter` with a dedicated `refractCanvas` layer using CSS `filter: blur() saturate()` hardware-accelerated by WebKit/Metal. Added bleed padding to eliminate edge-feathering vignette at navbar borders. Kept the top overlay canvas unblurred to preserve crisp chromatic rainbow dispersion and razor-sharp specular highlights. Added `drawImageSafe` bounds clipping. Bumped cache buster to `v=3`.
- **Dependencies Introduced/Modified:** None
- **Side Effects / Boundaries:** Menu bar now produces authentic macOS frosted glass blur across the body while maintaining crystal-clear specular highlights and chromatic prism at the rim.
- **Verification Token:** Typecheck and library build passed via Deno/Vite (23/23 tests passing)

### [2026-10-27] Implement Native Canvas Blur, Saturation & Connect LiquidGlass Options
- **Scope:** `liquid-glass-web-main/src/core/SceneOpticalLens.ts`, `liquid-glass-web-main/src/core/LiquidGlass.ts`, `liquid-glass.umd.js`, `index.html`, `index.personal.html`
- **State Changes:** Added blur and saturation support directly into SceneOpticalLens via Canvas 2D ctx.filter. Updated LiquidGlass to pass explicit user options (refraction, thickness, blur, saturation, specularIntensity) directly to SceneOpticalLens without capping or ignoring them. Added script cache buster v=2 to index.html and index.personal.html.
- **Dependencies Introduced/Modified:** None
- **Side Effects / Boundaries:** Blur, saturation, and tint now take direct visual effect on the navbar canvas.
- **Verification Token:** All 23 tests passed, build successful

### [2026-10-26] Fix Optical Lens Alignment & Independent Chromatic Dispersion
- **Scope:** `liquid-glass-web-main/src/core/SceneOpticalLens.ts`, `liquid-glass.umd.js`
- **State Changes:** Fixed object-fit: cover coordinate calculation in getActiveLayers() to correctly account for aspect-ratio letterboxing and 50% 50% centering offsets, eliminating wallpaper boundary cutoff. Decoupled chromatic aberration dispersion spread from overall refraction so rainbow prism fringing remains visible at the top rim even at refraction: 0. Confined bevel curvature strictly to top rim so the bottom of the navbar remains flat (bend = 0) and seamlessly connects to the desktop wallpaper.
- **Dependencies Introduced/Modified:** None
- **Side Effects / Boundaries:** Menu bar now aligns with subpixel accuracy to underlying wallpaper.
- **Verification Token:** Library built and all tests passed (23/23)

### [2026-10-26] Invert Liquid Glass Navbar Rim & Aberration (180deg)
- **Scope:** `liquid-glass-web-main/src/core/SceneOpticalLens.ts`, `liquid-glass-web-main/src/core/types.ts`, `liquid-glass-web-main/src/core/LiquidGlass.ts`, `liquid-glass.umd.js`, `index.html`, `index.personal.html`
- **State Changes:** Flipped the optical lens roundover profile and specular gradient 180 degrees so the Snell displacement, 3-pass RGB chromatic aberration, and specular rim highlight render along the top edge of the navbar instead of the bottom edge. Added `rimPosition` ('top' | 'bottom') option (defaulting to 'top'). Removed undefined `syncCloneLayer` calls in `index.html`.
- **Dependencies Introduced/Modified:** None
- **Side Effects / Boundaries:** Liquid glass canvas now bends and shines along the top border ($y = 0$). Does not affect non-bar optical profiles.
- **Verification Token:** Typecheck and library build passed via Deno/Vite
