import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
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
    'exits unhealthy when tools are present but provider isolation is unavailable',
    { skip: !ALL_TOOLS_AVAILABLE ? 'not all tools on PATH' : false },
    () => {
      const { status } = runDoctor();
      assert.strictEqual(status, 70);
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

  it('prints a WARN line when .last-rca-error sentinel exists in output_dir', () => {
    // Create a tmpdir to serve as the output_dir with a sentinel file
    const tmpDir = mkdtempSync(join(tmpdir(), 'claude-rca-doctor-test-'));
    const sentinelPath = join(tmpDir, '.last-rca-error');
    const sentinelData = {
      timestamp: '2026-04-30T12:00:00Z',
      ref: 'abc1234',
      error: 'CLAUDE_FAILURE: exit 21',
    };
    writeFileSync(sentinelPath, JSON.stringify(sentinelData), 'utf8');

    // Write a minimal config pointing output_dir at our tmpDir
    const configPath = join(tmpDir, '.claude-rca.json');
    writeFileSync(configPath, JSON.stringify({ version: 1, output_dir: tmpDir }), 'utf8');

    const result = spawnSync('node', [BIN, '--config', configPath, '--cwd', tmpDir, 'doctor'], {
      encoding: 'utf8',
      cwd: ROOT,
    });

    // Clean up
    unlinkSync(sentinelPath);
    unlinkSync(configPath);
    rmdirSync(tmpDir);

    assert.ok(
      result.stdout.includes('WARN'),
      `doctor stdout should include WARN but got:\n${result.stdout}`,
    );
    assert.ok(
      result.stdout.includes('abc1234'),
      `doctor stdout should include ref abc1234 but got:\n${result.stdout}`,
    );
  });

  it('prints no WARN line when .last-rca-error sentinel is absent', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'claude-rca-doctor-test-'));
    const configPath = join(tmpDir, '.claude-rca.json');
    writeFileSync(configPath, JSON.stringify({ version: 1, output_dir: tmpDir }), 'utf8');

    const result = spawnSync('node', [BIN, '--config', configPath, '--cwd', tmpDir, 'doctor'], {
      encoding: 'utf8',
      cwd: ROOT,
    });

    // Clean up
    unlinkSync(configPath);
    rmdirSync(tmpDir);

    assert.ok(
      !result.stdout.includes('rca-gen  WARN'),
      `doctor stdout should NOT include WARN but got:\n${result.stdout}`,
    );
  });
});
