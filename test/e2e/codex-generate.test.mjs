import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const BIN = join(ROOT, 'bin', 'claude-rca');
const CODEX_STUB = join(ROOT, 'test', 'fixtures', 'codex-stub.mjs');

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function setupRepo(tmp) {
  git(['init'], tmp);
  git(['config', 'user.email', 'test@test.com'], tmp);
  git(['config', 'user.name', 'Test'], tmp);
  // A large file so the diff exceeds the OS arg-length limit — proves the codex
  // adapter sends the prompt via stdin rather than argv.
  writeFileSync(join(tmp, 'file1.js'), 'console.log("x");\n' + 'a'.repeat(50000) + '\n');
  git(['add', '.'], tmp);
  git(['commit', '-m', 'fix: initial bug fix'], tmp);
}

function makeCodexConfig(tmp, overrides = {}) {
  const config = {
    version: 1,
    output_dir: './rca',
    provider: 'codex',
    codex: { binary: `node ${CODEX_STUB}`, ...overrides },
  };
  writeFileSync(join(tmp, '.claude-rca.json'), JSON.stringify(config));
}

function runCli(args, cwd, env = {}) {
  return execFileSync('node', [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 30000,
  });
}

function runCliErr(args, cwd, env = {}) {
  try {
    execFileSync('node', [BIN, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout: 30000,
    });
    assert.fail('Expected non-zero exit');
  } catch (err) {
    return err;
  }
}

describe('generate e2e — codex provider', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'claude-rca-codex-e2e-'));
    setupRepo(tmp);
  });

  it('generates an RCA via codex and writes to rca/ (even with a >32KB diff)', () => {
    makeCodexConfig(tmp);
    const stdout = runCli(['generate'], tmp);
    const rcaPath = stdout.trim();
    assert.ok(rcaPath.endsWith('.md'));
    assert.ok(existsSync(rcaPath));
    const content = readFileSync(rcaPath, 'utf8');
    assert.ok(content.includes('## Symptom'));
    assert.ok(content.includes('## Root Cause'));
  });

  it('invokes `codex exec` with read-only sandbox + output-schema in argv', () => {
    const logPath = join(tmp, 'codex.log');
    makeCodexConfig(tmp);
    runCli(['generate'], tmp, { CODEX_STUB_LOG: logPath });
    const entry = JSON.parse(readFileSync(logPath, 'utf8').trim().split('\n')[0]);
    assert.strictEqual(entry.argv[0], 'exec');
    const sIdx = entry.argv.indexOf('--sandbox');
    assert.ok(sIdx !== -1, '--sandbox must be present');
    assert.strictEqual(entry.argv[sIdx + 1], 'read-only');
    assert.ok(entry.argv.includes('--output-schema'), '--output-schema must be present');
    assert.ok(entry.argv.includes('-o'), '-o (output-last-message) must be present');
    // The huge diff must NOT be passed as an argv argument.
    assert.ok(
      !entry.argv.some((a) => a.length > 40000),
      'no argv entry should carry the large diff',
    );
  });

  it('codex stub exiting non-zero causes exit 21', () => {
    makeCodexConfig(tmp);
    const err = runCliErr(['generate'], tmp, { CODEX_STUB_EXIT: '1' });
    assert.strictEqual(err.status, 21);
  });

  it('codex stub returning invalid RCA causes exit 22', () => {
    makeCodexConfig(tmp);
    const err = runCliErr(['generate'], tmp, { CODEX_STUB_INVALID: '1' });
    assert.strictEqual(err.status, 22);
  });
});
