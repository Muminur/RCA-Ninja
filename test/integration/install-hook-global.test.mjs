import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const INSTALLER = join(ROOT, 'hooks', 'install-hook.mjs');

/**
 * The global fallback exists so a fresh clone — which has no .git/hooks content
 * of its own — still gets a post-commit hook instead of silently getting none.
 * It has to be installable from the template, or the copy goes stale the next
 * time the template changes, recreating the silent failure it was meant to fix.
 */
function runGlobalInstall(home) {
  const gitconfig = join(home, '.gitconfig');
  writeFileSync(gitconfig, '');
  const res = spawnSync('node', [INSTALLER, '--global'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      GIT_CONFIG_GLOBAL: gitconfig,
    },
  });
  return { ...res, gitconfig };
}

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'claude-rca-global-'));
}

describe('install-hook --global', () => {
  it('writes post-commit into the global hooks dir from the template', () => {
    const home = makeHome();
    const { status, stdout, gitconfig } = runGlobalInstall(home);

    assert.strictEqual(status, 0, `installer must succeed, got:\n${stdout}`);
    const dest = join(home, '.git-hooks', 'post-commit');
    assert.ok(existsSync(dest), `expected a hook at ${dest}, output:\n${stdout}`);
    assert.strictEqual(
      readFileSync(dest, 'utf8'),
      readFileSync(join(ROOT, 'hooks', 'post-commit'), 'utf8'),
      'the global hook must be a verbatim copy of the template',
    );
    assert.ok(readFileSync(gitconfig, 'utf8').includes('hooksPath'), 'must set core.hooksPath');
  });

  it('never installs commit-msg globally', () => {
    const home = makeHome();
    runGlobalInstall(home);
    assert.ok(
      !existsSync(join(home, '.git-hooks', 'commit-msg')),
      'a global commit-msg would reject non-conventional commits in every repo on the machine',
    );
  });

  it('is idempotent and refreshes a stale copy', () => {
    const home = makeHome();
    runGlobalInstall(home);
    const dest = join(home, '.git-hooks', 'post-commit');
    writeFileSync(dest, '#!/usr/bin/env bash\n# claude-rca stale copy\nexit 0\n');

    const { status } = runGlobalInstall(home);

    assert.strictEqual(status, 0);
    assert.strictEqual(
      readFileSync(dest, 'utf8'),
      readFileSync(join(ROOT, 'hooks', 'post-commit'), 'utf8'),
      're-running must refresh a stale hook back to the template',
    );
  });

  it('respects an existing global core.hooksPath instead of relocating it', () => {
    const home = makeHome();
    const custom = join(home, 'my-hooks');
    mkdirSync(custom, { recursive: true });
    const gitconfig = join(home, '.gitconfig');
    writeFileSync(gitconfig, '');
    execFileSync('git', ['config', '--global', 'core.hooksPath', custom], {
      env: { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: gitconfig },
    });

    const res = spawnSync('node', [INSTALLER, '--global'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: gitconfig },
    });

    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.ok(
      existsSync(join(custom, 'post-commit')),
      'must install into the already-configured global hooks dir',
    );
  });
});
