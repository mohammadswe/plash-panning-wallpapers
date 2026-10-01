#!/bin/bash
PID=$(lsof -ti :8765)
if [ -n "$PID" ]; then
    kill $PID
    echo "Wallpaper sync stopped (PID: $PID)."
else
    echo "Wallpaper sync is not running."
fi
