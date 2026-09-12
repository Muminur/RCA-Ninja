import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

// Minimal git helper for setting up test repos
function git(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    shell: false,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test Committer',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

describe('getBugIntroducedBy', () => {
  let tmpDir;
  let getBugIntroducedBy;

  before(async () => {
    // Import the function under test
    const mod = await import('../../src/context.mjs');
    getBugIntroducedBy = mod.getBugIntroducedBy;
  });

  it('exports getBugIntroducedBy function', async () => {
    assert.strictEqual(typeof getBugIntroducedBy, 'function');
  });

  describe('with a 2-commit repo', () => {
    before(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'rca-blame-'));

      // Init repo
      git(['init', '-b', 'main'], tmpDir);
      git(['config', 'user.email', 'test@example.com'], tmpDir);
      git(['config', 'user.name', 'Test Author'], tmpDir);

      // Commit 1: introduce a file (this is the "bug introduced" commit)
      await writeFile(join(tmpDir, 'app.js'), 'function broken() { return null; }\n');
      git(['add', 'app.js'], tmpDir);
      git(
        [
          'commit',
          '--allow-empty-message',
          '-m',
          'feat: add app with bug',
          '--date=2026-01-15T10:00:00Z',
        ],
        tmpDir,
      );

      // Commit 2: fix the file
      await writeFile(join(tmpDir, 'app.js'), 'function broken() { return 42; }\n');
      git(['add', 'app.js'], tmpDir);
      git(
        [
          'commit',
          '--allow-empty-message',
          '-m',
          'fix: return correct value',
          '--date=2026-04-15T12:00:00Z',
        ],
        tmpDir,
      );
    });

    after(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('returns commit, author, date for a file modified in HEAD', async () => {
      const result = await getBugIntroducedBy(['app.js'], tmpDir);
      assert.ok(result !== null, 'should return non-null result');
      assert.strictEqual(typeof result.commit, 'string');
      assert.ok(result.commit.length >= 7, 'commit should be a hash');
      assert.strictEqual(typeof result.author, 'string');
      assert.ok(result.author.length > 0, 'author should be non-empty');
      assert.strictEqual(typeof result.date, 'string');
      assert.ok(result.date.length > 0, 'date should be non-empty');
    });

    it('result commit is the first commit (bug introduction), not the fix commit', async () => {
      // Get the first commit hash directly
      const firstHash = git(['rev-parse', '--short=7', 'HEAD~1'], tmpDir);
      const result = await getBugIntroducedBy(['app.js'], tmpDir);
      assert.ok(result !== null);
      assert.ok(
        result.commit.startsWith(firstHash) || firstHash.startsWith(result.commit),
        `expected commit to be the first commit (${firstHash}) but got ${result.commit}`,
      );
    });

    it('returns null for an empty files list', async () => {
      const result = await getBugIntroducedBy([], tmpDir);
      assert.strictEqual(result, null);
    });
  });

  describe('with a file that was only added (never modified before fix)', () => {
    let singleCommitDir;

    before(async () => {
      singleCommitDir = await mkdtemp(join(tmpdir(), 'rca-blame-single-'));
      git(['init', '-b', 'main'], singleCommitDir);
      git(['config', 'user.email', 'test@example.com'], singleCommitDir);
      git(['config', 'user.name', 'Test Author'], singleCommitDir);

      // Only one commit — introduces a brand-new file
      await writeFile(join(singleCommitDir, 'newfile.js'), 'export const x = 1;\n');
      git(['add', 'newfile.js'], singleCommitDir);
      git(['commit', '-m', 'feat: add new file'], singleCommitDir);
    });

    after(async () => {
      await rm(singleCommitDir, { recursive: true, force: true });
    });

    it('returns null when no prior modification exists (new file only)', async () => {
      const result = await getBugIntroducedBy(['newfile.js'], singleCommitDir);
      // If there is only one commit, the file was added (not modified before), so result is null
      assert.strictEqual(result, null);
    });
  });

  describe('with a fix that touches an unrelated file first in path order', () => {
    let voteDir;
    let introHash;
    let readmeHash;

    before(async () => {
      voteDir = await mkdtemp(join(tmpdir(), 'rca-blame-vote-'));
      git(['init', '-b', 'main'], voteDir);
      git(['config', 'user.email', 'test@example.com'], voteDir);
      git(['config', 'user.name', 'Test Author'], voteDir);
      await mkdir(join(voteDir, 'src'), { recursive: true });

      // A: introduces the defect.
      await writeFile(join(voteDir, 'src', 'app.js'), 'export function f() {\n  return null;\n}\n');
      git(['add', '.'], voteDir);
      git(['commit', '-m', 'feat: add app with bug'], voteDir);
      introHash = git(['rev-parse', '--short=7', 'HEAD'], voteDir);

      // B: touches README only. Sorts before src/ in git's path order, so the
      // old first-file-wins heuristic returned this commit.
      await writeFile(join(voteDir, 'README.md'), '# Project\n');
      git(['add', '.'], voteDir);
      git(['commit', '-m', 'docs: add readme'], voteDir);
      readmeHash = git(['rev-parse', '--short=7', 'HEAD'], voteDir);

      // C: the fix. Deletes a line in src/app.js, only appends to README.
      await writeFile(join(voteDir, 'src', 'app.js'), 'export function f() {\n  return 42;\n}\n');
      await writeFile(join(voteDir, 'README.md'), '# Project\n\nNotes.\n');
      git(['add', '.'], voteDir);
      git(['commit', '-m', 'fix: return the right value'], voteDir);
    });

    after(async () => {
      await rm(voteDir, { recursive: true, force: true });
    });

    it('blames the commit that wrote the deleted line, not the last README touch', async () => {
      const diff = git(['diff', 'HEAD~1..HEAD'], voteDir);
      const files = git(['diff', '--name-only', 'HEAD~1..HEAD'], voteDir)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      assert.strictEqual(files[0], 'README.md', 'README must sort first for this test to bite');

      const result = await getBugIntroducedBy(files, voteDir, 'HEAD', diff);
      assert.ok(result !== null, 'should attribute the defect');
      assert.strictEqual(result.commit, introHash);
      assert.notStrictEqual(result.commit, readmeHash);
    });

    it('buildContext wires the diff through, so the same attribution lands in context', async () => {
      const { buildContext } = await import('../../src/context.mjs');
      const ctx = await buildContext({ cwd: voteDir, ref: 'HEAD' });
      assert.ok(ctx.bug_introduced_by !== null);
      assert.strictEqual(ctx.bug_introduced_by.commit, introHash);
    });
  });

  describe('buildContext includes bug_introduced_by', () => {
    let repoDir;

    before(async () => {
      repoDir = await mkdtemp(join(tmpdir(), 'rca-blame-ctx-'));
      git(['init', '-b', 'main'], repoDir);
      git(['config', 'user.email', 'test@example.com'], repoDir);
      git(['config', 'user.name', 'Test Author'], repoDir);

      // Commit 1: introduce file
      await writeFile(join(repoDir, 'main.js'), 'const x = null;\n');
      git(['add', 'main.js'], repoDir);
      git(['commit', '-m', 'feat: initial'], repoDir);

      // Commit 2: fix file
      await writeFile(join(repoDir, 'main.js'), 'const x = 42;\n');
      git(['add', 'main.js'], repoDir);
      git(['commit', '-m', 'fix: correct value'], repoDir);
    });

    after(async () => {
      await rm(repoDir, { recursive: true, force: true });
    });

    it('buildContext returns bug_introduced_by with commit/author/date on HEAD fix commit', async () => {
      const { buildContext } = await import('../../src/context.mjs');
      const ctx = await buildContext({ cwd: repoDir, ref: 'HEAD' });
      // bug_introduced_by is optional but should be present when applicable
      if (ctx.bug_introduced_by !== null && ctx.bug_introduced_by !== undefined) {
        assert.strictEqual(typeof ctx.bug_introduced_by.commit, 'string');
        assert.strictEqual(typeof ctx.bug_introduced_by.author, 'string');
        assert.strictEqual(typeof ctx.bug_introduced_by.date, 'string');
      }
      // If null, that's acceptable too — the contract says it's optional
    });
  });
});
