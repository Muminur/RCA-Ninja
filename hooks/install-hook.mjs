#!/usr/bin/env node
// Cross-platform, repository-local git hook installer for claude-rca.
// Idempotent: re-running updates existing claude-rca hooks and chains with others.
import {
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  lstatSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SRC_DIR = dirname(__filename);
const HOOKS = ['post-commit', 'commit-msg'];

function unsafeGitEnvironmentVariable() {
  return Object.keys(process.env).find((name) => {
    const normalized = name.toUpperCase();
    return (
      normalized.startsWith('GIT_CONFIG') ||
      normalized === 'GIT_DIR' ||
      normalized === 'GIT_WORK_TREE' ||
      normalized === 'GIT_COMMON_DIR' ||
      normalized === 'GIT_ATTR_NOSYSTEM'
    );
  });
}

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
    return execFileSync(
      'git',
      ['-C', cwd, 'config', ...scopeArgs, '--show-origin', '--get', 'core.hooksPath'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
  } catch {
    return '';
  }
}

function hasNonLocalHooksPath(cwd) {
  const effective = gitConfig(cwd, []);
  const local = gitConfig(cwd, ['--local']);
  return effective !== '' && effective !== local;
}

function canonicalizePath(path) {
  let existing = resolve(path);
  const missing = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return null;
    missing.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...missing);
}

