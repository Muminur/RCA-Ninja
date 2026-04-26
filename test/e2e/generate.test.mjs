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
const STUB = join(ROOT, 'test', 'fixtures', 'claude-stub.mjs');

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
  writeFileSync(join(tmp, 'file1.js'), 'console.log("hello");\n');
  git(['add', '.'], tmp);
  git(['commit', '-m', 'fix: initial bug fix'], tmp);
}

function makeConfig(tmp, overrides = {}) {
  const config = {
    version: 1,
    output_dir: './rca',
    claude: { binary: `node ${STUB}`, ...overrides },
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

describe('generate e2e', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'claude-rca-e2e-'));
    setupRepo(tmp);
  });

  it('generates an RCA with the stub and writes to rca/', () => {
    makeConfig(tmp);
    const stdout = runCli(['generate'], tmp);
    const rcaPath = stdout.trim();
    assert.ok(rcaPath.includes('rca'));
    assert.ok(rcaPath.endsWith('.md'));
    assert.ok(existsSync(rcaPath));
    const content = readFileSync(rcaPath, 'utf8');
    assert.ok(content.includes('## Symptom'));
    assert.ok(content.includes('## Root Cause'));
  });

  it('--dry-run prints path but writes nothing', () => {
    makeConfig(tmp);
    const stdout = runCli(['generate', '--dry-run'], tmp);
    const rcaPath = stdout.trim();
    assert.ok(rcaPath.endsWith('.md'));
    assert.ok(!existsSync(rcaPath));
  });

  it('stub returning invalid JSON causes exit 22', () => {
    makeConfig(tmp);
    const err = runCliErr(['generate'], tmp, { CLAUDE_STUB_INVALID: '1' });
    assert.strictEqual(err.status, 22);
  });

  it('stub exiting non-zero causes exit 21', () => {
    makeConfig(tmp);
    const err = runCliErr(['generate'], tmp, { CLAUDE_STUB_EXIT: '1' });
    assert.strictEqual(err.status, 21);
  });

  it('asserts --permission-mode plan in stub argv log', () => {
    const logPath = join(tmp, 'stub.log');
    makeConfig(tmp);
    runCli(['generate'], tmp, { CLAUDE_STUB_LOG: logPath });
    const log = readFileSync(logPath, 'utf8');
    const entry = JSON.parse(log.trim().split('\n')[0]);
    assert.ok(entry.argv.includes('--permission-mode'));
    const pmIdx = entry.argv.indexOf('--permission-mode');
    assert.strictEqual(entry.argv[pmIdx + 1], 'plan');
  });

  it('asserts --allowedTools in stub argv log', () => {
    const logPath = join(tmp, 'stub.log');
    makeConfig(tmp);
    runCli(['generate'], tmp, { CLAUDE_STUB_LOG: logPath });
    const log = readFileSync(logPath, 'utf8');
    const entry = JSON.parse(log.trim().split('\n')[0]);
    assert.ok(entry.argv.includes('--allowedTools'));
  });
});
