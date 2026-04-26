import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

describe('git module static invariants', () => {
  it('exec.mjs uses spawn with shell: false', () => {
    const src = readFileSync(join(ROOT, 'src', 'util', 'exec.mjs'), 'utf8');
    assert.ok(src.includes('shell: false'), 'exec.mjs must pass shell:false to spawn');
    assert.ok(!src.includes('child_process.exec('), 'exec.mjs must not use child_process.exec');
  });

  it('git.mjs never passes shell:true or uses exec(', () => {
    const src = readFileSync(join(ROOT, 'src', 'util', 'git.mjs'), 'utf8');
    assert.ok(!src.includes('shell: true'), 'git.mjs must not pass shell:true');
    assert.ok(!src.includes('child_process.exec('), 'git.mjs must not use child_process.exec');
  });

  it('git.mjs only invokes the git binary with no shell interpolation', () => {
    const src = readFileSync(join(ROOT, 'src', 'util', 'git.mjs'), 'utf8');
    assert.ok(!src.includes('`'), 'git.mjs must not use template literals in spawn args');
  });

  it('all run() calls in git.mjs use array args without string concatenation', () => {
    const src = readFileSync(join(ROOT, 'src', 'util', 'git.mjs'), 'utf8');
    const runCalls = src.match(/run\s*\([^)]+\)/g) || [];
    assert.ok(runCalls.length > 0, 'git.mjs must call run()');
    for (const call of runCalls) {
      assert.ok(!call.includes('+ '), `run() call must not use string concatenation: ${call}`);
    }
  });
});

describe('git module behavioral tests', () => {
  let tmp;

  function git(args, cwd) {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).trim();
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'claude-rca-git-'));
    git(['init'], tmp);
    git(['config', 'user.email', 'test@test.com'], tmp);
    git(['config', 'user.name', 'Test'], tmp);
    writeFileSync(join(tmp, 'a.js'), 'const x = 1;\n');
    git(['add', '.'], tmp);
    git(['commit', '-m', 'feat: initial'], tmp);
  });

  it('revParse returns a full SHA for HEAD', async () => {
    const { revParse } = await import('../../src/util/git.mjs');
    const sha = await revParse('HEAD', tmp);
    assert.match(sha, /^[0-9a-f]{40}$/);
  });

  it('shortHash returns exactly 7 hex chars', async () => {
    const { shortHash } = await import('../../src/util/git.mjs');
    const h = await shortHash('HEAD', tmp);
    assert.match(h, /^[0-9a-f]{7}$/);
  });

  it('commitMessage returns the commit message body', async () => {
    const { commitMessage } = await import('../../src/util/git.mjs');
    const msg = await commitMessage('HEAD', tmp);
    assert.ok(msg.includes('feat: initial'));
  });

  it('branch returns a non-empty string when on a branch', async () => {
    const { branch } = await import('../../src/util/git.mjs');
    const b = await branch(tmp);
    assert.ok(typeof b === 'string' && b.length > 0);
    assert.ok(b !== '(detached)');
  });

  it('branch returns (detached) when in detached HEAD state', async () => {
    const { branch } = await import('../../src/util/git.mjs');
    git(['checkout', '--detach', 'HEAD'], tmp);
    const b = await branch(tmp);
    assert.strictEqual(b, '(detached)');
  });

  it('diff returns non-empty content for a commit with changes', async () => {
    const { diff } = await import('../../src/util/git.mjs');
    const d = await diff('HEAD', tmp);
    assert.ok(d.length > 0);
    assert.ok(d.includes('a.js'));
  });

  it('filesChanged lists files modified in the commit', async () => {
    const { filesChanged } = await import('../../src/util/git.mjs');
    const files = await filesChanged('HEAD', tmp);
    assert.ok(Array.isArray(files));
    assert.ok(files.includes('a.js'));
  });

  it('repoRoot returns the tmp directory path', async () => {
    const { repoRoot } = await import('../../src/util/git.mjs');
    const root = await repoRoot(tmp);
    assert.strictEqual(root.replace(/\\/g, '/'), tmp.replace(/\\/g, '/'));
  });

  it('diff excludes package-lock.json', async () => {
    writeFileSync(join(tmp, 'package-lock.json'), '{"name":"test"}');
    git(['add', '.'], tmp);
    git(['commit', '-m', 'chore: add lockfile'], tmp);
    const { diff } = await import('../../src/util/git.mjs');
    const d = await diff('HEAD', tmp);
    assert.ok(!d.includes('package-lock.json'), 'package-lock.json must be excluded from diff');
  });
});