function gitPath(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function isWithin(path, root) {
  const child = relative(root, path);
  return (
    child === '' ||
    (!child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
      child !== '..' &&
      !isAbsolute(child))
  );
}

function hookDirIsRepositoryLocal(cwd, hookDir) {
  const canonicalHookDir = canonicalizePath(hookDir);
  if (!canonicalHookDir) return false;
  const roots = [
    gitPath(cwd, ['--show-toplevel']),
    gitPath(cwd, ['--absolute-git-dir']),
    gitPath(cwd, ['--git-common-dir']),
  ];
  return roots.some((root) => {
    const canonicalRoot = root ? canonicalizePath(root) : null;
    return canonicalRoot ? isWithin(canonicalHookDir, canonicalRoot) : false;
  });
}

function getHookDirectoryAnchor(hookDir) {
  try {
    const linkStat = lstatSync(hookDir);
    if (linkStat.isSymbolicLink() || !linkStat.isDirectory()) return null;
    const canonicalPath = realpathSync(hookDir);
    const identity = statSync(canonicalPath, { bigint: true });
    return { canonicalPath, dev: identity.dev, ino: identity.ino };
  } catch {
    return null;
  }
}

function pathMatchesAnchor(path, anchor) {
  try {
    const identity = statSync(path, { bigint: true });
    return identity.isDirectory() && identity.dev === anchor.dev && identity.ino === anchor.ino;
  } catch {
    return false;
  }
}

function originalHookDirectoryMatchesAnchor(originalHookDir, anchor) {
  try {
    const linkStat = lstatSync(originalHookDir);
    return (
      linkStat.isDirectory() &&
      !linkStat.isSymbolicLink() &&
      realpathSync(originalHookDir) === anchor.canonicalPath &&
      pathMatchesAnchor(originalHookDir, anchor)
    );
  } catch {
    return false;
  }
}

function hookDirectoryStillAnchored(cwd, originalHookDir, anchor) {
  return (
    pathMatchesAnchor('.', anchor) &&
    originalHookDirectoryMatchesAnchor(originalHookDir, anchor) &&
    hookDirIsRepositoryLocal(cwd, anchor.canonicalPath)
  );
}

function quoteShellSingle(value) {
  return `'${String(value).replaceAll(`'`, `'\\''`)}'`;
}

function unsafeHookDestination(name, hookDir) {
  const dest = join(hookDir, name);
  try {
    const stat = lstatSync(dest);
    return stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1n ? dest : null;
  } catch (error) {
    return error?.code === 'ENOENT' ? null : dest;
  }
}

function replaceHook(name, hookDir, content, cwd, originalHookDir, anchor) {
  const dest = join(hookDir, name);
  const temp = join(hookDir, `.codex-rca-${name}-${process.pid}-${randomUUID()}.tmp`);
  try {
    if (!hookDirectoryStillAnchored(cwd, originalHookDir, anchor)) {
      console.error(`Hook directory changed during installation: ${originalHookDir}`);
      return false;
    }
    writeFileSync(temp, content, { flag: 'wx', mode: 0o755 });
    try {
      chmodSync(temp, 0o755);
    } catch {
      // chmod may fail on Windows; the safely created temp file is still publishable.
    }

    if (unsafeHookDestination(name, hookDir)) {
      console.error(`Refusing symbolic or multiply-linked hook destination: ${dest}`);
      return false;
    }
    if (!hookDirectoryStillAnchored(cwd, originalHookDir, anchor)) {
      console.error(`Hook directory changed during installation: ${originalHookDir}`);
      return false;
    }

    renameSync(temp, dest);
    if (!hookDirectoryStillAnchored(cwd, originalHookDir, anchor)) {
      console.error(`Hook directory changed during installation: ${originalHookDir}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error(`Failed to replace hook at ${dest}: ${error?.message || String(error)}`);
    return false;
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // The successful rename consumed the temp path; failed attempts are cleaned up.
    }
  }
}

function installOne(name, hookDir, cwd, originalHookDir, anchor) {
  const src = join(SRC_DIR, name);
  const dest = join(hookDir, name);

  if (unsafeHookDestination(name, hookDir)) {
    console.error(`Refusing symbolic or multiply-linked hook destination: ${dest}`);
    return false;
  }

  if (!existsSync(src)) {
    console.log(`skip: ${name} source missing at ${src}`);
    return true;
  }

  const srcContent = readFileSync(src, 'utf8');

  if (existsSync(dest)) {
    const existing = readFileSync(dest, 'utf8');

    if (existing.split(/\r?\n/).includes(`# codex-rca-managed-hook: ${name}`)) {
      if (!replaceHook(name, hookDir, srcContent, cwd, originalHookDir, anchor)) return false;
      console.log(`✓ updated claude-rca ${name} hook at ${dest}`);
      return true;
    }

    const quotedSrc = quoteShellSingle(src);
    const chainLine =
      process.platform === 'win32'
        ? `\nbash ${quotedSrc} "$@" || true\n`
        : `\n${quotedSrc} "$@" || true\n`;
    const chainLineCandidates = [
      process.platform === 'win32' ? `\nbash "${src}" "$@" || true\n` : `\n"${src}" "$@" || true\n`,
      chainLine,
    ];

    if (!chainLineCandidates.some((candidate) => existing.includes(candidate))) {
      if (
        !replaceHook(
          name,
          hookDir,
          existing.trimEnd() + '\n' + chainLine,
          cwd,
          originalHookDir,
          anchor,
        )
      )
        return false;
      console.log(`✓ chained claude-rca ${name} into existing hook at ${dest}`);
    } else {
      console.log(`✓ claude-rca ${name} already chained in ${dest}`);
    }
    return true;
  }

  if (!replaceHook(name, hookDir, srcContent, cwd, originalHookDir, anchor)) return false;
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
const unsafeEnvironment = unsafeGitEnvironmentVariable();
if (unsafeEnvironment) {
  console.error(`Refusing unsafe Git environment variable: ${unsafeEnvironment}`);
  process.exit(1);
}

const hookDir = getHookDir(cwd);

if (!hookDir) {
  console.error(`Not a git repository: ${cwd}`);
  process.exit(1);
}

if (hasNonLocalHooksPath(cwd)) {
  console.error(
    'Refusing inherited core.hooksPath or effective override that is not repository-local.',
  );
  process.exit(1);
}

const hookDirectoryAnchor = getHookDirectoryAnchor(hookDir);
if (!hookDirectoryAnchor) {
  console.error(`Refusing missing, symbolic, or non-directory hooks path: ${hookDir}`);
  process.exit(1);
}

if (!hookDirIsRepositoryLocal(cwd, hookDirectoryAnchor.canonicalPath)) {
  console.error('Refusing core.hooksPath outside the repository worktree or Git directory.');
  process.exit(1);
}

if (!originalHookDirectoryMatchesAnchor(hookDir, hookDirectoryAnchor)) {
  console.error(`Hook directory changed during validation: ${hookDir}`);
  process.exit(1);
}

try {
  process.chdir(hookDirectoryAnchor.canonicalPath);
} catch {
  console.error(`Cannot anchor hooks directory: ${hookDir}`);
  process.exit(1);
}
if (!hookDirectoryStillAnchored(cwd, hookDir, hookDirectoryAnchor)) {
  console.error(`Hook directory changed during validation: ${hookDir}`);
  process.exit(1);
}

const anchoredHookDir = '.';
const unsafeDestination = HOOKS.map((name) => unsafeHookDestination(name, anchoredHookDir)).find(
  Boolean,
);
if (unsafeDestination) {
  console.error(
    `Refusing symbolic or multiply-linked hook destination: ${join(hookDir, basename(unsafeDestination))}`,
  );
  process.exit(1);
}

let ok = true;
for (const name of HOOKS) {
  if (!installOne(name, anchoredHookDir, cwd, hookDir, hookDirectoryAnchor)) {
    ok = false;
    break;
  }
}

process.exit(ok ? 0 : 1);
