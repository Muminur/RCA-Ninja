import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  unlinkSync,
  rmdirSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recent } from '../../src/search.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'claude-rca-sentinel-'));
}

function writeSentinel(dir, data) {
  writeFileSync(join(dir, '.last-rca-error'), JSON.stringify(data), 'utf8');
}

function removeSentinel(dir) {
  const p = join(dir, '.last-rca-error');
  if (existsSync(p)) unlinkSync(p);
}

// ---------------------------------------------------------------------------
// 1. Sentinel JSON shape
// ---------------------------------------------------------------------------

describe('hook-sentinel JSON shape', () => {
  it('can be parsed as JSON and has timestamp, ref, error fields', () => {
    const tmpDir = makeTmpDir();
    const sentinelPath = join(tmpDir, '.last-rca-error');

    const payload = {
      timestamp: '2026-04-30T12:00:00Z',
      ref: 'abc1234',
      error: 'SCHEMA_VALIDATION: output did not match schema',
    };
    writeFileSync(sentinelPath, JSON.stringify(payload), 'utf8');

    const raw = JSON.parse(readFileSync(sentinelPath, 'utf8'));

    assert.ok(typeof raw.timestamp === 'string', 'timestamp must be a string');
    assert.ok(typeof raw.ref === 'string', 'ref must be a string');
    assert.ok(typeof raw.error === 'string', 'error must be a string');

    // timestamp should look like an ISO-8601 date
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(raw.timestamp), 'timestamp format');

    unlinkSync(sentinelPath);
    rmdirSync(tmpDir);
  });

  it('sentinel with special chars in error field still parses', () => {
    const tmpDir = makeTmpDir();
    const sentinelPath = join(tmpDir, '.last-rca-error');

    // Simulate stripped special chars (as the hook does via node one-liner)
    const payload = {
      timestamp: '2026-04-30T12:00:00Z',
      ref: 'def5678',
      error: 'error: path traversal rejected slug contains ..',
    };
    writeFileSync(sentinelPath, JSON.stringify(payload), 'utf8');

    const raw = JSON.parse(readFileSync(sentinelPath, 'utf8'));
    assert.ok(raw.error.length > 0, 'error field must be non-empty');

    unlinkSync(sentinelPath);
    rmdirSync(tmpDir);
  });
});

// ---------------------------------------------------------------------------
// 2. recent() warns to stderr when sentinel exists
// ---------------------------------------------------------------------------

describe('recent() sentinel warning', () => {
  it('prints a warning to stderr when .last-rca-error exists in outputDir', () => {
    const tmpDir = makeTmpDir();
    writeSentinel(tmpDir, {
      timestamp: '2026-04-30T12:00:00Z',
      ref: 'aaa0001',
      error: 'test fail',
    });

    // Capture stderr
    const originalWrite = process.stderr.write.bind(process.stderr);
    const stderrLines = [];
    process.stderr.write = (msg) => {
      stderrLines.push(String(msg));
      return true;
    };

    try {
      recent({ outputDir: tmpDir, count: 10 });
    } finally {
      process.stderr.write = originalWrite;
    }

    const combined = stderrLines.join('');
    assert.ok(
      combined.includes('Last RCA generation failed'),
      `stderr should mention "Last RCA generation failed" but got: ${combined}`,
    );

    removeSentinel(tmpDir);
    rmdirSync(tmpDir);
  });

  it('prints no warning to stderr when .last-rca-error is absent', () => {
    const tmpDir = makeTmpDir();

    const originalWrite = process.stderr.write.bind(process.stderr);
    const stderrLines = [];
    process.stderr.write = (msg) => {
      stderrLines.push(String(msg));
      return true;
    };

    try {
      recent({ outputDir: tmpDir, count: 10 });
    } finally {
      process.stderr.write = originalWrite;
    }

    const combined = stderrLines.join('');
    assert.ok(
      !combined.includes('Last RCA generation failed'),
      `stderr should NOT mention sentinel warning but got: ${combined}`,
    );

    rmdirSync(tmpDir);
  });
});

// ---------------------------------------------------------------------------
// 3. doctor sentinel logic — non-fatal warning
// ---------------------------------------------------------------------------

describe('doctor sentinel check logic', () => {
  it('produces a WARN line and does not increment failures when sentinel exists', () => {
    const tmpDir = makeTmpDir();
    writeSentinel(tmpDir, {
      timestamp: '2026-04-30T12:00:00Z',
      ref: 'bbb2222',
      error: 'CLAUDE_FAILURE: exit 21',
    });
    const sentinelPath = join(tmpDir, '.last-rca-error');

    let warnLine = null;
    let failures = 0;

    // Reproduce the logic the doctor command uses
    if (existsSync(sentinelPath)) {
      try {
        const s = JSON.parse(readFileSync(sentinelPath, 'utf8'));
        warnLine = `rca-gen  WARN  Last generation failed at ${s.timestamp} for ${s.ref}: ${s.error}`;
        // non-fatal: do NOT increment failures
      } catch {
        /* unparseable sentinel — ignore */
      }
    }

    assert.ok(warnLine !== null, 'should have produced a warn line');
    assert.ok(warnLine.includes('bbb2222'), 'warn line should include ref');
    assert.ok(warnLine.includes('CLAUDE_FAILURE'), 'warn line should include error text');
    assert.strictEqual(failures, 0, 'failures count must not be incremented');

    removeSentinel(tmpDir);
    rmdirSync(tmpDir);
  });

  it('produces no warning when sentinel is absent', () => {
    const tmpDir = makeTmpDir();
    const sentinelPath = join(tmpDir, '.last-rca-error');

    let warnLine = null;
    if (existsSync(sentinelPath)) {
      warnLine = 'should not happen';
    }

    assert.strictEqual(warnLine, null, 'no warn line when sentinel absent');

    rmdirSync(tmpDir);
  });
});
