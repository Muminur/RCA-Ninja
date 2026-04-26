import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const BIN = join(ROOT, 'bin', 'claude-rca');

describe('claude-rca init', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'claude-rca-init-'));
  });

  it('creates .claude-rca.json and rca/ directory', () => {
    execFileSync('node', [BIN, 'init'], { cwd: tmp, encoding: 'utf8' });
    assert.ok(existsSync(join(tmp, '.claude-rca.json')));
    assert.ok(existsSync(join(tmp, 'rca')));
    assert.ok(statSync(join(tmp, 'rca')).isDirectory());

    const cfg = JSON.parse(readFileSync(join(tmp, '.claude-rca.json'), 'utf8'));
    assert.strictEqual(cfg.version, 1);
  });

  it('is idempotent — second run exits with code 10', () => {
    execFileSync('node', [BIN, 'init'], { cwd: tmp, encoding: 'utf8' });
    const before = readFileSync(join(tmp, '.claude-rca.json'), 'utf8');

    try {
      execFileSync('node', [BIN, 'init'], { cwd: tmp, encoding: 'utf8' });
      assert.fail('Second init should have exited non-zero');
    } catch (err) {
      assert.strictEqual(err.status, 10);
    }

    const after = readFileSync(join(tmp, '.claude-rca.json'), 'utf8');
    assert.strictEqual(before, after);
  });
});
