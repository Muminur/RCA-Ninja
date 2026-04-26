import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RcaError, ERROR_TABLE } from '../../src/errors.mjs';

describe('RcaError', () => {
  it('creates error with correct code and exit code', () => {
    const err = new RcaError('NO_DIFF', { ref: 'HEAD' });
    assert.strictEqual(err.code, 'NO_DIFF');
    assert.strictEqual(err.exitCode, 20);
    assert.strictEqual(err.category, 'input');
    assert.ok(err.message.includes('HEAD'));
  });

  it('substitutes all template placeholders', () => {
    const err = new RcaError('CLAUDE_FAILURE', { exitCode: 1, stderr_first_line: 'boom' });
    assert.ok(err.message.includes('1'));
    assert.ok(err.message.includes('boom'));
  });

  it('is an instance of Error', () => {
    const err = new RcaError('DISK_ERROR', { op: 'write', errno: 'ENOSPC' });
    assert.ok(err instanceof Error);
    assert.ok(err instanceof RcaError);
  });

  it('falls back to INTERNAL for unknown codes', () => {
    const err = new RcaError('TOTALLY_BOGUS');
    assert.strictEqual(err.code, 'INTERNAL');
    assert.strictEqual(err.exitCode, 100);
  });

  it('every table entry has category, exit, and template', () => {
    for (const [code, entry] of Object.entries(ERROR_TABLE)) {
      assert.ok(entry.category, `${code} missing category`);
      assert.ok(typeof entry.exit === 'number', `${code} missing exit`);
      assert.ok(typeof entry.template === 'string', `${code} missing template`);
    }
  });
});
