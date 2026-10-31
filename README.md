# Live Wallpapers for macOS using Plash

### A script to set up wallpapers for your Mac that pan and smoothly transition, for a "Live Wallpaper" look.
##### Have a bunch of photos that you set as your desktop wallpaper, only to get upset that they 1) transition abruptly and 2) don't fit the aspect ratio of your screen making you lose a bunch of the image? This simple script fixes that - it allows you to pan your images so that you see more of them, and transitions smoothly from one to the next - all while preserving the your images' quality. Unlike other solutions, which turn photos into videos so they can pan or transition, and thereby lose quality, this script preserves your images as actual images, and simply applies CSS to them to make them move.
---

## Setup

### 1. Install Plash
Download and install [Plash](https://github.com/sindresorhus/plash) (free on the App Store).

### 2. Prepare Your Folder
1. Download `index.html` from this repository.
2. Create a parent folder anywhere on your Mac (e.g. `~/Pictures/live-walls`) that will hold both your images and the `index.html`.
3. Place `index.html` inside that folder.
4. Create an `images` subfolder inside it and add your wallpaper photos (`.jpg`, `.png`, `.webp`, etc.).

Your folder structure will look like this:
```
live-walls/
├── index.html
└── images/
    ├── photo1.jpg
    ├── photo2.png
    └── photo3.webp
```

### 3. Add Wallpapers (Automatic Importer)
Simply run the included `add_walls.sh` tool:
```bash
./add_walls.sh
```
* **Drag and drop** your image files or photo folders directly into the Terminal window and hit **Enter**.
* Or pass them directly: `./add_walls.sh ~/Downloads/*.jpg`
* The tool automatically optimizes each photo to Retina 5K WebP, clamps excessive dimensions to protect WebKit memory, strips metadata, and registers them directly into `index.html`.

*(To re-index existing wallpapers without adding new files, simply run `./add_walls.sh --sync`)*

### 5. Set as Wallpaper in Plash
1. Click the **Plash icon** in your macOS menu bar.
2. Select **Add Website…**.
3. Click **Open…** and select your `live-walls` *folder* (containing `index.html`).
4. Click **Save**.
5. In Plash Settings, enable **"Extend below menu bar"** (or run `defaults write com.sindresorhus.Plash extendPlashBelowMenuBar -bool true`) so the wallpaper extends seamlessly edge-to-edge behind the menu bar with zero gaps.

Your desktop will now cycle through your photos with smooth diagonal pans and transitions!

---

## Customization

Inside `index.html`, you can tweak these settings:
- **Display Duration**: `const INTERVAL_MS = 60000;` (display each wallpaper for 60 seconds).
- **Transition Duration**: `const FADE_MS = 3000;` (3-second crossfade).
- **Menu Bar Glass Styling**:
  ```css
  :root {
    --menubar-height: max(30px, env(safe-area-inset-top)); /* Bar height (30px or notch) */
    --menubar-blur: 28px;                                 /* Frosted glass blur radius */
    --menubar-saturate: 180%;                             /* Color vibrancy boost */
    --menubar-tint-light: rgba(255, 255, 255, 0.20);      /* Light mode glass tint */
    --menubar-tint-dark: rgba(20, 20, 20, 0.32);          /* Dark mode glass tint */
  }
  ```

---

## Simulated Frosted Glass Menu Bar (Seamless Transitions)

If you turn **"Show menu bar background"** to **OFF** in macOS Menu Bar settings, your native macOS menu bar becomes fully transparent. 

`index.html` includes a hardware-accelerated frosted glass overlay (`#menubar-glass`) positioned directly behind your macOS menu bar. 

### Why this is better:
- **Buttery-Smooth Crossfades**: The blur and tint seamlessly fade with the 3-second wallpaper transition (no abrupt color snap).
- **Pan-Aware**: Stays locked at the top of your screen even while photos pan diagonally underneath it.
- **Zero Background Daemons**: Runs purely in the GPU compositor in Plash without needing python sync scripts or osascript wallpaper changes.

---

## Native Desktop Wallpaper Sync (Optional)

If you also want your underlying native desktop picture (visible in Mission Control or Spaces) to match Plash, you can enable native syncing:
1. In `index.html`, set `const SYNC_NATIVE_WALLPAPER = true;`
2. Start the sync helper:
   ```bash
   ./start_sync.sh
   ```

To stop the sync helper:
```bash
./stop_sync.sh
```

---

## Automated Testing Suite (WebKit & Pytest)

`live-walls` includes an automated test suite powered by **Playwright WebKit** and **Pytest**. It tests both the visual/kinetics rendering in native macOS WebKit and the CLI ingestion pipeline.

To run the entire test suite:
```bash
./test.sh
```

### What is tested:
1. **Viewport Coverage & Zero-Runoff (`test_viewport_geometry.py`)**:
   - Asserts the active wallpaper element completely envelops the viewport ($vw \times vh$) at all points along its 60s trajectory with zero edge runoff or desktop exposure.
   - Inspects physical edge pixels with Pillow to verify 100% opacity and absence of transparent borders.
   - Runs a 5,000-iteration Monte Carlo simulation inside WebKit proving zero boundary breaches across extreme aspect ratios (4:3, 3:2, 16:9, 21:9, 3:1 panoramas, and portrait).
2. **Kinematic Drift Velocity (`test_kinetics_speed.py`)**:
   - Inspects the Web Animations API keyframes to assert constant visual speed stays between $3.0$ and $5.0\text{ px/s}$.
   - Verifies camera drift vectors span all four quadrants of the 360-degree compass.
3. **Deck Lifecycle & Reload Resilience (`test_deck_lifecycle.py`)**:
   - Asserts all 97 wallpapers play before any duplicate appears.
   - Asserts boundary transitions never repeat across deck resets (`nextDeck[0] !== lastShown`).
   - Asserts page reloads, display sleep, or wake events never recycle already-played cards back into the deck.
   - Verifies active deck interleaving when new wallpapers are added via `add_walls.sh`.
   - Verifies the error circuit breaker trips after 5 consecutive decode failures.
4. **LiquidGlass Optical Lens (`test_menubar_lens.py`)**:
   - Verifies the simulated menu bar canvas mounts and renders frosted glass refraction matching the underlying wallpaper.
5. **Asset Ingestion Pipeline (`test_add_walls_pipeline.py`)**:
   - Tests `add_walls.sh` dimension clamping on gigapixel panoramas ($\le 7680 \times 2880$).
   - Tests duplicate skipping and `--force` overwrite.
   - Tests Unicode filename preservation (e.g. non-Latin scripts like Bengali).



