import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { installGitleaksStub } from '../fixtures/gitleaks-test-env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const BIN = join(ROOT, 'bin', 'claude-rca');

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'claude-rca-since-refusal-'));
  const repo = join(tmp, 'repo');
  mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@test.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  writeFileSync(join(repo, 'seed.js'), 'let a = 1;\n');
  git(['add', 'seed.js'], repo);
  git(['commit', '-q', '-m', 'chore: seed'], repo);
  const base = git(['rev-parse', 'HEAD'], repo);
  writeFileSync(join(repo, 'seed.js'), 'let a = 2;\n');
  git(['add', 'seed.js'], repo);
  git(['commit', '-q', '-m', 'fix: correct the off-by-one'], repo);
  writeFileSync(
    join(repo, '.claude-rca.json'),
    JSON.stringify({ version: 1, output_dir: './rca', provider: 'claude' }),
  );
  return { tmp, repo, base };
}

describe('generate --since provider refusal', () => {
  it('exits nonzero and writes no RCA when provider isolation is unavailable', () => {
    const { tmp, repo, base } = setup();
    try {
      const result = spawnSync('node', [BIN, 'generate', '--since', base], {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, PATH: installGitleaksStub(tmp) },
        timeout: 60000,
      });

      assert.strictEqual(result.status, 33, result.stderr);
      assert.ok(result.stderr.includes('provider execution was refused'));
      assert.ok(!result.stderr.includes('skipped'));
      assert.strictEqual(existsSync(join(repo, 'rca')), false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
