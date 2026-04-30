#!/usr/bin/env bash
# Installs claude-rca git hooks: post-commit and commit-msg.
# Idempotent. Refuses to overwrite a non-claude-rca hook.
set -eu

HOOK_DIR="$(git rev-parse --git-path hooks)"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

install_one() {
  local NAME="$1"
  local SRC="$SRC_DIR/$NAME"
  local DEST="$HOOK_DIR/$NAME"

  if [ ! -f "$SRC" ]; then
    echo "skip: $NAME source missing at $SRC"
    return 0
  fi

  if [ -f "$DEST" ] && ! grep -q "claude-rca $NAME hook" "$DEST"; then
    echo "$NAME hook already exists and is not from claude-rca."
    echo "To chain: add 'bash $SRC' to your existing hook."
    exit 1
  fi

  install -m 0755 "$SRC" "$DEST"
  echo "✓ installed claude-rca $NAME hook at $DEST"
}

install_one "post-commit"
install_one "commit-msg"
