#!/usr/bin/env bash
# ==============================================================================
# Live Walls Wallpaper Importer & Optimizer
# Usage:
#   ./add_walls.sh                      (interactive drag-and-drop mode)
#   ./add_walls.sh <file1> <file2> ...  (command-line argument mode)
# ==============================================================================

set -eo pipefail
trap 'rm -f /tmp/livewall_conv_*' EXIT INT TERM

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

CONVERTED_DIR="$SCRIPT_DIR/converted"
TARGET_HEIGHT=2880
MAX_WIDTH=7680
WEBP_QUALITY=88

# Colors
C_RESET="\033[0m"
C_BOLD="\033[1m"
C_GREEN="\033[32m"
C_BLUE="\033[34m"
C_YELLOW="\033[33m"
C_RED="\033[31m"
C_CYAN="\033[36m"

mkdir -p "$CONVERTED_DIR"

# 1. Dependency checks
if ! command -v sips &>/dev/null; then
  echo -e "${C_RED}Error:${C_RESET} 'sips' (built-in macOS image utility) was not found." >&2
  exit 1
fi

if ! command -v cwebp &>/dev/null; then
  echo -e "${C_YELLOW}Notice:${C_RESET} 'cwebp' not found in PATH. Attempting Homebrew check..."
  if [ -x "/opt/homebrew/bin/cwebp" ]; then
    export PATH="/opt/homebrew/bin:$PATH"
  elif [ -x "/usr/local/bin/cwebp" ]; then
    export PATH="/usr/local/bin:$PATH"
  else
    echo -e "${C_RED}Error:${C_RESET} 'cwebp' is required for high-performance WebP encoding." >&2
    echo -e "Install it with Homebrew: ${C_BOLD}brew install webp${C_RESET}" >&2
    exit 1
  fi
fi

# 2. Gather input paths and options
RAW_INPUTS=()
SYNC_ONLY=0
FORCE_OVERWRITE=0

if [ "$#" -gt 0 ]; then
  for arg in "$@"; do
    case "$arg" in
      --sync|-s)
        SYNC_ONLY=1
        ;;
      --force|-f)
        FORCE_OVERWRITE=1
        ;;
      *)
        RAW_INPUTS+=("$arg")
        ;;
    esac
  done
