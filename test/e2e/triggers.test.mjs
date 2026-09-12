import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const BIN = join(ROOT, 'bin', 'claude-rca');
const STUB = join(ROOT, 'test', 'fixtures', 'claude-stub.mjs');

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function runCli(args, cwd) {
  const result = execFileSync('node', [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  });
  return result;
}

function countRcas(tmp) {
  const dir = join(tmp, 'rca');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { recursive: true }).filter(
    (e) => typeof e === 'string' && e.endsWith('.md') && e.includes('RCA-'),
  ).length;
}

function writeConfig(tmp, extra = {}) {
  writeFileSync(
    join(tmp, '.claude-rca.json'),
    JSON.stringify({
      version: 1,
      output_dir: './rca',
      claude: { binary: `node ${STUB}` },
      ...extra,
    }),
  );
}

function commit(tmp, file, body, message) {
  writeFileSync(join(tmp, file), body);
  git(['add', '.'], tmp);
  git(['commit', '-m', message], tmp);
}

describe('trigger selection end-to-end', () => {
  let tmp;
  let base;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'claude-rca-trig-'));
    git(['init', '-b', 'main'], tmp);
    git(['config', 'user.email', 'test@test.com'], tmp);
    git(['config', 'user.name', 'Test'], tmp);
    writeConfig(tmp);

    commit(tmp, 'a.js', 'const a = 1;\n', 'feat: seed');
    base = git(['rev-parse', 'HEAD'], tmp);
    commit(tmp, 'a.js', 'const a = 2;\n', 'fix: correct a');
    commit(tmp, 'b.js', 'const b = 1;\n', 'feat: add b\n\nCloses #42\n');
    commit(tmp, 'c.js', 'const c = 1;\n', 'chore: tidy');
  });

  it('--since analyses fix: and issue-closing feat:, and skips chore:', () => {
    const out = runCli(['generate', '--since', base], tmp);
    assert.strictEqual(countRcas(tmp), 2, `expected 2 RCAs, got output:\n${out}`);
  });

  it('--since is idempotent — a replayed range writes nothing new', () => {
    runCli(['generate', '--since', base], tmp);
    const first = countRcas(tmp);
    runCli(['generate', '--since', base], tmp);
    assert.strictEqual(countRcas(tmp), first, 'second run must not duplicate RCAs');
  });

  it('--max defers the overflow instead of firing every provider call at once', () => {
    runCli(['generate', '--since', base, '--max', '1'], tmp);
    assert.strictEqual(countRcas(tmp), 1);
    runCli(['generate', '--since', base, '--max', '1'], tmp);
    assert.strictEqual(countRcas(tmp), 2, 're-running must pick up the deferred commit');
  });

  it('--if-triggered skips a chore: commit without writing an RCA', () => {
    runCli(['generate', '--from', 'HEAD', '--if-triggered'], tmp);
    assert.strictEqual(countRcas(tmp), 0);
  });

  it('--if-triggered analyses a fix: commit', () => {
    runCli(['generate', '--from', 'HEAD~2', '--if-triggered'], tmp);
    assert.strictEqual(countRcas(tmp), 1);
  });

  it('triggers.commit_types opens the trigger up to plain feat: commits', () => {
    // HEAD~1 is "feat: add b ... Closes #42"; drop the keyword path so only the
    // type list can explain a hit.
    writeConfig(tmp, { triggers: { commit_types: ['fix', 'chore'], closes_issue: false } });
    runCli(['generate', '--from', 'HEAD', '--if-triggered'], tmp);
    assert.strictEqual(countRcas(tmp), 1, 'chore: must trigger once it is in commit_types');
  });

  it('config --set writes commit_types as an array', () => {
    runCli(['config', '--set', 'triggers.commit_types=fix,feat'], tmp);
    const value = runCli(['config', '--get', 'triggers.commit_types'], tmp);
    assert.deepStrictEqual(JSON.parse(value), ['fix', 'feat']);
  });
});
