import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildContextPayload } from '../../src/generator.mjs';

const STUB_CONTEXT = {
  short_hash: 'abc1234',
  branch: 'main',
  commit_message: 'fix: null-pointer in auth',
  files_changed: ['src/auth.js'],
  logs: null,
};

describe('buildContextPayload', () => {
  it('includes prior_rcas when priorRcas is non-empty', () => {
    const priorRcas = [
      { title: 'Auth fails on timeout', root_cause: 'Missing null check', date: '2025-01-01', files: ['src/auth.js'] },
    ];
    const payload = buildContextPayload({ context: STUB_CONTEXT, priorRcas, diffFile: '/tmp/d.txt' });
    assert.ok(Array.isArray(payload.prior_rcas), 'prior_rcas should be an array');
    assert.deepStrictEqual(payload.prior_rcas, priorRcas);
  });

  it('omits prior_rcas when priorRcas is empty array', () => {
    const payload = buildContextPayload({ context: STUB_CONTEXT, priorRcas: [], diffFile: '/tmp/d.txt' });
    assert.ok(!('prior_rcas' in payload), 'prior_rcas should not be present for empty array');
  });

  it('omits prior_rcas when priorRcas is null', () => {
    const payload = buildContextPayload({ context: STUB_CONTEXT, priorRcas: null, diffFile: '/tmp/d.txt' });
    assert.ok(!('prior_rcas' in payload), 'prior_rcas should not be present for null');
  });

  it('omits prior_rcas when priorRcas is undefined', () => {
    const payload = buildContextPayload({ context: STUB_CONTEXT, diffFile: '/tmp/d.txt' });
    assert.ok(!('prior_rcas' in payload), 'prior_rcas should not be present for undefined');
  });

  it('always includes core fields', () => {
    const payload = buildContextPayload({ context: STUB_CONTEXT, diffFile: '/tmp/d.txt' });
    assert.strictEqual(payload.ref, STUB_CONTEXT.short_hash);
    assert.strictEqual(payload.branch, STUB_CONTEXT.branch);
    assert.strictEqual(payload.commit_message, STUB_CONTEXT.commit_message);
    assert.deepStrictEqual(payload.files_changed, STUB_CONTEXT.files_changed);
    assert.strictEqual(payload.diff_path, '/tmp/d.txt');
    assert.strictEqual(payload.logs, null);
  });

  it('handles multiple prior RCAs', () => {
    const priorRcas = [
      { title: 'First', root_cause: 'RC1', date: '2025-01-01', files: ['a.js'] },
      { title: 'Second', root_cause: 'RC2', date: '2025-02-01', files: ['a.js', 'b.js'] },
    ];
    const payload = buildContextPayload({ context: STUB_CONTEXT, priorRcas, diffFile: '/tmp/d.txt' });
    assert.strictEqual(payload.prior_rcas.length, 2);
    assert.strictEqual(payload.prior_rcas[0].title, 'First');
    assert.strictEqual(payload.prior_rcas[1].title, 'Second');
  });
});
