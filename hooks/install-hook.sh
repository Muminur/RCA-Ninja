#!/usr/bin/env bash
# Installs claude-rca git hooks into one explicitly supplied local repository.
# Idempotent. Refuses to overwrite a non-claude-rca hook.
set -eu

if [ -z "${BASH_VERSION:-}" ]; then
  echo "ERROR: bash is required. Install Git for Windows: https://git-scm.com/download/win"
  exit 1
fi

if [ -n "${BASH_ENV:-}" ]; then
  echo "ERROR: refusing preloaded shell environment via BASH_ENV." >&2
  exit 1
fi

if [ "$#" -ne 1 ] || [ "$1" = "--global" ]; then
  echo "ERROR: hook installation requires one explicit local repository path." >&2
  exit 1
fi

for ENV_NAME in $(compgen -e); do
  NORMALIZED_ENV_NAME="$(printf '%s' "$ENV_NAME" | tr '[:lower:]' '[:upper:]')"
  case "$NORMALIZED_ENV_NAME" in
    GIT_CONFIG*|GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_ATTR_NOSYSTEM)
      echo "ERROR: refusing unsafe Git environment variable: $ENV_NAME" >&2
      exit 1
      ;;
  esac
done

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_REPO="$1"
EFFECTIVE_HOOKS_CONFIG="$(git -C "$TARGET_REPO" config --show-origin --get core.hooksPath 2>/dev/null || true)"
LOCAL_HOOKS_CONFIG="$(git -C "$TARGET_REPO" config --local --show-origin --get core.hooksPath 2>/dev/null || true)"
if [ -n "$EFFECTIVE_HOOKS_CONFIG" ] && [ "$EFFECTIVE_HOOKS_CONFIG" != "$LOCAL_HOOKS_CONFIG" ]; then
  echo "ERROR: refusing inherited core.hooksPath or effective override that is not repository-local." >&2
  exit 1
fi

if ! HOOK_DIR="$(git -C "$TARGET_REPO" rev-parse --path-format=absolute --git-path hooks 2>/dev/null)"; then
  echo "ERROR: not a git repository: $TARGET_REPO" >&2
  exit 1
fi

canonicalize_path() {
  local TARGET="$1"
  local SUFFIX=""
  local PART
  local PARENT

  while [ ! -e "$TARGET" ]; do
    PART="$(basename "$TARGET")"
    if [ -n "$SUFFIX" ]; then
      SUFFIX="$PART/$SUFFIX"
    else
      SUFFIX="$PART"
    fi
    PARENT="$(dirname "$TARGET")"
    [ "$PARENT" != "$TARGET" ] || return 1
    TARGET="$PARENT"
  done

  [ -d "$TARGET" ] || return 1
  TARGET="$(cd "$TARGET" && pwd -P)" || return 1
  if [ -n "$SUFFIX" ]; then
    printf '%s/%s\n' "$TARGET" "$SUFFIX"
  else
    printf '%s\n' "$TARGET"
  fi
}

path_identity() {
  local IDENTITY
  IDENTITY="$(stat -c '%d:%i' "$1" 2>/dev/null || stat -f '%d:%i' "$1" 2>/dev/null || true)"
  [ -n "$IDENTITY" ] || return 1
  printf '%s\n' "$IDENTITY"
}

path_is_within() {
  case "$1/" in
    "$2/"*) return 0 ;;
    *) return 1 ;;
  esac
}

hook_path_is_repository_local() {
  local ROOT_QUERY
  local ROOT
  local CANONICAL_ROOT
  for ROOT_QUERY in --show-toplevel --absolute-git-dir --git-common-dir; do
    ROOT="$(git -C "$TARGET_REPO" rev-parse --path-format=absolute "$ROOT_QUERY" 2>/dev/null || true)"
    [ -n "$ROOT" ] || continue
    CANONICAL_ROOT="$(canonicalize_path "$ROOT")" || continue
    path_is_within "$CANONICAL_HOOK_DIR" "$CANONICAL_ROOT" && return 0
  done
  return 1
}

original_hook_directory_matches_anchor() {
  local CURRENT_CANONICAL
  local ORIGINAL_IDENTITY
  [ -d "$HOOK_DIR" ] && [ ! -L "$HOOK_DIR" ] || return 1
  CURRENT_CANONICAL="$(cd "$HOOK_DIR" && pwd -P)" || return 1
  [ "$CURRENT_CANONICAL" = "$CANONICAL_HOOK_DIR" ] || return 1
  ORIGINAL_IDENTITY="$(path_identity "$HOOK_DIR")" || return 1
  [ "$ORIGINAL_IDENTITY" = "$HOOK_DIR_IDENTITY" ]
}

