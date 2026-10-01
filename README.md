# Live Walls for macOS (Plash)

A lightweight, GPU-accelerated dynamic wallpaper for macOS that smoothly pans (Ken Burns effect) and crossfades through your photo collection using [Plash](https://github.com/sindresorhus/plash).

---

## Quick Setup

### 1. Install Plash
Download and install [Plash](https://github.com/sindresorhus/plash) (free on the Mac App Store or GitHub Releases).

### 2. Prepare Your Folder
1. Download `index.html` from this repository.
2. Create a folder anywhere on your Mac (e.g. `~/Pictures/live-walls`).
3. Place `index.html` inside this folder.
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

### 3. Generate the Image List
Open **Terminal**, navigate to your folder:
```bash
cd ~/Pictures/live-walls
```

Run this command. It automatically scans your `images/` folder, formats the file paths, and **copies them directly to your macOS clipboard**:
```bash
find images -maxdepth 1 -type f \( -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.png" -o -iname "*.webp" \) | sort | sed 's/.*/  "&",/' | pbcopy
```

*(If your photos are directly in the same folder as `index.html` instead of an `images/` subfolder, replace `images` with `.`)*

### 4. Paste Into `index.html`
1. Open `index.html` in your favorite code editor (or macOS TextEdit in **Plain Text** mode: `Format > Make Plain Text` / `Cmd+Shift+T`).
2. Replace the placeholder lines in `const images = [ ... ];` with `Cmd + V`.
3. Save the file.

### 5. Set as Wallpaper in Plash
1. Click the **Plash icon** in your macOS menu bar.
2. Select **Add Website…**.
3. Click **Open…** and select your `live-walls` folder.
4. Click **Save** (or check the website).

Your desktop will now cycle through your photos with smooth diagonal pans and transitions!

---

## Customization

Inside `index.html`, you can tweak these settings:
- **Display Duration**: `const INTERVAL_MS = 60000;` (display each wallpaper for 60 seconds).
- **Transition Duration**: `const FADE_MS = 3000;` (3-second crossfade).
