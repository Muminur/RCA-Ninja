import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

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

// Generation itself is fail-closed on this tree (no approved isolated provider
// broker), so these assert which commits the CLI *selects* — the trigger rule —
// by reading the per-commit progress it prints before calling a provider.
function runCli(args, cwd) {
  const result = spawnSync('node', [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
  });
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function selectedSubjects(output) {
  return [...output.matchAll(/^ {2}Processing [0-9a-f]{7}: (.+)$/gm)].map((m) => m[1].trim());
}

function writeConfig(tmp, extra = {}) {
  writeFileSync(
    join(tmp, '.claude-rca.json'),
    JSON.stringify({ version: 1, output_dir: './rca', ...extra }),
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
    git(['config', 'core.hooksPath', join(tmp, '.git', 'hooks')], tmp);
    writeConfig(tmp);

    commit(tmp, 'a.js', 'const a = 1;\n', 'feat: seed');
    base = git(['rev-parse', 'HEAD'], tmp);
    commit(tmp, 'a.js', 'const a = 2;\n', 'fix: correct a');
    commit(tmp, 'b.js', 'const b = 1;\n', 'feat: add b\n\nCloses #42\n');
    commit(tmp, 'c.js', 'const c = 1;\n', 'chore: tidy');
  });

  it('--since selects fix: and issue-closing feat:, and skips chore:', () => {
    // A fail-closed provider error stops the batch, so only the count line
    // reports the full selection.
    const out = runCli(['generate', '--since', base], tmp);
    assert.match(out, /Found 2 commit\(s\) to process\./, 'chore: must not be selected');
    assert.deepStrictEqual(selectedSubjects(out).slice(0, 1), ['feat: add b']);
  });

  it('--since skips a commit that already has an RCA', () => {
    const fixHash = git(['rev-parse', '--short=7', 'HEAD~2'], tmp);
    mkdirSync(join(tmp, 'rca', '2026', '01'), { recursive: true });
    writeFileSync(
      join(tmp, 'rca', '2026', '01', `RCA-2026-01-01-${fixHash}-already-analysed.md`),
      `---\ntitle: "Already analysed"\ndate: 2026-01-01T00:00:00Z\nref: "${fixHash}"\n---\n\n## Root Cause\n\nx\n`,
    );

    const out = runCli(['generate', '--since', base], tmp);
    assert.match(out, /Found 1 commit\(s\) to process\./, 'the analysed commit must be skipped');
    assert.deepStrictEqual(selectedSubjects(out), ['feat: add b']);
  });

  it('--max defers the overflow instead of firing every provider call at once', () => {
    const out = runCli(['generate', '--since', base, '--max', '1'], tmp);
    assert.match(out, /Found 1 commit\(s\) to process\./);
    assert.match(out, /1 more deferred by --max 1/);
  });

  it('--if-triggered declines a chore: commit before extracting anything', () => {
    const out = runCli(['generate', '--from', 'HEAD', '--if-triggered'], tmp);
    assert.match(out, /not an RCA trigger/);
    assert.doesNotMatch(out, /Extracting context/);
  });

  it('--if-triggered accepts a fix: commit', () => {
    const out = runCli(['generate', '--from', 'HEAD~2', '--if-triggered'], tmp);
    assert.doesNotMatch(out, /not an RCA trigger/);
    assert.match(out, /Extracting context/);
  });

  it('--if-triggered accepts a feat: commit whose body closes an issue', () => {
    const out = runCli(['generate', '--from', 'HEAD~1', '--if-triggered'], tmp);
    assert.doesNotMatch(out, /not an RCA trigger/);
  });

  it('triggers.commit_types opens the trigger up to other commit types', () => {
    // closes_issue off, so only the type list can explain a hit on chore:.
    writeConfig(tmp, { triggers: { commit_types: ['fix', 'chore'], closes_issue: false } });
    const out = runCli(['generate', '--from', 'HEAD', '--if-triggered'], tmp);
    assert.doesNotMatch(out, /not an RCA trigger/);
  });

  it('closes_issue: false stops an issue-closing feat: from triggering', () => {
    writeConfig(tmp, { triggers: { closes_issue: false } });
    const out = runCli(['generate', '--from', 'HEAD~1', '--if-triggered'], tmp);
    assert.match(out, /not an RCA trigger/);
  });

  it('config --set writes commit_types as an array', () => {
    runCli(['config', '--set', 'triggers.commit_types=fix,feat'], tmp);
    const value = runCli(['config', '--get', 'triggers.commit_types'], tmp);
    assert.deepStrictEqual(JSON.parse(value), ['fix', 'feat']);
  });
});
