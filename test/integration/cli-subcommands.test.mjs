import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProgram } from '../../src/cli.mjs';

function createFixtureDir() {
  const tmp = mkdtempSync(join(tmpdir(), 'claude-rca-cli-sub-'));
  const rcaDir = join(tmp, 'rca');
  mkdirSync(join(rcaDir, '2026', '01'), { recursive: true });
  writeFileSync(join(tmp, '.claude-rca.json'), JSON.stringify({ version: 1, output_dir: rcaDir }));
  const name = 'RCA-2026-01-01-abc0001-test-rca.md';
  writeFileSync(
    join(rcaDir, '2026', '01', name),
    '---\ntitle: "Test fix"\ntags: [rca]\n---\n\n## Symptom\n\nBroken\n\n## Root Cause\n\nBug\n',
  );
  return { tmp, rcaDir };
}

const EXIT_SENTINEL = Symbol('mock-exit');

async function capture(fn) {
  const out = [];
  const err = [];
  const exits = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origExit = process.exit;
  process.stdout.write = (c) => {
    out.push(String(c));
    return true;
  };
  process.stderr.write = (c) => {
    err.push(String(c));
    return true;
  };
  process.exit = (code) => {
    exits.push(code ?? 0);
    // Throw sentinel so the action handler's `throw err` never executes.
    // capture() catches and suppresses this sentinel below.
    const s = new Error('mock-process-exit');
    s[EXIT_SENTINEL] = true;
    throw s;
  };
  try {
    await fn();
  } catch (e) {
    if (!e[EXIT_SENTINEL]) throw e;
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exit = origExit;
  }
  return { stdout: out.join(''), stderr: err.join(''), exitCode: exits[0] ?? null };
}

describe('cli subcommands (via createProgram)', () => {
  it('recent: lists RCA basenames to stdout', async () => {
    const { tmp } = createFixtureDir();
    const { stdout } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'recent']),
    );
    assert.ok(stdout.includes('RCA-2026'), 'stdout must list an RCA basename');
  });

  it('recent --json: outputs a JSON array with basename and mtime', async () => {
    const { tmp } = createFixtureDir();
    const { stdout } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'recent', '--json']),
    );
    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed), 'output must be a JSON array');
    assert.ok(parsed.length > 0, 'array must not be empty');
    assert.ok('basename' in parsed[0], 'entries must have basename');
  });

  it('show: prints RCA content to stdout', async () => {
    const { tmp } = createFixtureDir();
    const { stdout } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'show', 'abc0001']),
    );
    assert.ok(stdout.includes('## Symptom'), 'show must print RCA markdown');
  });

  it('show: stderr and exit-code for an unknown id', async () => {
    const { tmp } = createFixtureDir();
    const { stderr, exitCode } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'show', 'totally-bogus-id']),
    );
    assert.ok(stderr.includes('RCA not found'), 'stderr must report the NOT_FOUND error');
    assert.ok(exitCode !== null && exitCode > 0, 'must exit with a non-zero code for NOT_FOUND');
  });

  it('config --list: outputs current config as valid JSON', async () => {
    const { tmp } = createFixtureDir();
    const { stdout } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'config', '--list']),
    );
    const parsed = JSON.parse(stdout);
    assert.ok(typeof parsed === 'object' && parsed !== null);
    assert.ok('output_dir' in parsed);
  });

  it('config --get: returns the output_dir value', async () => {
    const { tmp, rcaDir } = createFixtureDir();
    const { stdout } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'config', '--get', 'output_dir']),
    );
    assert.strictEqual(stdout.trim(), rcaDir);
  });

  it('config --set: writes a new value and confirms via stderr', async () => {
    const { tmp } = createFixtureDir();
    const newDir = join(tmp, 'custom-rca');
    const { stderr } = await capture(() =>
      createProgram().parseAsync([
        'node',
        'rca',
        '--cwd',
        tmp,
        'config',
        '--set',
        'output_dir=' + newDir,
      ]),
    );
    assert.ok(stderr.includes('set'), 'stderr must confirm the set operation');
  });
});
