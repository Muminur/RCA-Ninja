import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { buildContext } from '../../src/context.mjs';

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function setupRepo(tmp, commitCount = 3) {
  git(['init'], tmp);
  git(['config', 'user.email', 'test@test.com'], tmp);
  git(['config', 'user.name', 'Test'], tmp);

  for (let i = 1; i <= commitCount; i++) {
    writeFileSync(join(tmp, `file${i}.js`), `console.log(${i});\n`);
    git(['add', '.'], tmp);
    git(['commit', '-m', `fix: commit ${i}`], tmp);
  }
}

describe('context extraction', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'claude-rca-ctx-'));
  });

  it('builds context from HEAD of a 3-commit repo', async () => {
    setupRepo(tmp, 3);
    const ctx = await buildContext({ cwd: tmp });
    assert.strictEqual(typeof ctx.ref, 'string');
    assert.strictEqual(ctx.short_hash.length, 7);
    assert.ok(ctx.commit_message.includes('commit 3'));
    assert.ok(ctx.diff.length > 0);
    assert.ok(ctx.files_changed.length > 0);
    assert.strictEqual(ctx.diff_truncated, false);
    assert.ok(ctx.timestamp_utc);
  });

  it('builds context from HEAD~1', async () => {
    setupRepo(tmp, 3);
    const ctx = await buildContext({ cwd: tmp, ref: 'HEAD~1' });
    assert.ok(ctx.commit_message.includes('commit 2'));
  });

  it('single-commit repo falls back to empty-tree compare', async () => {
    setupRepo(tmp, 1);
    const ctx = await buildContext({ cwd: tmp });
    assert.ok(ctx.diff.length > 0);
    assert.ok(ctx.files_changed.includes('file1.js'));
  });

  it('non-existent ref throws NO_DIFF', async () => {
    setupRepo(tmp, 1);
    await assert.rejects(
      () => buildContext({ cwd: tmp, ref: 'nonexistent-ref-abc123' }),
      (err) => err.code === 'NO_DIFF',
    );
  });

  it('empty diff throws NO_DIFF', async () => {
    setupRepo(tmp, 1);
    git(['commit', '--allow-empty', '-m', 'chore: empty commit'], tmp);
    await assert.rejects(
      () => buildContext({ cwd: tmp }),
      (err) => err.code === 'NO_DIFF',
    );
  });

  it('diff >200KB is truncated', async () => {
    setupRepo(tmp, 1);
    writeFileSync(join(tmp, 'big.txt'), 'x'.repeat(250 * 1024));
    git(['add', '.'], tmp);
    git(['commit', '-m', 'fix: big file'], tmp);
    const ctx = await buildContext({ cwd: tmp });
    assert.strictEqual(ctx.diff_truncated, true);
    assert.ok(ctx.diff.length <= 200 * 1024 + 100);
  });

  it('excludes package-lock.json from diff', async () => {
    setupRepo(tmp, 1);
    writeFileSync(join(tmp, 'package-lock.json'), '{"lockfileVersion": 3}');
    writeFileSync(join(tmp, 'real.js'), 'console.log("real");\n');
    git(['add', '.'], tmp);
    git(['commit', '-m', 'fix: with lockfile'], tmp);
    const ctx = await buildContext({ cwd: tmp });
    assert.ok(!ctx.diff.includes('lockfileVersion'));
    assert.ok(ctx.diff.includes('real'));
  });

  it('detached HEAD sets branch to (detached)', async () => {
    setupRepo(tmp, 3);
    const hash = git(['rev-parse', 'HEAD~1'], tmp);
    git(['checkout', hash], tmp);
    const ctx = await buildContext({ cwd: tmp, ref: 'HEAD' });
    assert.strictEqual(ctx.branch, '(detached)');
  });
});