else
  echo -e "${C_BOLD}${C_BLUE}======================================================${C_RESET}"
  echo -e "${C_BOLD}${C_CYAN}            Live Walls — Wallpaper Importer           ${C_RESET}"
  echo -e "${C_BOLD}${C_BLUE}======================================================${C_RESET}"
  echo -e "Drag and drop your image file(s) or folder(s) directly into"
  echo -e "this terminal window, then press ${C_BOLD}[Enter]${C_RESET}:"
  echo -e "(Options: ${C_BOLD}--sync${C_RESET} to re-index, ${C_BOLD}--force${C_RESET} to overwrite existing conversions)"
  echo ""
  printf "${C_GREEN}➔ Images to add: ${C_RESET}"
  read -r USER_LINE
  echo ""

  # Parse shell-escaped / quoted drag-and-drop string safely using Python shlex
  while IFS= read -r parsed_path; do
    if [ "$parsed_path" = "--sync" ] || [ "$parsed_path" = "-s" ]; then
      SYNC_ONLY=1
    elif [ "$parsed_path" = "--force" ] || [ "$parsed_path" = "-f" ]; then
      FORCE_OVERWRITE=1
    elif [ -n "$parsed_path" ]; then
      RAW_INPUTS+=("$parsed_path")
    fi
  done < <(python3 -c "
import sys, shlex
line = sys.argv[1].strip()
try:
    for item in shlex.split(line):
        if item.strip():
            print(item.strip())
except Exception as e:
    for item in line.split():
        if item.strip():
            print(item.strip())
" "$USER_LINE")
fi

if [ "$SYNC_ONLY" -eq 0 ] && [ "${#RAW_INPUTS[@]}" -eq 0 ]; then
  echo -e "${C_YELLOW}No valid file paths found. Exiting.${C_RESET}"
  exit 0
fi

if [ "$SYNC_ONLY" -eq 0 ]; then
  # 3. Resolve all files (expanding directories and ~)
  EXPANDED_FILES=()
  for item in "${RAW_INPUTS[@]}"; do
    item="${item/#\~/$HOME}"

    if [ -d "$item" ]; then
      while IFS= read -r found_file; do
        [ -n "$found_file" ] && EXPANDED_FILES+=("$found_file")
      done < <(find -L "$item" -type f \( \
        -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.png" \
        -o -iname "*.heic" -o -iname "*.heif" -o -iname "*.webp" \
        -o -iname "*.tiff" -o -iname "*.tif" -o -iname "*.avif" \
        -o -iname "*.bmp" \) | sort)
    elif [ -f "$item" ]; then
      EXPANDED_FILES+=("$item")
    else
      echo -e "${C_YELLOW}Warning:${C_RESET} File not found, skipping: $item"
    fi
  done

  TOTAL_FOUND="${#EXPANDED_FILES[@]}"
  if [ "$TOTAL_FOUND" -eq 0 ]; then
    echo -e "${C_RED}No supported image files found to process.${C_RESET}"
    exit 1
  fi

  echo -e "${C_BOLD}Found $TOTAL_FOUND image(s) to process.${C_RESET}"
  echo ""

  # Helper to sanitize filename (Unicode-safe, preserves alphanumeric, cleanly slugs)
  sanitize_filename() {
    python3 -c "
import sys, re, unicodedata, hashlib
name = sys.argv[1]
name_no_ext = name.rsplit('.', 1)[0] if '.' in name else name
normalized = unicodedata.normalize('NFKD', name_no_ext).encode('ascii', 'ignore').decode('ascii')
slug = re.sub(r'[^a-zA-Z0-9._-]+', '-', normalized.lower()).strip('-')
slug = re.sub(r'-+', '-', slug)

# If slug has no latin alphanumeric characters, preserve unicode letters/marks/numbers
if not re.search(r'[a-z0-9]', slug):
    chars = []
    for ch in unicodedata.normalize('NFC', name_no_ext.lower()):
        cat = unicodedata.category(ch)
        if cat.startswith(('L', 'M', 'N')) or ch in '._-':
            chars.append(ch)
        else:
            chars.append('-')
    clean_unicode = re.sub(r'-+', '-', ''.join(chars)).strip('-')
    if any(unicodedata.category(c).startswith(('L', 'N')) for c in clean_unicode):
        slug = clean_unicode
    else:
        h = hashlib.md5(name_no_ext.encode('utf-8')).hexdigest()[:8]
        slug = f'wall-{h}'
print(slug)
" "$1"
  }

  # 4. Process each image
  IMPORTED_COUNT=0
  SKIPPED_COUNT=0

  for src_path in "${EXPANDED_FILES[@]}"; do
    base_filename="$(basename "$src_path")"
    clean_stem="$(sanitize_filename "$base_filename")"
    
    if [ -z "$clean_stem" ]; then
      clean_stem="wallpaper"
    fi

    dest_filename="${clean_stem}.webp"
    dest_path="$CONVERTED_DIR/$dest_filename"

    # Collision / Duplicate handling
    if [ -f "$dest_path" ]; then
      if [ "$FORCE_OVERWRITE" -eq 0 ]; then
        echo -e "  ${C_YELLOW}• Skipped (already imported):${C_RESET} $base_filename ($dest_filename exists, use -f to overwrite)"
        SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
        continue
      else
        echo -e "  ${C_BLUE}• Overwriting existing:${C_RESET} $dest_filename"
      fi
    fi

    # Read source image dimensions
    src_dims="$(sips -g pixelWidth -g pixelHeight "$src_path" 2>/dev/null || true)"
    src_w=$(echo "$src_dims" | awk '/pixelWidth:/ {print $2}')
    src_h=$(echo "$src_dims" | awk '/pixelHeight:/ {print $2}')

    if [ -z "$src_h" ] || [ "$src_h" -le 0 ]; then
      echo -e "  ${C_RED}✗ Corrupted or unreadable image:${C_RESET} $base_filename"
      continue
    fi

    RESIZE_FLAG=()
    if [ "$src_h" -gt "$TARGET_HEIGHT" ] || [ "$src_w" -gt "$MAX_WIDTH" ]; then
      if [ $((src_w * TARGET_HEIGHT)) -gt $((src_h * MAX_WIDTH)) ]; then
        RESIZE_FLAG=(-resize "$MAX_WIDTH" 0)
      else
        RESIZE_FLAG=(-resize 0 "$TARGET_HEIGHT")
      fi
    fi

    lower_ext="${base_filename##*.}"
    lower_ext="$(echo "$lower_ext" | tr '[:upper:]' '[:lower:]')"

    TMP_TIFF=""
    INPUT_FOR_CWEBP="$src_path"

    if [[ "$lower_ext" == "heic" || "$lower_ext" == "heif" || "$lower_ext" == "tif" || "$lower_ext" == "tiff" || "$lower_ext" == "bmp" ]]; then
      TMP_TIFF=$(mktemp "/tmp/livewall_conv_XXXXXX.tiff")
      if ! sips -s format tiff "$src_path" --out "$TMP_TIFF" &>/dev/null; then
        echo -e "  ${C_RED}✗ Failed to decode format:${C_RESET} $base_filename"
        rm -f "$TMP_TIFF"
        continue
      fi
      INPUT_FOR_CWEBP="$TMP_TIFF"
    fi

    if cwebp -q "$WEBP_QUALITY" -m 6 -mt "${RESIZE_FLAG[@]}" "$INPUT_FOR_CWEBP" -o "$dest_path" &>/dev/null; then
      [ -n "$TMP_TIFF" ] && rm -f "$TMP_TIFF"
      
      out_dims="$(sips -g pixelWidth -g pixelHeight "$dest_path" 2>/dev/null || true)"
      out_w=$(echo "$out_dims" | awk '/pixelWidth:/ {print $2}')
      out_h=$(echo "$out_dims" | awk '/pixelHeight:/ {print $2}')
      out_size_bytes=$(stat -f%z "$dest_path" 2>/dev/null || echo "0")
      out_size_mb=$(python3 -c "print(f'{$out_size_bytes / (1024*1024):.2f}')")

      echo -e "  ${C_GREEN}✓ Converted:${C_RESET} ${C_BOLD}$dest_filename${C_RESET} (${out_w}x${out_h}, ${out_size_mb} MB)"
      IMPORTED_COUNT=$((IMPORTED_COUNT + 1))
    else
      [ -n "$TMP_TIFF" ] && rm -f "$TMP_TIFF"
      echo -e "  ${C_RED}✗ Failed to encode WebP:${C_RESET} $base_filename"
    fi
  done

  echo ""
  echo -e "${C_BOLD}Import complete: $IMPORTED_COUNT added, $SKIPPED_COUNT skipped.${C_RESET}"
fi

# 5. Synchronize index.html and index.personal.html
echo -e "Synchronizing wallpaper library in HTML files..."

python3 - << 'EOF'
import os
import re

base_dir = os.path.dirname(os.path.abspath(__file__)) if "__file__" in locals() else os.getcwd()
converted_dir = os.path.join(base_dir, "converted")

if not os.path.isdir(converted_dir):
    print("No converted directory found.")
    exit(0)

# Collect all webp files in converted/, sorted alphabetically
files = sorted([f for f in os.listdir(converted_dir) if f.lower().endswith(".webp") and not f.startswith(".")])
filtered_files = [f"converted/{f}" for f in files]

print(f"Total wallpapers indexed in converted/: {len(filtered_files)}")

# Format replacement JS block
formatted_js = "const images = [\n" + ",\n".join(f'        "{img}"' for img in filtered_files) + "\n      ];"

target_html_files = ["index.html", "index.personal.html"]

for target in target_html_files:
    path = os.path.join(base_dir, target)
    if not os.path.isfile(path):
        continue

    with open(path, "r", encoding="utf-8") as f:
        content = f.read()

    # Pattern matching const images = [ ... ];
    pattern = r"const images = \[\s*[\s\S]*?\s*\];"
    if not re.search(pattern, content):
        print(f"  [Warning] Could not find 'const images = [...]' in {target}. Skipped.")
        continue

    # Backup file
    bak_path = path + ".bak"
    with open(bak_path, "w", encoding="utf-8") as f:
        f.write(content)

    new_content = re.sub(pattern, formatted_js, content, count=1)
    with open(path, "w", encoding="utf-8") as f:
        f.write(new_content)

    print(f"  ✓ Updated {target} ({len(filtered_files)} wallpapers registered, backup at {target}.bak)")
EOF

# 6. Automatically trigger Plash reload if running
if pgrep -x "Plash" &>/dev/null; then
  osascript -e 'tell application "System Events" to tell process "Plash" to tell menu bar item 1 of menu bar 2 to click menu item "Reload" of menu 1' &>/dev/null && \
    echo -e "  ${C_CYAN}✓ Plash desktop reloaded automatically.${C_RESET}" || true
fi

echo ""
echo -e "${C_BOLD}${C_GREEN}All done!${C_RESET} Plash will display the updated wallpapers automatically."
