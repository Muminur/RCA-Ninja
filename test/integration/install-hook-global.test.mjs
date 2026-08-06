import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { installGitDirectorySwapTrap, makeIsolatedGitEnv } from '../fixtures/isolated-git-env.mjs';

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

function assertNoManagedHooks(hooksDir) {
  assert.strictEqual(existsSync(join(hooksDir, 'post-commit')), false);
  assert.strictEqual(existsSync(join(hooksDir, 'commit-msg')), false);
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

  it('refuses command-scope hooksPath injection even when a local hooksPath exists', () => {
    const sharedHooks = mkdtempSync(join(tmpdir(), 'claude-rca-command-hooks-'));
    const { gitconfig, initialConfig, env } = makeSandbox('claude-rca-command-refuse-');
    const repo = makeRepo(env);

    const result = spawnSync('node', [INSTALLER, repo], {
      encoding: 'utf8',
      env: {
        ...env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: sharedHooks,
      },
    });

    assert.notStrictEqual(result.status, 0);
    assertNoManagedHooks(sharedHooks);
    assert.strictEqual(readFileSync(gitconfig, 'utf8'), initialConfig);
  });

  it('refuses ambient repository and legacy config redirection before installation', () => {
    const { gitconfig, initialConfig, env } = makeSandbox('claude-rca-env-refuse-');
    const targetRepo = makeRepo(env);
    const redirectedRepo = makeRepo(env);
    const legacyConfig = join(targetRepo, 'legacy.gitconfig');
    writeFileSync(legacyConfig, '[core]\n\thooksPath = ignored\n', 'utf8');
    const cases = [
      ['GIT_DIR', join(redirectedRepo, '.git')],
      ['GIT_WORK_TREE', redirectedRepo],
      ['GIT_COMMON_DIR', join(redirectedRepo, '.git')],
      ['GIT_CONFIG', legacyConfig],
      ['GIT_CONFIG_GLOBAL', legacyConfig],
      ['GIT_CONFIG_NOSYSTEM', '1'],
      ['GIT_ATTR_NOSYSTEM', '1'],
    ];

    for (const [key, value] of cases) {
      const result = spawnSync('node', [INSTALLER, targetRepo], {
        encoding: 'utf8',
        env: { ...env, [key]: value },
      });
      assert.notStrictEqual(result.status, 0, `${key} must be rejected`);
    }

    assertNoManagedHooks(join(targetRepo, '.git', 'hooks'));
    assertNoManagedHooks(join(redirectedRepo, '.git', 'hooks'));
    assert.strictEqual(readFileSync(gitconfig, 'utf8'), initialConfig);
  });

  it('refuses a repository-local hooksPath that resolves outside the repository', () => {
    const sharedHooks = mkdtempSync(join(tmpdir(), 'claude-rca-local-escape-'));
    const { gitconfig, initialConfig, env } = makeSandbox('claude-rca-local-escape-');
    const repo = makeRepo(env);
    execFileSync('git', ['config', '--local', 'core.hooksPath', sharedHooks], { cwd: repo, env });

    const result = spawnSync('node', [INSTALLER, repo], { encoding: 'utf8', env });

    assert.notStrictEqual(result.status, 0);
    assertNoManagedHooks(sharedHooks);
    assert.strictEqual(readFileSync(gitconfig, 'utf8'), initialConfig);
  });

  it('preserves an unrelated hook that merely mentions claude-rca', () => {
    const { env } = makeSandbox('claude-rca-unrelated-hook-');
    const repo = makeRepo(env);
    const hook = join(repo, '.git', 'hooks', 'post-commit');
    const unrelated =
      '#!/bin/sh\n# claude-rca compatibility is handled elsewhere\nprintf unrelated\n';
    writeFileSync(hook, unrelated, 'utf8');
    const originalInode = statSync(hook, { bigint: true }).ino;

    const result = spawnSync('node', [INSTALLER, repo], { encoding: 'utf8', env });

    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.ok(readFileSync(hook, 'utf8').startsWith(unrelated));
    assert.notStrictEqual(statSync(hook, { bigint: true }).ino, originalInode);
  });

  it('updates an ordinary managed hook without treating it as unsafe', () => {
    const { env } = makeSandbox('claude-rca-managed-update-');
    const repo = makeRepo(env);
    const hook = join(repo, '.git', 'hooks', 'post-commit');
    writeFileSync(hook, '#!/bin/sh\n# codex-rca-managed-hook: post-commit\nprintf old\n', 'utf8');
    const originalInode = statSync(hook, { bigint: true }).ino;

    const result = spawnSync('node', [INSTALLER, repo], { encoding: 'utf8', env });

    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /updated claude-rca post-commit/i);
    assert.doesNotMatch(readFileSync(hook, 'utf8'), /printf old/);
    assert.notStrictEqual(statSync(hook, { bigint: true }).ino, originalInode);
  });

  it('rejects managed and unrelated hooks hard-linked to external files', () => {
    const cases = [
      ['managed', '#!/bin/sh\n# codex-rca-managed-hook: post-commit\nprintf external\n'],
      ['unrelated', '#!/bin/sh\n# claude-rca compatibility only\nprintf external\n'],
    ];

    for (const [label, sentinelContent] of cases) {
      const { gitconfig, initialConfig, env } = makeSandbox(`claude-rca-hardlink-${label}-`);
      const repo = makeRepo(env);
      const externalRoot = mkdtempSync(join(tmpdir(), `claude-rca-hardlink-${label}-external-`));
      const sentinel = join(externalRoot, 'sentinel');
      const hook = join(repo, '.git', 'hooks', 'post-commit');
      writeFileSync(sentinel, sentinelContent, 'utf8');
      linkSync(sentinel, hook);

      const result = spawnSync('node', [INSTALLER, repo], { encoding: 'utf8', env });

      assert.notStrictEqual(result.status, 0, `${label} hard link must be rejected`);
      assert.strictEqual(readFileSync(sentinel, 'utf8'), sentinelContent);
      assert.strictEqual(readFileSync(hook, 'utf8'), sentinelContent);
      assert.strictEqual(existsSync(join(repo, '.git', 'hooks', 'commit-msg')), false);
      assert.strictEqual(readFileSync(gitconfig, 'utf8'), initialConfig);
    }
  });

  it('refuses a non-existent custom hooksPath instead of creating it', () => {
    const { gitconfig, initialConfig, env } = makeSandbox('claude-rca-missing-hooks-');
    const repo = makeRepo(env);
    const missingHooks = join(repo, 'missing-hooks');
    execFileSync('git', ['config', '--local', 'core.hooksPath', missingHooks], { cwd: repo, env });

    const result = spawnSync('node', [INSTALLER, repo], { encoding: 'utf8', env });

    assert.notStrictEqual(result.status, 0);
    assert.strictEqual(existsSync(missingHooks), false);
    assert.strictEqual(readFileSync(gitconfig, 'utf8'), initialConfig);
  });

  it('does not write through a hooks directory swapped during validation', () => {
    const { home, gitconfig, initialConfig, env } = makeSandbox('claude-rca-dir-swap-');
    const repo = makeRepo(env);
    const hooksDir = join(repo, '.git', 'hooks');
    const externalDir = mkdtempSync(join(tmpdir(), 'claude-rca-dir-swap-external-'));
    const swapTrap = installGitDirectorySwapTrap(home, { hooksDir, externalDir });

    const result = spawnSync('node', ['--require', swapTrap.nodePreload, INSTALLER, repo], {
      encoding: 'utf8',
      env: { ...env, ...swapTrap.env },
    });

    assert.strictEqual(existsSync(swapTrap.env.RCA_SWAP_MARKER), true);
    assert.notStrictEqual(result.status, 0);
    assert.deepStrictEqual(readdirSync(externalDir), []);
    assert.strictEqual(readFileSync(gitconfig, 'utf8'), initialConfig);
  });

  it('rejects when the original hooks path becomes a link to the moved directory', () => {
    const { home, gitconfig, initialConfig, env } = makeSandbox('claude-rca-dir-alias-');
    const repo = makeRepo(env);
    const hooksDir = join(repo, '.git', 'hooks');
    const externalRoot = mkdtempSync(join(tmpdir(), 'claude-rca-dir-alias-external-'));
    const movedHooksDir = join(externalRoot, 'moved-hooks');
    const swapTrap = installGitDirectorySwapTrap(home, {
      hooksDir,
      externalDir: movedHooksDir,
    });
    swapTrap.env.RCA_MOVED_HOOKS_DIR = movedHooksDir;

    const result = spawnSync('node', ['--require', swapTrap.nodePreload, INSTALLER, repo], {
      encoding: 'utf8',
      env: { ...env, ...swapTrap.env },
    });

    assert.strictEqual(existsSync(swapTrap.env.RCA_SWAP_MARKER), true);
    assert.notStrictEqual(result.status, 0);
    assert.strictEqual(existsSync(join(movedHooksDir, 'post-commit')), false);
    assert.strictEqual(existsSync(join(movedHooksDir, 'commit-msg')), false);
    assert.deepStrictEqual(
      readdirSync(movedHooksDir).filter((name) => name.startsWith('.codex-rca-')),
      [],
    );
    assert.strictEqual(readFileSync(gitconfig, 'utf8'), initialConfig);
  });

  it('preserves the original hook and cleans temp files when publish fails', () => {
    const { home, gitconfig, initialConfig, env } = makeSandbox('claude-rca-publish-fail-');
    const repo = makeRepo(env);
    const hooksDir = join(repo, '.git', 'hooks');
    const hook = join(hooksDir, 'post-commit');
    const original = '#!/bin/sh\n# codex-rca-managed-hook: post-commit\nprintf original\n';
    writeFileSync(hook, original, 'utf8');
    const preload = join(home, 'fail-rename.mjs');
    writeFileSync(
      preload,
      `import fs from 'node:fs';
import { basename } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const renameSync = fs.renameSync;
fs.renameSync = (source, destination) => {
  if (basename(destination) === 'post-commit') throw new Error('forced publish failure');
  return renameSync(source, destination);
};
syncBuiltinESMExports();
`,
      'utf8',
    );

    const result = spawnSync('node', ['--import', preload, INSTALLER, repo], {
      encoding: 'utf8',
      env,
    });

    assert.notStrictEqual(result.status, 0);
    assert.strictEqual(readFileSync(hook, 'utf8'), original);
    assert.deepStrictEqual(
      readdirSync(hooksDir).filter((name) => name.startsWith('.codex-rca-')),
      [],
    );
    assert.strictEqual(readFileSync(gitconfig, 'utf8'), initialConfig);
  });
});
