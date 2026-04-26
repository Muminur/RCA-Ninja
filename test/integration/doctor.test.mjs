import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const BIN = join(ROOT, 'bin', 'claude-rca');

function isToolAvailable(cmd) {
  try {
    return spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

const ALL_TOOLS_AVAILABLE =
  isToolAvailable('rg') && isToolAvailable('git') && isToolAvailable('claude');

function runDoctor(env = process.env) {
  return spawnSync('node', [BIN, 'doctor'], { encoding: 'utf8', cwd: ROOT, env });
}

describe('doctor', () => {
  it('reports node version regardless of other tool availability', () => {
    const { stdout } = runDoctor();
    assert.ok(stdout.includes('node'), 'doctor output must report node');
  });

  it('reports git status regardless of other tool availability', () => {
    const { stdout } = runDoctor();
    assert.ok(stdout.includes('git'), 'doctor output must report git');
  });

  it(
    'exits 0 when all tools are present',
    { skip: !ALL_TOOLS_AVAILABLE ? 'not all tools on PATH' : false },
    () => {
      const { status } = runDoctor();
      assert.strictEqual(status, 0);
    },
  );

  it('exits 70 when a critical tool is completely absent', () => {
    const nodeBin = process.execPath.replace(/[/\\][^/\\]+$/, '');
    const { status } = runDoctor({
      PATH: nodeBin,
      SystemRoot: process.env.SystemRoot || '',
    });
    assert.strictEqual(status, 70);
  });
});
