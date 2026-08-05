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

  it('scans the Codex fallback and never runs it when that scan rejects', async () => {
    const scanError = new RcaError('SECRET_SCAN_FAILED');
    const scans = [];
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
            _scanFn: async ({ payload }) => {
              scans.push(payload);
              if (scans.length === 2) throw scanError;
            },
            _runFn: async () => {
              providerRuns += 1;
              throw new Error('primary provider unavailable');
            },
          }),
        ),
      (error) => error === scanError,
    );

    assert.strictEqual(providerRuns, 1);
    assert.strictEqual(scans.length, 2);
    assert.strictEqual(scans[0], scans[1]);
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
});
