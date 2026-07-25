import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { loadConfig } from '../../src/config.mjs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 't@t.local'], dir);
  git(['config', 'user.name', 'test'], dir);
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', 'chore: seed'], dir);
  return dir;
}

/** Case-insensitive path compare — Windows temp paths vary in drive/case. */
function samePath(a, b) {
  return a.replace(/[\\/]+/g, sep).toLowerCase() === b.replace(/[\\/]+/g, sep).toLowerCase();
}

describe('config discovery (worktree + subdirectory safe)', () => {
  let tmp;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'claude-rca-disc-')));
  });

  it('finds the project config from a subdirectory of the repo', () => {
    const repo = makeRepo(join(tmp, 'repo'));
    writeFileSync(
      join(repo, '.claude-rca.json'),
      JSON.stringify({ version: 1, auto_generate: true }),
    );
    const sub = join(repo, 'src', 'deep');
    mkdirSync(sub, { recursive: true });

    const cfg = loadConfig({ cwd: sub });

    assert.strictEqual(cfg.auto_generate, true, 'auto_generate must survive from a subdirectory');
    assert.ok(
      samePath(cfg.output_dir, join(repo, 'rca')),
      `relative output_dir must resolve against the config's project root, got ${cfg.output_dir}`,
    );
  });

  it('does NOT pick up a config outside the git repository', () => {
    // A stray config above the repo must not leak in (bounded walk).
    writeFileSync(
      join(tmp, '.claude-rca.json'),
      JSON.stringify({ version: 1, auto_generate: true, output_dir: './stray-rca' }),
    );
    const repo = makeRepo(join(tmp, 'repo'));

    const cfg = loadConfig({ cwd: repo });

    assert.notStrictEqual(cfg.auto_generate, true, 'stray config above the repo must be ignored');
    assert.ok(
      !cfg.output_dir.includes('stray-rca'),
      `must not adopt the stray config, got ${cfg.output_dir}`,
    );
  });

  it('finds the main-checkout config from inside a linked worktree', () => {
    const repo = makeRepo(join(tmp, 'repo'));
    // Mirrors the real setup: the config is gitignored, so it never exists in a worktree.
    writeFileSync(join(repo, '.gitignore'), '.claude-rca.json\n');
    git(['add', '.gitignore'], repo);
    git(['commit', '-q', '-m', 'chore: ignore config'], repo);
    writeFileSync(
      join(repo, '.claude-rca.json'),
      JSON.stringify({ version: 1, auto_generate: true }),
    );

    const wt = join(tmp, 'wt');
    git(['worktree', 'add', '-q', '-d', wt, 'HEAD'], repo);

    const cfg = loadConfig({ cwd: wt });

    assert.strictEqual(
      cfg.auto_generate,
      true,
      'worktree must fall back to the main checkout config',
    );
    assert.ok(
      samePath(cfg.output_dir, join(repo, 'rca')),
      `RCAs must be written to the main checkout, not the worktree, got ${cfg.output_dir}`,
    );
    assert.ok(
      !cfg.output_dir.toLowerCase().includes(`${sep}wt${sep}`.toLowerCase()),
      `output_dir must not live inside the worktree, got ${cfg.output_dir}`,
    );
  });

  it('prefers a config in cwd over the main-checkout fallback', () => {
    const repo = makeRepo(join(tmp, 'repo'));
    writeFileSync(
      join(repo, '.claude-rca.json'),
      JSON.stringify({ version: 1, output_dir: './main-rca' }),
    );
    const wt = join(tmp, 'wt');
    git(['worktree', 'add', '-q', '-d', wt, 'HEAD'], repo);
    writeFileSync(
      join(wt, '.claude-rca.json'),
      JSON.stringify({ version: 1, output_dir: './wt-rca' }),
    );

    const cfg = loadConfig({ cwd: wt });

    assert.ok(
      samePath(cfg.output_dir, join(wt, 'wt-rca')),
      `a config in cwd must win, got ${cfg.output_dir}`,
    );
  });

  it('falls back to cwd when there is no git repository at all', () => {
    const plain = join(tmp, 'plain');
    mkdirSync(plain, { recursive: true });

    const cfg = loadConfig({ cwd: plain });

    assert.ok(
      samePath(cfg.output_dir, join(plain, 'rca')),
      `non-git directories must still resolve against cwd, got ${cfg.output_dir}`,
    );
  });
});
