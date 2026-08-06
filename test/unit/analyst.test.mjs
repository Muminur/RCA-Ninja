import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import {
  installGitleaksStub,
  scannerReceiptMarker,
  scannerRejectPayload,
} from '../fixtures/gitleaks-test-env.mjs';

const scannerBootstrapDir = mkdtempSync(join(tmpdir(), 'rca-analyst-bootstrap-'));
process.env.PATH = installGitleaksStub(scannerBootstrapDir);
const { runAnalyst } = await import('../../src/analyst.mjs');
process.once('exit', () => rmSync(scannerBootstrapDir, { recursive: true, force: true }));

describe('runAnalyst provider security gate', () => {
  it('normalizes a relative workspace root before scanner delivery', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rca-analyst-relative-cwd-'));
    const writtenPath = join(dir, 'RCA-private-name.md');
    const promptPath = join(dir, 'analyst-prompt.md');
    const receiptPath = join(dir, 'scanner-receipt.json');
    writeFileSync(promptPath, `Safe analyst prompt\n${scannerReceiptMarker(receiptPath)}`, 'utf8');
    writeFileSync(writtenPath, 'RCA document sentinel', 'utf8');

    try {
      await assert.rejects(
        () =>
          runAnalyst({
            writtenPath,
            systemPromptPath: promptPath,
            config: {},
            cwd: relative(process.cwd(), dir),
          }),
        (error) => error.code === 'PROVIDER_ISOLATION_UNAVAILABLE',
      );
      assert.ok(readFileSync(receiptPath, 'utf8').includes('Safe analyst prompt'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scans file contents and refuses isolation while ignoring public bypasses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rca-analyst-isolation-'));
    const writtenPath = join(dir, 'RCA-private-name.md');
    const promptPath = join(dir, 'analyst-prompt.md');
    const receiptPath = join(dir, 'scanner-receipt.json');
    let injectedScanCalls = 0;
    let injectedSpawnCalls = 0;
    writeFileSync(
      promptPath,
      `---\nname: analyst\n---\nAnalyst prompt sentinel\n${scannerReceiptMarker(receiptPath)}`,
      'utf8',
    );
    writeFileSync(writtenPath, 'RCA document sentinel', 'utf8');

    try {
      await assert.rejects(
        () =>
          runAnalyst({
            writtenPath,
            systemPromptPath: promptPath,
            config: { provider: 'claude' },
            _scanFn: async () => {
              injectedScanCalls += 1;
            },
            _spawnFn: async () => {
              injectedSpawnCalls += 1;
              throw Object.assign(new Error('private provider diagnostic'), {
                code: 'SECRET_SCANNER_UNAVAILABLE',
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
      assert.strictEqual(injectedSpawnCalls, 0);
      const scanned = JSON.parse(readFileSync(receiptPath, 'utf8'));
      assert.deepStrictEqual(Object.keys(scanned), ['systemPrompt', 'documentContent']);
      assert.ok(scanned.systemPrompt.includes('Analyst prompt sentinel'));
      assert.ok(!scanned.systemPrompt.includes('name: analyst'));
      assert.strictEqual(scanned.documentContent, 'RCA document sentinel');
      assert.ok(!JSON.stringify(scanned).includes(writtenPath));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scans the analyst document through the real scanner and redacts diagnostics', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rca-analyst-scan-reject-'));
    const writtenPath = join(dir, 'RCA-private-name.md');
    const promptPath = join(dir, 'analyst-prompt.md');
    writeFileSync(promptPath, 'Safe analyst prompt', 'utf8');
    writeFileSync(writtenPath, scannerRejectPayload(), 'utf8');

    try {
      await assert.rejects(
        () => runAnalyst({ writtenPath, systemPromptPath: promptPath, config: {} }),
        (error) => {
          assert.strictEqual(error.code, 'SECRET_SCAN_FAILED');
          assert.strictEqual(error.message, 'The secret scanner blocked provider execution.');
          assert.deepStrictEqual(error.context, {});
          assert.ok(!error.message.includes('sensitive diagnostics'));
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns a static disk error without scanning when complete input cannot be read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rca-analyst-read-'));
    try {
      await assert.rejects(
        () =>
          runAnalyst({
            writtenPath: join(dir, 'private-missing-name.md'),
            systemPromptPath: join(dir, 'also-missing.md'),
            config: {},
          }),
        (error) => {
          assert.strictEqual(error.code, 'DISK_ERROR');
          assert.strictEqual(
            error.message,
            'Filesystem error during reading analyst input: unavailable.',
          );
          assert.deepStrictEqual(error.context, {
            op: 'reading analyst input',
            errno: 'unavailable',
          });
          assert.ok(!error.message.includes('private-missing-name.md'));
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
