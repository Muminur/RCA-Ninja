import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generate } from '../../src/generator.mjs';
import { RcaError } from '../../src/errors.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SYSTEM_PROMPT_PATH = join(ROOT, 'prompts', 'rca-system.md');
const SCHEMA_PATH = join(ROOT, 'prompts', 'rca-schema.json');

const CONTEXT = {
  short_hash: 'abc1234',
  branch: 'main',
  commit_message: 'fix: validate provider input',
  files_changed: ['src/provider.mjs'],
  logs: 'controlled test log',
  diff: 'diff --git a/src/provider.mjs b/src/provider.mjs\n+validate(input);',
};

const VALID_RCA = {
  title: 'Provider input bypassed the required security scan',
  symptom:
    'Provider execution started before the complete generated context passed security review.',
  root_cause:
    'The provider process boundary did not invoke the central scanner immediately before execution.',
  fix: 'The generator now scans one complete serialized payload before each provider execution attempt.',
  impact: 'Unreviewed input could otherwise have reached an external model provider.',
  files: ['src/provider.mjs'],
  tags: ['security', 'provider'],
  references: [],
  confidence: 'high',
};

function claudeSuccess() {
  return {
    stdout: JSON.stringify({
      structured_output: VALID_RCA,
      total_cost_usd: 0,
      session_id: 'test-session',
    }),
  };
}

function generateOptions(overrides = {}) {
  return {
    context: CONTEXT,
    config: { provider: 'claude', claude: { max_retries: 1 } },
    systemPromptPath: SYSTEM_PROMPT_PATH,
    schemaPath: SCHEMA_PATH,
    correctionHint: undefined,
    priorRcas: undefined,
    ...overrides,
  };
}

