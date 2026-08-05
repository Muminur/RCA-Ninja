import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { makeIsolatedGitEnv } from '../fixtures/isolated-git-env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const INSTALLER = join(ROOT, 'hooks', 'install-hook.mjs');

function makeSandbox(prefix, { globalHooksPath } = {}) {
  return makeIsolatedGitEnv(prefix, { globalHooksPath, userName: 'Isolated Test' });
}

function makeRepo(env, { setLocalHooksPath = true } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'claude-rca-local-hook-'));
  execFileSync('git', ['init', '-q'], { cwd: repo, env });
  if (setLocalHooksPath) {
    execFileSync('git', ['config', '--local', 'core.hooksPath', join(repo, '.git', 'hooks')], {
      cwd: repo,
      env,
    });
  }
  return repo;
}

function installNpmTrap(root) {
  const binDir = join(root, 'trap-bin');
  const marker = join(root, 'npm-was-invoked');
  mkdirSync(binDir, { recursive: true });
  if (process.platform === 'win32') {
    writeFileSync(
      join(binDir, 'npm.cmd'),
      `@echo off\r\n> "${marker}" echo invoked\r\nexit /b 99\r\n`,
      'utf8',
    );
  } else {
    const trap = join(binDir, 'npm');
    writeFileSync(trap, `#!/bin/sh\nprintf invoked > "${marker}"\nexit 99\n`, 'utf8');
    chmodSync(trap, 0o755);
  }
  return { marker, path: `${binDir}${delimiter}${process.env.PATH || ''}` };
}

describe('install-hook local-only safety', () => {
  it('--global refuses without writing hooks or mutating global Git config', () => {
    const { home, gitconfig, initialConfig, env } = makeSandbox('claude-rca-global-refuse-');
    const result = spawnSync('node', [INSTALLER, '--global'], { encoding: 'utf8', env });

    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /global hook installation is not supported/i);
    assert.strictEqual(readFileSync(gitconfig, 'utf8'), initialConfig);
    assert.strictEqual(existsSync(join(home, '.git-hooks', 'post-commit')), false);
    assert.strictEqual(existsSync(join(home, '.git-hooks', 'commit-msg')), false);
  });

  it('installs only into an explicit repository and leaves global config byte-identical', () => {
    const { home, gitconfig, initialConfig, env } = makeSandbox('claude-rca-local-install-');
    const repo = makeRepo(env);
    const npmTrap = installNpmTrap(home);

    const result = spawnSync('node', [INSTALLER, repo], {
      encoding: 'utf8',
      env: { ...env, PATH: npmTrap.path },
    });

    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.ok(existsSync(join(repo, '.git', 'hooks', 'post-commit')));
    assert.ok(existsSync(join(repo, '.git', 'hooks', 'commit-msg')));
    assert.strictEqual(readFileSync(gitconfig, 'utf8'), initialConfig);
    assert.strictEqual(existsSync(npmTrap.marker), false, 'installer must never invoke npm link');
  });

  it('refuses an implicit current-directory installation', () => {
    const { gitconfig, initialConfig, env } = makeSandbox('claude-rca-implicit-refuse-');
    const repo = makeRepo(env);

    const result = spawnSync('node', [INSTALLER], { cwd: repo, encoding: 'utf8', env });

    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /explicit repository path/i);
    assert.strictEqual(readFileSync(gitconfig, 'utf8'), initialConfig);
    assert.strictEqual(existsSync(join(repo, '.git', 'hooks', 'post-commit')), false);
  });

  it('refuses an inherited global hooksPath without writing shared hooks', () => {
    const sharedHooks = mkdtempSync(join(tmpdir(), 'claude-rca-shared-hooks-'));
    const { gitconfig, initialConfig, env } = makeSandbox('claude-rca-inherited-hooks-', {
      globalHooksPath: sharedHooks,
    });
    const repo = makeRepo(env, { setLocalHooksPath: false });

    const result = spawnSync('node', [INSTALLER, repo], { encoding: 'utf8', env });

    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /inherited core\.hooksPath/i);
    assert.strictEqual(existsSync(join(sharedHooks, 'post-commit')), false);
    assert.strictEqual(existsSync(join(sharedHooks, 'commit-msg')), false);
    assert.strictEqual(readFileSync(gitconfig, 'utf8'), initialConfig);
  });
});
