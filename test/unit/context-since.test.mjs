import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

function git(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    shell: false,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@test.com',
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

describe('getFixCommits', () => {
  let tmpDir;
  let getFixCommits;
  let baseRef;

  before(async () => {
    const mod = await import('../../src/context.mjs');
    getFixCommits = mod.getFixCommits;

    tmpDir = mkdtempSync(join(tmpdir(), 'claude-rca-since-'));
    git(['init', '-b', 'main'], tmpDir);
    git(['config', 'user.email', 'test@test.com'], tmpDir);
    git(['config', 'user.name', 'Test'], tmpDir);

    writeFileSync(join(tmpDir, 'README.md'), 'initial');
    git(['add', '.'], tmpDir);
    git(['commit', '-m', 'chore: initial commit'], tmpDir);
    baseRef = git(['rev-parse', 'HEAD'], tmpDir);

    writeFileSync(join(tmpDir, 'a.js'), 'feature');
    git(['add', '.'], tmpDir);
    git(['commit', '-m', 'feat: add new feature'], tmpDir);

    writeFileSync(join(tmpDir, 'b.js'), 'fix');
    git(['add', '.'], tmpDir);
    git(['commit', '-m', 'fix: correct null check'], tmpDir);

    writeFileSync(join(tmpDir, 'c.js'), 'fix2');
    git(['add', '.'], tmpDir);
    git(['commit', '-m', 'fix(auth): handle missing token'], tmpDir);

    writeFileSync(join(tmpDir, 'd.js'), 'chore');
    git(['add', '.'], tmpDir);
    git(['commit', '-m', 'chore: update deps'], tmpDir);
  });

  after(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('returns only fix commits from range', async () => {
    const commits = await getFixCommits({ cwd: tmpDir, since: baseRef });
    assert.strictEqual(commits.length, 2, 'should return exactly 2 fix commits');
  });

  it('includes hash and subject per entry', async () => {
    const commits = await getFixCommits({ cwd: tmpDir, since: baseRef });
    const fix1 = commits.find((c) => c.subject.includes('null check'));
    assert.ok(fix1, 'should find fix: correct null check commit');
    assert.ok(fix1.hash && fix1.hash.length >= 7, 'should include hash');
    assert.ok(fix1.subject.startsWith('fix:'), 'subject should start with fix:');
  });

  it('matches fix(scope): commits', async () => {
    const commits = await getFixCommits({ cwd: tmpDir, since: baseRef });
    const fixScope = commits.find((c) => c.subject.includes('missing token'));
    assert.ok(fixScope, 'should find fix(auth): commit');
    assert.ok(fixScope.subject.startsWith('fix('), 'subject should start with fix(');
  });

  it('returns empty for empty range', async () => {
    const headRef = git(['rev-parse', 'HEAD'], tmpDir);
    const commits = await getFixCommits({ cwd: tmpDir, since: headRef });
    assert.strictEqual(commits.length, 0, 'empty range should return []');
  });

  it('excludes feat: commits', async () => {
    const commits = await getFixCommits({ cwd: tmpDir, since: baseRef });
    assert.ok(
      !commits.some((c) => c.subject.startsWith('feat:')),
      'should not include feat: commits',
    );
  });

  it('excludes chore: commits', async () => {
    const commits = await getFixCommits({ cwd: tmpDir, since: baseRef });
    assert.ok(
      !commits.some((c) => c.subject.startsWith('chore:')),
      'should not include chore: commits',
    );
  });
});
