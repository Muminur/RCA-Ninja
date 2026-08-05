import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { generate } from '../../src/generator.mjs';
import {
  installGitleaksStub,
  scannerReceiptMarker,
  scannerRejectPayload,
} from '../fixtures/gitleaks-test-env.mjs';

function generationInput(dir, overrides = {}) {
  const systemPromptPath = join(dir, 'system-prompt.txt');
  const schemaPath = join(dir, 'schema.json');
  writeFileSync(systemPromptPath, overrides.systemPrompt || 'system prompt sentinel', 'utf8');
  writeFileSync(schemaPath, JSON.stringify({ type: 'object', marker: 'schema sentinel' }), 'utf8');
  return {
    context: {
      short_hash: 'abc1234',
      branch: 'main',
      commit_message: 'fix: refuse unisolated providers',
      files_changed: ['src/provider.mjs'],
      logs: 'log sentinel',
      diff: 'diff sentinel',
    },
    config: { provider: 'claude' },
    systemPromptPath,
    schemaPath,
    priorRcas: [{ title: 'prior RCA sentinel' }],
    correctionHint: 'correction sentinel',
  };
}

describe('generate provider security gate', () => {
  it('scans input and refuses provider isolation while ignoring public bypasses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rca-generate-isolation-'));
    const receiptPath = join(dir, 'scanner-receipt.json');
    const originalPath = process.env.PATH;
    let injectedScanCalls = 0;
    let injectedRunCalls = 0;

    try {
      process.env.PATH = installGitleaksStub(dir);
      const input = generationInput(dir, {
        systemPrompt: `system prompt sentinel\n${scannerReceiptMarker(receiptPath)}`,
      });

      await assert.rejects(
        () =>
          generate({
            ...input,
            _scanFn: async () => {
              injectedScanCalls += 1;
            },
            _runFn: async () => {
              injectedRunCalls += 1;
              throw Object.assign(new Error('private provider diagnostic'), {
                code: 'SECRET_SCAN_FAILED',
              });
            },
          }),
        (error) => {
          assert.strictEqual(error.code, 'PROVIDER_ISOLATION_UNAVAILABLE');
          assert.strictEqual(
            error.message,
            'No approved isolated provider broker is available; provider execution was refused.',
          );
          assert.deepStrictEqual(error.context, {});
          return true;
        },
      );

      assert.strictEqual(injectedScanCalls, 0);
      assert.strictEqual(injectedRunCalls, 0);
      const scanned = JSON.parse(readFileSync(receiptPath, 'utf8'));
      assert.deepStrictEqual(Object.keys(scanned), [
        'systemPrompt',
        'schema',
        'context',
        'priorRcas',
        'correctionHint',
      ]);
      assert.ok(scanned.systemPrompt.includes('system prompt sentinel'));
      assert.ok(scanned.schema.includes('schema sentinel'));
      assert.deepStrictEqual(scanned.context, input.context);
      assert.strictEqual(scanned.context.diff, 'diff sentinel');
      assert.strictEqual(scanned.context.logs, 'log sentinel');
      assert.strictEqual(scanned.context.branch, 'main');
      assert.strictEqual(scanned.context.commit_message, 'fix: refuse unisolated providers');
      assert.deepStrictEqual(scanned.context.files_changed, ['src/provider.mjs']);
      assert.deepStrictEqual(scanned.priorRcas, [{ title: 'prior RCA sentinel' }]);
      assert.strictEqual(scanned.correctionHint, 'correction sentinel');
    } finally {
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends explicit null optionals through the real scanner path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rca-generate-null-payload-'));
    const receiptPath = join(dir, 'scanner-receipt.json');
    const originalPath = process.env.PATH;

    try {
      process.env.PATH = installGitleaksStub(dir);
      const input = generationInput(dir, {
        systemPrompt: `system prompt sentinel\n${scannerReceiptMarker(receiptPath)}`,
      });
      delete input.priorRcas;
      delete input.correctionHint;

      await assert.rejects(
        () => generate(input),
        (error) => error.code === 'PROVIDER_ISOLATION_UNAVAILABLE',
      );

      const scanned = JSON.parse(readFileSync(receiptPath, 'utf8'));
      assert.strictEqual(scanned.priorRcas, null);
      assert.strictEqual(scanned.correctionHint, null);
    } finally {
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses only the real scanner path and redacts scanner diagnostics', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rca-generate-scan-reject-'));
    const originalPath = process.env.PATH;
    let injectedScanCalls = 0;
    let injectedRunCalls = 0;

    try {
      process.env.PATH = installGitleaksStub(dir);
      const input = generationInput(dir, { systemPrompt: scannerRejectPayload() });

      await assert.rejects(
        () =>
          generate({
            ...input,
            _scanFn: async () => {
              injectedScanCalls += 1;
            },
            _runFn: async () => {
              injectedRunCalls += 1;
            },
          }),
        (error) => {
          assert.strictEqual(error.code, 'SECRET_SCAN_FAILED');
          assert.strictEqual(error.message, 'The secret scanner blocked provider execution.');
          assert.deepStrictEqual(error.context, {});
          assert.ok(!error.message.includes('sensitive diagnostics'));
          return true;
        },
      );

      assert.strictEqual(injectedScanCalls, 0);
      assert.strictEqual(injectedRunCalls, 0);
    } finally {
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
