import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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

describe('runAnalyst', () => {
  it('returns an object with verdict and findings properties', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-analyst-'));
    try {
      const rcaPath = makeFakeRcaFile(dir);
      const systemPromptPath = join(ROOT, '.claude', 'agents', 'rca-analyst.md');
      const result = await runAnalyst({
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
      const result = await runAnalyst({
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
      const result = await runAnalyst({
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

  it('asserts --allowedTools Read is in the spawn argv (§2.8 hard rule)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-analyst-argv-'));
    try {
      const rcaPath = makeFakeRcaFile(dir);
      const systemPromptPath = join(ROOT, '.claude', 'agents', 'rca-analyst.md');
      let capturedArgv;
      await runAnalyst({
        writtenPath: rcaPath,
        systemPromptPath,
        config: {},
        _spawnFn: async (_cmd, argv) => {
          capturedArgv = argv;
          return {
            stdout: JSON.stringify({ structured_output: { verdict: 'PUBLISH', findings: 'ok' } }),
          };
        },
      });
      assert.ok(capturedArgv, 'spawn must have been called');
      const toolsIdx = capturedArgv.indexOf('--allowedTools');
      assert.ok(toolsIdx !== -1, '--allowedTools must be present in argv');
      assert.strictEqual(
        capturedArgv[toolsIdx + 1],
        'Read',
        '--allowedTools value must be Read only',
      );
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
          runAnalyst({
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
      await assert.rejects(
        () =>
          runAnalyst({
            writtenPath: rcaPath,
            systemPromptPath,
            config: {},
            _spawnFn: async () => {
              throw new Error('claude exited with 1');
            },
          }),
        (err) => err instanceof RcaError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
