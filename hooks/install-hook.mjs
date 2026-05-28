#!/usr/bin/env node
// Cross-platform git hook installer for claude-rca.
// Replaces install-hook.sh — works on Windows (PowerShell, cmd) and Unix.
// Idempotent: re-running updates existing claude-rca hooks, chains with others.
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';
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
      process.platform === 'win32'
        ? `\nbash "${src}" "$@" || true\n`
        : `\n"${src}" "$@" || true\n`;

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

// --- Main ---
const cwd = process.argv[2] || process.cwd();
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
