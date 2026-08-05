import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { generate } from '../../src/generator.mjs';
import { installGitleaksStub } from '../fixtures/gitleaks-test-env.mjs';

describe('generate with Codex selected', () => {
  it('refuses the unavailable isolation boundary without invoking an injected runner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rca-codex-isolation-'));
    const systemPromptPath = join(dir, 'prompt.txt');
    const schemaPath = join(dir, 'schema.json');
    const originalPath = process.env.PATH;
    let runs = 0;
    writeFileSync(systemPromptPath, 'safe prompt', 'utf8');
    writeFileSync(schemaPath, '{"type":"object"}', 'utf8');

    try {
      process.env.PATH = installGitleaksStub(dir);
      await assert.rejects(
        () =>
          generate({
            context: {
              short_hash: 'abc1234',
              branch: 'main',
              commit_message: 'fix: refuse codex',
              files_changed: ['src/provider.mjs'],
              logs: null,
              diff: 'safe diff',
            },
            config: { provider: 'codex' },
            systemPromptPath,
            schemaPath,
            _runFn: async () => {
              runs += 1;
            },
          }),
        (error) => error.code === 'PROVIDER_ISOLATION_UNAVAILABLE',
      );
      assert.strictEqual(runs, 0);
    } finally {
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
