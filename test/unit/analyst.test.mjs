import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runAnalyst } from '../../src/analyst.mjs';
import { installGitleaksStub, scannerRejectPayload } from '../fixtures/gitleaks-test-env.mjs';

describe('runAnalyst provider security gate', () => {
  it('scans file contents and refuses isolation while ignoring public bypasses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rca-analyst-isolation-'));
    const writtenPath = join(dir, 'RCA-private-name.md');
    const promptPath = join(dir, 'analyst-prompt.md');
    const originalPath = process.env.PATH;
    let injectedScanCalls = 0;
    let injectedSpawnCalls = 0;
    writeFileSync(promptPath, `---\nname: analyst\n---\nAnalyst prompt sentinel`, 'utf8');
    writeFileSync(writtenPath, 'RCA document sentinel', 'utf8');

    try {
      process.env.PATH = installGitleaksStub(dir);
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
    } finally {
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scans the analyst document through the real scanner and redacts diagnostics', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rca-analyst-scan-reject-'));
    const writtenPath = join(dir, 'RCA-private-name.md');
    const promptPath = join(dir, 'analyst-prompt.md');
    const originalPath = process.env.PATH;
    writeFileSync(promptPath, 'Safe analyst prompt', 'utf8');
    writeFileSync(writtenPath, scannerRejectPayload(), 'utf8');

    try {
      process.env.PATH = installGitleaksStub(dir);
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
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns a static disk error without scanning when complete input cannot be read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rca-analyst-read-'));
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = installGitleaksStub(dir);
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
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
