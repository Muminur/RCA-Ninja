#!/usr/bin/env bash
# Installs claude-rca git hooks: post-commit and commit-msg.
# Idempotent. Refuses to overwrite a non-claude-rca hook.
set -eu

# Verify bash is functional
if [ -z "${BASH_VERSION:-}" ]; then
  echo "ERROR: bash is required. Install Git for Windows: https://git-scm.com/download/win"
  exit 1
fi

HOOK_DIR="$(git rev-parse --git-path hooks)"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "${SRC_DIR}/.." && pwd)"

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

# Attempt npm link so claude-rca is on PATH globally
if ! command -v claude-rca >/dev/null 2>&1; then
  echo "claude-rca not on PATH — attempting npm link..."
  if (cd "${REPO_DIR}" && npm link 2>/dev/null); then
    echo "✓ npm link succeeded — claude-rca is now globally accessible"
  else
    echo "⚠ npm link failed. Run manually: cd ${REPO_DIR} && npm link"
  fi
else
  echo "✓ claude-rca already on PATH: $(command -v claude-rca)"
fi
