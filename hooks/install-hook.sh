#!/usr/bin/env bash
set -eu
HOOK_DIR="$(git rev-parse --git-path hooks)"
SRC="$(dirname "$0")/post-commit"
DEST="$HOOK_DIR/post-commit"

if [ -f "$DEST" ] && ! grep -q "claude-rca post-commit hook" "$DEST"; then
  echo "post-commit hook already exists and is not from claude-rca."
  echo "To chain: add 'bash $SRC' to your existing hook."
  exit 1
fi

install -m 0755 "$SRC" "$DEST"
echo "✓ installed claude-rca post-commit hook at $DEST"