hook_directory_still_anchored() {
  local CURRENT_IDENTITY
  CURRENT_IDENTITY="$(path_identity .)" || return 1
  [ "$CURRENT_IDENTITY" = "$HOOK_DIR_IDENTITY" ] &&
    original_hook_directory_matches_anchor &&
    hook_path_is_repository_local
}

[ -d "$HOOK_DIR" ] && [ ! -L "$HOOK_DIR" ] || {
  echo "ERROR: refusing missing, symbolic, or non-directory hooks path: $HOOK_DIR" >&2
  exit 1
}
CANONICAL_HOOK_DIR="$(cd "$HOOK_DIR" && pwd -P)" || {
  echo "ERROR: cannot resolve hooks path: $HOOK_DIR" >&2
  exit 1
}
HOOK_DIR_IDENTITY="$(path_identity "$CANONICAL_HOOK_DIR")" || {
  echo "ERROR: cannot identify hooks directory: $HOOK_DIR" >&2
  exit 1
}
if ! hook_path_is_repository_local; then
  echo "ERROR: refusing core.hooksPath outside the repository worktree or Git directory." >&2
  exit 1
fi

if ! original_hook_directory_matches_anchor; then
  echo "ERROR: hooks directory changed during validation: $HOOK_DIR" >&2
  exit 1
fi

if ! cd "$CANONICAL_HOOK_DIR"; then
  echo "ERROR: cannot anchor hooks directory: $HOOK_DIR" >&2
  exit 1
fi
if ! hook_directory_still_anchored; then
  echo "ERROR: hooks directory changed during validation: $HOOK_DIR" >&2
  exit 1
fi

hook_destination_is_unsafe() {
  local DEST="$1"
  local LINK_COUNT

  [ -e "$DEST" ] || return 1
  [ -L "$DEST" ] && return 0
  [ -f "$DEST" ] || return 0
  LINK_COUNT="$(stat -c '%h' "$DEST" 2>/dev/null || stat -f '%l' "$DEST" 2>/dev/null || true)"
  [ "$LINK_COUNT" = "1" ] || return 0
  return 1
}

for NAME in post-commit commit-msg; do
  DEST="$NAME"
  if hook_destination_is_unsafe "$DEST"; then
    echo "ERROR: refusing symbolic or multiply-linked hook destination: $HOOK_DIR/$NAME" >&2
    exit 1
  fi
done

install_one() {
  local NAME="$1"
  local SRC="$SRC_DIR/$NAME"
  local DEST="$NAME"

  if ! hook_directory_still_anchored; then
    echo "ERROR: hooks directory changed during installation: $HOOK_DIR" >&2
    exit 1
  fi

  if hook_destination_is_unsafe "$DEST"; then
    echo "ERROR: refusing symbolic or multiply-linked hook destination: $HOOK_DIR/$NAME" >&2
    exit 1
  fi

  if [ ! -f "$SRC" ]; then
    echo "skip: $NAME source missing at $SRC"
    return 0
  fi

  if [ -f "$DEST" ] && ! grep -Fqx "# codex-rca-managed-hook: $NAME" "$DEST"; then
    echo "$NAME hook already exists and is not from claude-rca."
    echo "To chain: add 'bash $SRC' to your existing hook."
    exit 1
  fi

  local TEMP_DEST
  TEMP_DEST="$(mktemp ".codex-rca-$NAME.XXXXXX")" || {
    echo "ERROR: cannot create temporary hook in $HOOK_DIR" >&2
    exit 1
  }
  if ! install -m 0755 "$SRC" "$TEMP_DEST"; then
    rm -f -- "$TEMP_DEST"
    echo "ERROR: cannot prepare claude-rca $NAME hook." >&2
    exit 1
  fi
  if hook_destination_is_unsafe "$DEST"; then
    rm -f -- "$TEMP_DEST"
    echo "ERROR: refusing symbolic or multiply-linked hook destination: $DEST" >&2
    exit 1
  fi
  if ! hook_directory_still_anchored; then
    rm -f -- "$TEMP_DEST"
    echo "ERROR: hooks directory changed during installation: $HOOK_DIR" >&2
    exit 1
  fi
  if ! mv -f -- "$TEMP_DEST" "$DEST"; then
    rm -f -- "$TEMP_DEST"
    echo "ERROR: cannot publish claude-rca $NAME hook at $DEST" >&2
    exit 1
  fi
  if ! hook_directory_still_anchored; then
    echo "ERROR: hooks directory changed during installation: $HOOK_DIR" >&2
    exit 1
  fi
  echo "✓ installed claude-rca $NAME hook at $HOOK_DIR/$NAME"
}

install_one "post-commit"
install_one "commit-msg"

