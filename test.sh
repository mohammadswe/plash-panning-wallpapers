#!/usr/bin/env bash
# ==============================================================================
# live-walls Automated Test Suite Runner (WebKit & Pytest)
# ==============================================================================

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

VENV_DIR="$SCRIPT_DIR/.venv"

# Ensure virtualenv exists
if [ ! -d "$VENV_DIR" ]; then
  echo "Setting up Python virtual environment for tests..."
  python3 -m venv "$VENV_DIR"
  "$VENV_DIR/bin/pip" install --upgrade pip
  "$VENV_DIR/bin/pip" install pytest pytest-playwright playwright pillow
  "$VENV_DIR/bin/playwright" install webkit
fi

# Run pytest on WebKit
exec "$VENV_DIR/bin/pytest" -v "$@"
