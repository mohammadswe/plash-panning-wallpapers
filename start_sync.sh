#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"

# Check if already running
if lsof -i :8765 > /dev/null 2>&1; then
    echo "Wallpaper sync is already running on port 8765."
    exit 0
fi

nohup python3 "$DIR/wallpaper_sync.py" > /tmp/livewalls_sync.log 2>&1 &
echo "Wallpaper sync started in background (PID: $!)."
echo "Your macOS menu bar will now automatically match your Plash wallpapers."
