#!/usr/bin/env node
// Cross-platform git hook installer for claude-rca.
// Replaces install-hook.sh — works on Windows (PowerShell, cmd) and Unix.
// Idempotent: re-running updates existing claude-rca hooks, chains with others.
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SRC_DIR = dirname(__filename);
const REPO_DIR = resolve(SRC_DIR, '..');
const HOOKS = ['post-commit', 'commit-msg'];
const MARKER = 'claude-rca';

function getHookDir(cwd) {
  try {
    return execSync('git rev-parse --git-path hooks', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function installOne(name, hookDir) {
  const src = join(SRC_DIR, name);
  const dest = join(hookDir, name);

  if (!existsSync(src)) {
    console.log(`skip: ${name} source missing at ${src}`);
    return true;
  }

  const srcContent = readFileSync(src, 'utf8');

  if (existsSync(dest)) {
    const existing = readFileSync(dest, 'utf8');

    if (existing.includes(MARKER)) {
      writeFileSync(dest, srcContent, { mode: 0o755 });
      console.log(`✓ updated claude-rca ${name} hook at ${dest}`);
      return true;
    }

    // Existing non-claude-rca hook — chain instead of refusing
    const chainLine =
      process.platform === 'win32' ? `\nbash "${src}" "$@" || true\n` : `\n"${src}" "$@" || true\n`;

    if (!existing.includes(src)) {
      writeFileSync(dest, existing.trimEnd() + '\n' + chainLine, { mode: 0o755 });
      console.log(`✓ chained claude-rca ${name} into existing hook at ${dest}`);
    } else {
      console.log(`✓ claude-rca ${name} already chained in ${dest}`);
    }
    return true;
  }

  // No existing hook — install fresh
  writeFileSync(dest, srcContent, { mode: 0o755 });
  try {
    chmodSync(dest, 0o755);
  } catch {
    // chmod may fail on Windows — the file is still created
  }
  console.log(`✓ installed claude-rca ${name} hook at ${dest}`);
  return true;
}

function ensureOnPath() {
  try {
    execSync(process.platform === 'win32' ? 'where.exe claude-rca' : 'which claude-rca', {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return;
  } catch {
    // not on PATH
  }

  console.log('claude-rca not on PATH — attempting npm link...');
  try {
    execSync('npm link', {
      cwd: REPO_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    });
    console.log('✓ npm link succeeded — claude-rca is now globally accessible');
  } catch {
    console.log(`⚠ npm link failed. Run manually: cd ${REPO_DIR} && npm link`);
  }
}

/**
 * Install the machine-wide fallback.
 *
 * `.git/hooks` is not version-controlled, so a fresh clone has no post-commit
 * hook and says nothing about it — a fix: commit just silently produces no RCA.
 * A global core.hooksPath closes that gap for every repo without a local
 * override. Only post-commit goes here: a global commit-msg would enforce
 * Conventional Commits in every repository on the machine.
 */
function installGlobal() {
  let hookDir = null;
  try {
    hookDir = execFileSync('git', ['config', '--global', '--get', 'core.hooksPath'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    hookDir = null;
  }

  if (!hookDir) {
    hookDir = join(homedir(), '.git-hooks');
    try {
      execFileSync('git', ['config', '--global', 'core.hooksPath', hookDir], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      console.log(`✓ set global core.hooksPath to ${hookDir}`);
    } catch {
      console.error(
        `⚠ could not set global core.hooksPath — run: git config --global core.hooksPath ${hookDir}`,
      );
      return false;
    }
  }

  mkdirSync(hookDir, { recursive: true });
  const ok = installOne('post-commit', hookDir);
  console.log(`  (global fallback only — commit-msg is intentionally per-repo)`);
  return ok;
}

// --- Main ---
const args = process.argv.slice(2);
const globalMode = args.includes('--global');

if (globalMode) {
  process.exit(installGlobal() ? 0 : 1);
}

const cwd = args[0] || process.cwd();
const hookDir = getHookDir(cwd);

if (!hookDir) {
  console.error('⚠ Not a git repository — skipping hook installation');
  process.exit(0);
}

mkdirSync(hookDir, { recursive: true });

let ok = true;
for (const name of HOOKS) {
  if (!installOne(name, hookDir)) ok = false;
}

ensureOnPath();
process.exit(ok ? 0 : 1);
