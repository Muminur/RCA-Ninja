#!/usr/bin/env bash
# Installs claude-rca git hooks into one explicitly supplied local repository.
# Idempotent. Refuses to overwrite a non-claude-rca hook.
set -eu

if [ -z "${BASH_VERSION:-}" ]; then
  echo "ERROR: bash is required. Install Git for Windows: https://git-scm.com/download/win"
  exit 1
fi

if [ "$#" -ne 1 ] || [ "$1" = "--global" ]; then
  echo "ERROR: hook installation requires one explicit local repository path." >&2
  exit 1
fi

TARGET_REPO="$1"
if ! HOOK_DIR="$(git -C "$TARGET_REPO" rev-parse --path-format=absolute --git-path hooks 2>/dev/null)"; then
  echo "ERROR: not a git repository: $TARGET_REPO" >&2
  exit 1
fi

EFFECTIVE_HOOKS_PATH="$(git -C "$TARGET_REPO" config --get core.hooksPath 2>/dev/null || true)"
LOCAL_HOOKS_PATH="$(git -C "$TARGET_REPO" config --local --get core.hooksPath 2>/dev/null || true)"
if [ -n "$EFFECTIVE_HOOKS_PATH" ] && [ -z "$LOCAL_HOOKS_PATH" ]; then
  echo "ERROR: refusing inherited core.hooksPath; configure an explicit repository-local hooks path first." >&2
  exit 1
fi

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOOK_DIR"

install_one() {
  local NAME="$1"
  local SRC="$SRC_DIR/$NAME"
  local DEST="$HOOK_DIR/$NAME"

  if [ ! -f "$SRC" ]; then
    echo "skip: $NAME source missing at $SRC"
    return 0
  fi

  if [ -f "$DEST" ] && ! grep -q "claude-rca" "$DEST"; then
    echo "$NAME hook already exists and is not from claude-rca."
    echo "To chain: add 'bash $SRC' to your existing hook."
    exit 1
  fi

  install -m 0755 "$SRC" "$DEST"
  echo "✓ installed claude-rca $NAME hook at $DEST"
}

install_one "post-commit"
install_one "commit-msg"
