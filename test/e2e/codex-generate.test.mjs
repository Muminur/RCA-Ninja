import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generate } from '../../src/generator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const VALID_RCA = {
  title: 'Codex provider execution is isolated from the source checkout',
  symptom:
    'Provider execution previously had a working directory that could expose unscanned repository files.',
  root_cause:
    'The Codex invocation used process defaults instead of a unique restricted provider workspace.',
  fix: 'The generator now supplies a unique workspace and only an inline scanned payload to Codex.',
  impact:
    'Codex can no longer browse the source checkout through its provider process working directory.',
  files: ['src/providers/codex.mjs'],
  tags: ['security', 'isolation'],
  references: [],
  confidence: 'high',
};

function options(overrides = {}) {
  return {
    context: {
      short_hash: 'abc1234',
      branch: 'main',
      commit_message: 'fix: isolate provider',
      files_changed: ['src/providers/codex.mjs'],
      logs: null,
      diff: `diff --git a/a b/a\n+${'x'.repeat(50_000)}`,
    },
    config: { provider: 'codex', codex: { max_retries: 0 } },
    systemPromptPath: join(ROOT, 'prompts', 'rca-system.md'),
    schemaPath: join(ROOT, 'prompts', 'rca-schema.json'),
    _scanFn: async () => {},
    ...overrides,
  };
}

describe('generate with Codex provider isolation', () => {
  it('uses the isolated workspace and stdin payload, then removes the workspace', async () => {
    let providerWorkspace;
    let providerInput;

    const result = await generate(
      options({
        _runFn: async (cmd, argv, runOptions) => {
          assert.strictEqual(cmd, 'codex');
          providerWorkspace = runOptions.cwd;
          providerInput = runOptions.input;
          assert.ok(existsSync(providerWorkspace));
          assert.strictEqual(argv[argv.indexOf('--cd') + 1], providerWorkspace);
          assert.ok(!argv.includes('shell_tool'));
          assert.ok(!argv.includes('shell_snapshot'));
          for (const forbiddenKey of [
            'OPENAI_API_KEY',
            'CODEX_API_KEY',
            'ANTHROPIC_API_KEY',
            'CLAUDE_CODE_OAUTH_TOKEN',
          ]) {
            assert.ok(!(forbiddenKey in runOptions.env));
          }
          assert.strictEqual(runOptions.env.CODEX_HOME, providerWorkspace);
          assert.strictEqual(runOptions.env.HOME, providerWorkspace);
          const outputPath = argv[argv.indexOf('-o') + 1];
          writeFileSync(outputPath, JSON.stringify(VALID_RCA));
          return { stdout: 'codex event stream', stderr: '' };
        },
      }),
    );

    assert.strictEqual(result.rca.title, VALID_RCA.title);
    assert.ok(providerInput.includes('x'.repeat(50_000)));
    assert.strictEqual(existsSync(providerWorkspace), false);
  });

  it('removes the isolated workspace after a failing provider run', async () => {
    let providerWorkspace;
    const sensitiveProviderText = 'provider emitted private material';

    await assert.rejects(
      () =>
        generate(
          options({
            _runFn: async (_cmd, _argv, runOptions) => {
              providerWorkspace = runOptions.cwd;
              assert.ok(existsSync(providerWorkspace));
              throw Object.assign(new Error(sensitiveProviderText), {
                stdout: sensitiveProviderText,
                stderr: sensitiveProviderText,
              });
            },
          }),
        ),
      (error) => {
        assert.strictEqual(error.code, 'CLAUDE_FAILURE');
        assert.ok(!error.message.includes(sensitiveProviderText));
        assert.ok(!JSON.stringify(error.context).includes(sensitiveProviderText));
        return true;
      },
    );

    assert.strictEqual(existsSync(providerWorkspace), false);
  });
});
