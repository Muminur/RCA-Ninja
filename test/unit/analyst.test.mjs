import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { runAnalyst } from '../../src/analyst.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

function makeFakeRcaFile(dir) {
  const path = join(dir, 'RCA-2026-01-01-abc1234-test.md');
  writeFileSync(
    path,
    `---
title: "Test RCA"
date: 2026-01-01
confidence: medium
tags: [rca, bugfix]
ref: abc1234
---

## Symptom
Something broke.

## Root Cause
Null pointer in middleware/auth.js:47.

## Fix
Added null guard before property access.

## Impact
Login requests failing.
`,
  );
  return path;
}

function runAnalystWithAllowedScan(options) {
  return runAnalyst({ ...options, _scanFn: async () => {} });
}

describe('runAnalyst', () => {
  it('returns an object with verdict and findings properties', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-analyst-'));
    try {
      const rcaPath = makeFakeRcaFile(dir);
      const systemPromptPath = join(ROOT, '.claude', 'agents', 'rca-analyst.md');
      const result = await runAnalystWithAllowedScan({
        writtenPath: rcaPath,
        systemPromptPath,
        config: {},
        _spawnFn: async () => ({
          stdout: JSON.stringify({
            structured_output: {
              verdict: 'PUBLISH',
              findings: 'Root cause is specific. Fix is verifiable.',
            },
          }),
        }),
      });
      assert.ok(typeof result.verdict === 'string', 'verdict must be a string');
      assert.ok(
        ['PUBLISH', 'REVISE', 'REJECT'].includes(result.verdict),
        'verdict must be PUBLISH/REVISE/REJECT',
      );
      assert.ok(typeof result.findings === 'string', 'findings must be a string');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns PUBLISH verdict from injected spawn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-analyst-publish-'));
    try {
      const rcaPath = makeFakeRcaFile(dir);
      const systemPromptPath = join(ROOT, '.claude', 'agents', 'rca-analyst.md');
      const result = await runAnalystWithAllowedScan({
        writtenPath: rcaPath,
        systemPromptPath,
        config: {},
        _spawnFn: async () => ({
          stdout: JSON.stringify({
            structured_output: { verdict: 'PUBLISH', findings: 'All criteria met.' },
          }),
        }),
      });
      assert.strictEqual(result.verdict, 'PUBLISH');
      assert.strictEqual(result.findings, 'All criteria met.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns REVISE verdict from injected spawn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-analyst-revise-'));
    try {
      const rcaPath = makeFakeRcaFile(dir);
      const systemPromptPath = join(ROOT, '.claude', 'agents', 'rca-analyst.md');
      const result = await runAnalystWithAllowedScan({
        writtenPath: rcaPath,
        systemPromptPath,
        config: {},
        _spawnFn: async () => ({
          stdout: JSON.stringify({
            structured_output: { verdict: 'REVISE', findings: 'Root cause is too vague.' },
          }),
        }),
      });
      assert.strictEqual(result.verdict, 'REVISE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('disables tools and uses the isolated workspace for provider execution', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-analyst-argv-'));
    try {
      const rcaPath = makeFakeRcaFile(dir);
      const systemPromptPath = join(ROOT, '.claude', 'agents', 'rca-analyst.md');
      let capturedArgv;
      let capturedOptions;
      await runAnalystWithAllowedScan({
        writtenPath: rcaPath,
        systemPromptPath,
        config: {},
        _spawnFn: async (_cmd, argv, options) => {
          capturedArgv = argv;
          capturedOptions = options;
          assert.ok(existsSync(options.cwd));
          return {
            stdout: JSON.stringify({ structured_output: { verdict: 'PUBLISH', findings: 'ok' } }),
          };
        },
      });
      assert.ok(capturedArgv, 'spawn must have been called');
      const toolsIdx = capturedArgv.indexOf('--tools');
      assert.ok(toolsIdx !== -1, '--tools must be present in argv');
      assert.strictEqual(capturedArgv[toolsIdx + 1], '', 'provider tools must be empty');
      assert.strictEqual(existsSync(capturedOptions.cwd), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws SCHEMA_VALIDATION when analyst output is not valid JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-analyst-json-'));
    try {
      const rcaPath = makeFakeRcaFile(dir);
      const systemPromptPath = join(ROOT, '.claude', 'agents', 'rca-analyst.md');
      const { RcaError } = await import('../../src/errors.mjs');
      await assert.rejects(
        () =>
          runAnalystWithAllowedScan({
            writtenPath: rcaPath,
            systemPromptPath,
            config: {},
            _spawnFn: async () => ({ stdout: 'not-valid-json-at-all' }),
          }),
        (err) => {
          assert.ok(err instanceof RcaError);
          assert.strictEqual(err.code, 'SCHEMA_VALIDATION');
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws RcaError on spawn failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-analyst-fail-'));
    try {
      const rcaPath = makeFakeRcaFile(dir);
      const systemPromptPath = join(ROOT, '.claude', 'agents', 'rca-analyst.md');
      const { RcaError } = await import('../../src/errors.mjs');
      const sensitiveProviderText = 'provider stderr included private material';
      await assert.rejects(
        () =>
          runAnalystWithAllowedScan({
            writtenPath: rcaPath,
            systemPromptPath,
            config: {},
            _spawnFn: async () => {
              throw Object.assign(new Error(sensitiveProviderText), {
                stderr: sensitiveProviderText,
              });
            },
          }),
        (err) => {
          assert.ok(err instanceof RcaError);
          assert.strictEqual(err.code, 'CLAUDE_FAILURE');
          assert.ok(!err.message.includes(sensitiveProviderText));
          assert.ok(!JSON.stringify(err.context).includes(sensitiveProviderText));
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves SECRET_SCANNER_UNAVAILABLE before spawning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-analyst-unavailable-'));
    try {
      const rcaPath = makeFakeRcaFile(dir);
      const systemPromptPath = join(ROOT, '.claude', 'agents', 'rca-analyst.md');
      const scanError = new (await import('../../src/errors.mjs')).RcaError(
        'SECRET_SCANNER_UNAVAILABLE',
      );
      let spawnCount = 0;

      await assert.rejects(
        () =>
          runAnalyst({
            writtenPath: rcaPath,
            systemPromptPath,
            config: {},
            _scanFn: async () => {
              throw scanError;
            },
            _spawnFn: async () => {
              spawnCount += 1;
              return { stdout: '{}' };
            },
          }),
        (error) => error === scanError,
      );
      assert.strictEqual(spawnCount, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects scanner failure before spawning and preserves the scanner error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-analyst-scan-'));
    try {
      const rcaPath = makeFakeRcaFile(dir);
      const systemPromptPath = join(ROOT, '.claude', 'agents', 'rca-analyst.md');
      const scanError = new (await import('../../src/errors.mjs')).RcaError('SECRET_SCAN_FAILED');
      let spawnCount = 0;

      await assert.rejects(
        () =>
          runAnalyst({
            writtenPath: rcaPath,
            systemPromptPath,
            config: {},
            _scanFn: async () => {
              throw scanError;
            },
            _spawnFn: async () => {
              spawnCount += 1;
              return { stdout: '{}' };
            },
          }),
        (error) => error === scanError,
      );
      assert.strictEqual(spawnCount, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scans and inlines document content without exposing its original path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-analyst-inline-'));
    try {
      const rcaPath = makeFakeRcaFile(dir);
      const systemPromptPath = join(ROOT, '.claude', 'agents', 'rca-analyst.md');
      let scannedPayload;
      let providerInput;

      await runAnalyst({
        writtenPath: rcaPath,
        systemPromptPath,
        config: {},
        _scanFn: async ({ payload }) => {
          scannedPayload = payload;
        },
        _spawnFn: async (_cmd, _argv, options) => {
          providerInput = options.input;
          return {
            stdout: JSON.stringify({
              structured_output: { verdict: 'PUBLISH', findings: 'Content is complete.' },
            }),
          };
        },
      });

      assert.ok(scannedPayload.includes('Null pointer in middleware/auth.js:47.'));
      assert.ok(providerInput.includes('Null pointer in middleware/auth.js:47.'));
      assert.ok(!scannedPayload.includes(rcaPath));
      assert.ok(!providerInput.includes(rcaPath));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when no isolated analyst broker is injected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-analyst-isolation-'));
    try {
      const rcaPath = makeFakeRcaFile(dir);
      let scans = 0;
      await assert.rejects(
        () =>
          runAnalyst({
            writtenPath: rcaPath,
            systemPromptPath: join(ROOT, '.claude', 'agents', 'rca-analyst.md'),
            config: { claude: { timeout_ms: 1 } },
            _scanFn: async () => {
              scans += 1;
            },
          }),
        (error) => {
          assert.strictEqual(error.code, 'PROVIDER_ISOLATION_UNAVAILABLE');
          return true;
        },
      );
      assert.strictEqual(scans, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed without spawning when the RCA document cannot be read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-analyst-read-'));
    try {
      let spawnCount = 0;
      await assert.rejects(
        () =>
          runAnalyst({
            writtenPath: join(dir, 'missing.md'),
            systemPromptPath: join(ROOT, '.claude', 'agents', 'rca-analyst.md'),
            config: {},
            _scanFn: async () => assert.fail('scanner must not run without complete input'),
            _spawnFn: async () => {
              spawnCount += 1;
              return { stdout: '{}' };
            },
          }),
        (error) => {
          assert.strictEqual(error.code, 'DISK_ERROR');
          assert.ok(!error.message.includes('missing.md'));
          return true;
        },
      );
      assert.strictEqual(spawnCount, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