describe('generate provider security gate', () => {
  it('rejects before any provider run and preserves the scanner error', async () => {
    const scanError = new RcaError('SECRET_SCAN_FAILED');
    let providerRuns = 0;

    await assert.rejects(
      () =>
        generate(
          generateOptions({
            _scanFn: async () => {
              throw scanError;
            },
            _runFn: async () => {
              providerRuns += 1;
              return claudeSuccess();
            },
          }),
        ),
      (error) => {
        assert.strictEqual(error, scanError);
        assert.strictEqual(error.code, 'SECRET_SCAN_FAILED');
        return true;
      },
    );

    assert.strictEqual(providerRuns, 0);
  });

  it('preserves SECRET_SCANNER_UNAVAILABLE before the primary provider runs', async () => {
    const scanError = new RcaError('SECRET_SCANNER_UNAVAILABLE');
    let providerRuns = 0;

    await assert.rejects(
      () =>
        generate(
          generateOptions({
            _scanFn: async () => {
              throw scanError;
            },
            _runFn: async () => {
              providerRuns += 1;
              return claudeSuccess();
            },
          }),
        ),
      (error) => error === scanError,
    );

    assert.strictEqual(providerRuns, 0);
  });

  it('rescans a schema retry and refuses the second provider run when that scan rejects', async () => {
    const events = [];
    const scanError = new RcaError('SECRET_SCAN_FAILED');

    await assert.rejects(
      () =>
        generate(
          generateOptions({
            _scanFn: async () => {
              events.push('scan');
              if (events.filter((event) => event === 'scan').length === 2) throw scanError;
            },
            _runFn: async () => {
              events.push('run');
              return { stdout: JSON.stringify({ structured_output: { bad: 'schema' } }) };
            },
          }),
        ),
      (error) => error === scanError,
    );

    assert.deepStrictEqual(events, ['scan', 'run', 'scan']);
  });

  it('preserves SECRET_SCANNER_UNAVAILABLE on retry and skips the second provider run', async () => {
    const events = [];
    const scanError = new RcaError('SECRET_SCANNER_UNAVAILABLE');

    await assert.rejects(
      () =>
        generate(
          generateOptions({
            _scanFn: async () => {
              events.push('scan');
              if (events.filter((event) => event === 'scan').length === 2) throw scanError;
            },
            _runFn: async () => {
              events.push('run');
              return { stdout: JSON.stringify({ structured_output: { bad: 'schema' } }) };
            },
          }),
        ),
      (error) => error === scanError,
    );

    assert.deepStrictEqual(events, ['scan', 'run', 'scan']);
  });

  it('does not enter a configured fallback when the primary scanner is unavailable', async () => {
    const scanError = new RcaError('SECRET_SCANNER_UNAVAILABLE');
    let scans = 0;
    let providerRuns = 0;

    await assert.rejects(
      () =>
        generate(
          generateOptions({
            config: {
              provider: 'claude',
              claude: { max_retries: 0 },
              codex: { max_retries: 0 },
            },
            _scanFn: async () => {
              scans += 1;
              throw scanError;
            },
            _runFn: async () => {
              providerRuns += 1;
              throw new Error('primary provider unavailable');
            },
          }),
        ),
      (error) => error === scanError,
    );

    assert.strictEqual(providerRuns, 0);
    assert.strictEqual(scans, 1);
  });

  it('does not automatically fall back after a primary provider failure', async () => {
    let scans = 0;
    let providerRuns = 0;
    const sensitiveProviderText = 'provider output contained private material';

    await assert.rejects(
      () =>
        generate(
          generateOptions({
            config: {
              provider: 'claude',
              claude: { max_retries: 0 },
              codex: { max_retries: 0 },
            },
            _scanFn: async () => {
              scans += 1;
            },
            _runFn: async () => {
              providerRuns += 1;
              throw Object.assign(new Error(sensitiveProviderText), {
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

    assert.strictEqual(providerRuns, 1);
    assert.strictEqual(scans, 1);
  });

  it('fails closed before scanning when no isolated provider broker is injected', async () => {
    let scans = 0;
    await assert.rejects(
      () =>
        generate(
          generateOptions({
            config: { provider: 'claude', claude: { max_retries: 0, timeout_ms: 1 } },
            _scanFn: async () => {
              scans += 1;
            },
          }),
        ),
      (error) => {
        assert.strictEqual(error.code, 'PROVIDER_ISOLATION_UNAVAILABLE');
        return true;
      },
    );
    assert.strictEqual(scans, 0);
  });

  it('scans one complete serialized payload with explicit null optionals', async () => {
    let scannedPayload;

    await generate(
      generateOptions({
        _scanFn: async ({ payload }) => {
          scannedPayload = payload;
        },
        _runFn: async () => claudeSuccess(),
      }),
    );

    const parsed = JSON.parse(scannedPayload);
    assert.deepStrictEqual(Object.keys(parsed), [
      'systemPrompt',
      'schema',
      'context',
      'priorRcas',
      'correctionHint',
    ]);
    assert.ok(parsed.systemPrompt.includes('Root Cause Analysis'));
    assert.ok(parsed.schema.includes('claude-rca.rca.v1'));
    assert.deepStrictEqual(parsed.context, CONTEXT);
    assert.strictEqual(parsed.priorRcas, null);
    assert.strictEqual(parsed.correctionHint, null);
  });

  it('delivers a large Claude payload over stdin without an oversized argv entry', async () => {
    let observedInput;
    let observedArgv;
    const largeContext = { ...CONTEXT, diff: `diff --git a/a b/a\n+${'z'.repeat(50_000)}` };

    await generate(
      generateOptions({
        context: largeContext,
        _scanFn: async () => {},
        _runFn: async (_cmd, argv, options) => {
          observedArgv = argv;
          observedInput = options.input;
          return claudeSuccess();
        },
      }),
    );

    assert.ok(observedInput.includes('z'.repeat(50_000)));
    assert.ok(!observedArgv.some((arg) => arg.length > 10_000));
  });
});
