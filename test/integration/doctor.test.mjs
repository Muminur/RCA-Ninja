import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const BIN = join(ROOT, 'bin', 'claude-rca');

describe('doctor', () => {
  it('exits 0 when git is available', () => {
    const result = execFileSync('node', [BIN, 'doctor'], {
      encoding: 'utf8',
      cwd: ROOT,
      env: { ...process.env },
    });
    assert.ok(result.includes('git'));
  });

  it('reports node version', () => {
    const result = execFileSync('node', [BIN, 'doctor'], {
      encoding: 'utf8',
      cwd: ROOT,
    });
    assert.ok(result.includes('node'));
  });

  it('exits 70 when a critical tool is missing', () => {
    const nodeBin = process.execPath.replace(/[/\\][^/\\]+$/, '');
    try {
      execFileSync('node', [BIN, 'doctor'], {
        encoding: 'utf8',
        cwd: ROOT,
        env: { ...process.env, PATH: nodeBin, SystemRoot: process.env.SystemRoot || '' },
      });
      assert.fail('Should have exited non-zero with minimal PATH');
    } catch (err) {
      assert.strictEqual(err.status, 70);
    }
  });
});
