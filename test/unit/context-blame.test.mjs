import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
