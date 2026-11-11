#!/usr/bin/env python3
"""
Live Walls — Day/Night Wallpaper Synchronizer
Synchronizes day.txt and night.txt with index.html and index.personal.html.
Graceful default: unassigned images in converted/ are assigned to dayImages.
"""

import os
import sys
import re
import unicodedata
import hashlib
import subprocess
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
CONVERTED_DIR = BASE_DIR / "converted"
DAY_FILE = BASE_DIR / "day.txt"
NIGHT_FILE = BASE_DIR / "night.txt"
TARGET_HTML_FILES = ["index.html", "index.personal.html"]

def sanitize_filename(name):
    name_no_ext = name.rsplit(".", 1)[0] if "." in name else name
    normalized = unicodedata.normalize("NFKD", name_no_ext).encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-zA-Z0-9._-]+", "-", normalized.lower()).strip("-")
    slug = re.sub(r"-+", "-", slug)

    if not re.search(r"[a-z0-9]", slug):
        chars = []
        for ch in unicodedata.normalize("NFC", name_no_ext.lower()):
            cat = unicodedata.category(ch)
            if cat.startswith(("L", "M", "N")) or ch in "._-":
                chars.append(ch)
            else:
                chars.append("-")
        clean_unicode = re.sub(r"-+", "-", "".join(chars)).strip("-")
        if any(unicodedata.category(c).startswith(("L", "N")) for c in clean_unicode):
            slug = clean_unicode
        else:
            h = hashlib.md5(name_no_ext.encode("utf-8")).hexdigest()[:8]
            slug = f"wallpaper-{h}"
    return slug + ".webp"

def sync_day_night(base_dir=BASE_DIR, reload_plash=True):
    converted_dir = base_dir / "converted"
    day_file = base_dir / "day.txt"
    night_file = base_dir / "night.txt"

    if not converted_dir.is_dir():
        print(f"[Error] Converted directory not found at {converted_dir}", file=sys.stderr)
        return False

    all_webp = set(f.name for f in converted_dir.iterdir() if f.name.endswith(".webp") and not f.name.startswith("."))

    def parse_txt(path):
        if not path.is_file():
            return set()
        items = set()
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                raw = line.strip()
                if not raw or raw.startswith("#"):
                    continue
                base = os.path.basename(raw).lower()
                if base in ["day.txt", "night.txt"]:
                    continue
                
                sanitized = sanitize_filename(raw)
                direct = (raw.rsplit(".", 1)[0] if "." in raw else raw) + ".webp"
                
                if sanitized in all_webp:
                    items.add(sanitized)
                elif direct in all_webp:
                    items.add(direct)
                else:
                    for w in all_webp:
                        if w.lower() == sanitized.lower() or w.lower() == direct.lower():
                            items.add(w)
                            break
        return items

    day_set = parse_txt(day_file)
    night_set = parse_txt(night_file)

    # Night takes priority if present in both
    day_set = day_set - night_set

    # Graceful default: any converted webp not in night or day defaults to day
    unassigned = all_webp - (day_set | night_set)
    if unassigned:
        print(f"[Info] Assigning {len(unassigned)} unassigned wallpaper(s) to dayImages by default.")
        day_set.update(unassigned)

    day_list = sorted(f"converted/{f}" for f in day_set)
    night_list = sorted(f"converted/{f}" for f in night_set)

    print(f"Synchronizing wallpaper library:")
    print(f"  • Day wallpapers:   {len(day_list)}")
    print(f"  • Night wallpapers: {len(night_list)}")
    print(f"  • Total indexed:    {len(day_list) + len(night_list)}")

    formatted_day_js = ",\n".join(f'        "{img}"' for img in day_list)
    formatted_night_js = ",\n".join(f'        "{img}"' for img in night_list)

    replacement_block = (
        "const dayImages = [\n"
        f"{formatted_day_js}\n"
        "      ];\n\n"
        "      const nightImages = [\n"
        f"{formatted_night_js}\n"
        "      ];"
    )

    pattern = re.compile(
        r"(?:const dayImages = \[\s*[\s\S]*?\s*\];\s*const nightImages = \[\s*[\s\S]*?\s*\];|const images = \[\s*[\s\S]*?\s*\];)"
    )

    for target in TARGET_HTML_FILES:
        target_path = base_dir / target
        if not target_path.is_file():
            continue

        with open(target_path, "r", encoding="utf-8") as f:
            content = f.read()

        if not pattern.search(content):
            print(f"  [Warning] Could not find images block in {target}. Skipped.", file=sys.stderr)
            continue

        # Backup
        bak_path = str(target_path) + ".bak"
        with open(bak_path, "w", encoding="utf-8") as f:
            f.write(content)

        new_content = pattern.sub(replacement_block, content, count=1)
        with open(target_path, "w", encoding="utf-8") as f:
            f.write(new_content)

        print(f"  ✓ Updated {target} ({len(day_list)} day, {len(night_list)} night)")

    if reload_plash:
        reload_plash_app()

    return True

def reload_plash_app():
    res = subprocess.run(["pgrep", "-x", "Plash"], capture_output=True)
    if res.returncode == 0:
        script = 'tell application "System Events" to tell process "Plash" to tell menu bar item 1 of menu bar 2 to click menu item "Reload" of menu 1'
        subprocess.run(["osascript", "-e", script], capture_output=True)
        print("  ✓ Plash desktop reloaded automatically.")

if __name__ == "__main__":
    reload = "--no-reload" not in sys.argv
    success = sync_day_night(BASE_DIR, reload_plash=reload)
    sys.exit(0 if success else 1)
