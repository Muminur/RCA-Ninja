import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createProgram } from '../../src/cli.mjs';

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

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('config CLI does not fail silently', () => {
  it('--get on an unset key exits non-zero and prints no "undefined"', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'claude-rca-loud-'));
    writeFileSync(join(tmp, '.claude-rca.json'), JSON.stringify({ version: 1 }));

    const { stdout, exitCode } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'config', '--get', 'log.file']),
    );

    assert.ok(
      !stdout.includes('undefined'),
      `an unset key must never print the string "undefined" (callers use it as a filename), got ${JSON.stringify(stdout)}`,
    );
    assert.notStrictEqual(exitCode, 0, 'an unset key must signal failure via exit code');
    assert.notStrictEqual(exitCode, null, 'an unset key must call process.exit');
  });

  it('--get on a set key still prints the value and stays successful', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'claude-rca-loud-ok-'));
    writeFileSync(
      join(tmp, '.claude-rca.json'),
      JSON.stringify({ version: 1, auto_generate: true }),
    );

    const { stdout, exitCode } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'config', '--get', 'auto_generate']),
    );

    assert.strictEqual(stdout.trim(), 'true');
    assert.ok(exitCode === null || exitCode === 0, `expected success, got exit ${exitCode}`);
  });

  it('--set from a linked worktree edits the main config, not a new worktree copy', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'claude-rca-set-wt-'));
    const repo = join(tmp, 'repo');
    mkdirSync(repo, { recursive: true });
    git(['init', '-q', '-b', 'main'], repo);
    git(['config', 'user.email', 't@t.local'], repo);
    git(['config', 'user.name', 'test'], repo);
    writeFileSync(join(repo, 'seed.txt'), 'seed\n');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'chore: seed'], repo);
    writeFileSync(join(repo, '.claude-rca.json'), JSON.stringify({ version: 1 }, null, 2) + '\n');

    const wt = join(tmp, 'wt');
    git(['worktree', 'add', '-q', '-d', wt, 'HEAD'], repo);

    await capture(() =>
      createProgram().parseAsync([
        'node',
        'rca',
        '--cwd',
        wt,
        'config',
        '--set',
        'auto_generate=true',
      ]),
    );

    assert.ok(
      !existsSync(join(wt, '.claude-rca.json')),
      'must not create a stray config inside the worktree',
    );
    const main = JSON.parse(readFileSync(join(repo, '.claude-rca.json'), 'utf8'));
    assert.strictEqual(main.auto_generate, true, 'the main checkout config must be updated');
  });
});
