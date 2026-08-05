#!/usr/bin/env node
// Cross-platform, repository-local git hook installer for claude-rca.
// Idempotent: re-running updates existing claude-rca hooks and chains with others.
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SRC_DIR = dirname(__filename);
const HOOKS = ['post-commit', 'commit-msg'];
const MARKER = 'claude-rca';

function getHookDir(cwd) {
  try {
    const hookDir = execFileSync(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
    return hookDir ? resolve(cwd, hookDir) : null;
  } catch {
    return null;
  }
}

function gitConfig(cwd, scopeArgs) {
  try {
    return execFileSync('git', ['-C', cwd, 'config', ...scopeArgs, '--get', 'core.hooksPath'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function hasInheritedHooksPath(cwd) {
  const effective = gitConfig(cwd, []);
  const local = gitConfig(cwd, ['--local']);
  return effective !== '' && local === '';
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

  writeFileSync(dest, srcContent, { mode: 0o755 });
  try {
    chmodSync(dest, 0o755);
  } catch {
    // chmod may fail on Windows — the file is still created
  }
  console.log(`✓ installed claude-rca ${name} hook at ${dest}`);
  return true;
}

const args = process.argv.slice(2);
if (args.includes('--global')) {
  console.error(
    'Global hook installation is not supported; use an explicit local repository path.',
  );
  process.exit(1);
}

if (args.length !== 1 || args[0].startsWith('-')) {
  console.error('Hook installation requires one explicit repository path.');
  process.exit(1);
}

const cwd = resolve(args[0]);
const hookDir = getHookDir(cwd);

if (!hookDir) {
  console.error(`Not a git repository: ${cwd}`);
  process.exit(1);
}

if (hasInheritedHooksPath(cwd)) {
  console.error(
    'Refusing inherited core.hooksPath; configure an explicit repository-local hooks path first.',
  );
  process.exit(1);
}

mkdirSync(hookDir, { recursive: true });

let ok = true;
for (const name of HOOKS) {
  if (!installOne(name, hookDir)) ok = false;
}

process.exit(ok ? 0 : 1);
