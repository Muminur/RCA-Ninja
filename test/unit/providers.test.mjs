import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { getProvider, SUPPORTED_PROVIDERS } from '../../src/providers/index.mjs';
import * as shared from '../../src/providers/shared.mjs';
import * as claude from '../../src/providers/claude.mjs';
import * as codex from '../../src/providers/codex.mjs';
import { RcaError } from '../../src/errors.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const RCA_SCHEMA_STR = readFileSync(join(ROOT, 'prompts', 'rca-schema.json'), 'utf8');

const FAKE_CONTEXT = {
  short_hash: 'abc1234',
  branch: 'main',
  commit_message: 'fix: null-check session',
  files_changed: ['src/auth.js'],
  logs: null,
  diff: 'diff --git a/src/auth.js b/src/auth.js\n+if (!req.session) return res.status(401);',
};

describe('resolveBinary', () => {
  it('splits a plain binary name', () => {
    assert.deepStrictEqual(shared.resolveBinary('claude', 'claude'), {
      cmd: 'claude',
      cmdPrefix: [],
    });
  });

  it('splits "node /path/to/stub.mjs" into cmd + prefix args', () => {
    assert.deepStrictEqual(shared.resolveBinary('node /tmp/stub.mjs', 'claude'), {
      cmd: 'node',
      cmdPrefix: ['/tmp/stub.mjs'],
    });
  });

  it('uses the fallback when binary is undefined', () => {
    assert.deepStrictEqual(shared.resolveBinary(undefined, 'codex'), {
      cmd: 'codex',
      cmdPrefix: [],
    });
  });
});

describe('getProvider', () => {
  it('resolves claude and codex adapters', () => {
    assert.strictEqual(getProvider('claude').name, 'claude');
    assert.strictEqual(getProvider('codex').name, 'codex');
  });

  it('defaults to claude when provider is undefined', () => {
    assert.strictEqual(getProvider(undefined).name, 'claude');
  });

  it('lists both supported providers', () => {
    assert.ok(SUPPORTED_PROVIDERS.includes('claude'));
    assert.ok(SUPPORTED_PROVIDERS.includes('codex'));
  });

  it('throws INVALID_CONFIG_VALUE for an unknown provider', () => {
    assert.throws(
      () => getProvider('gemini'),
      (err) => err instanceof RcaError && err.code === 'INVALID_CONFIG_VALUE',
    );
  });
});

describe('toStrictSchema', () => {
  const strict = shared.toStrictSchema(JSON.parse(RCA_SCHEMA_STR));

  it('marks every top-level property as required', () => {
    assert.deepStrictEqual(
      new Set(strict.required),
      new Set(Object.keys(strict.properties)),
      'all properties must be required in strict mode',
    );
  });

  it('forces additionalProperties:false', () => {
    assert.strictEqual(strict.additionalProperties, false);
  });

  it('strips unsupported validation keywords (minLength/maxLength/pattern/default)', () => {
    const json = JSON.stringify(strict);
    for (const kw of ['minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'default']) {
      assert.ok(!json.includes(`"${kw}"`), `strict schema must not contain ${kw}`);
    }
  });

  it('recurses into nested object schemas (code_changes items)', () => {
    const items = strict.properties.code_changes.items;
    assert.strictEqual(items.additionalProperties, false);
    assert.deepStrictEqual(new Set(items.required), new Set(Object.keys(items.properties)));
  });

  it('preserves enum constraints', () => {
    assert.deepStrictEqual(strict.properties.confidence.enum, ['high', 'medium', 'low', 'unknown']);
  });
});

describe('claude adapter — buildGenerateInvocation', () => {
  it('uses a fixed binary, inline payload, isolated cwd, and non-overridable safety flags', () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'provider-test-'));
    try {
      const payload = JSON.stringify({ marker: 'complete-provider-payload' });
      const inv = claude.buildGenerateInvocation({
        config: {
          claude: {
            binary: 'attacker-controlled',
            allowed_tools: 'Read,Write,Bash',
            permission_mode: 'bypassPermissions',
            use_bare: false,
          },
        },
        payload,
        schemaStr: RCA_SCHEMA_STR,
        workspaceDir,
      });
      assert.strictEqual(inv.cmd, 'claude');
      assert.strictEqual(inv.cwd, workspaceDir);
      assert.ok(
        inv.argv.some((arg) => arg.includes(payload)),
        'the complete payload must be inline',
      );
      for (const flag of [
        '--bare',
        '--safe-mode',
        '--tools',
        '--no-session-persistence',
        '--output-format',
        '--json-schema',
      ]) {
        assert.ok(inv.argv.includes(flag), `argv must include ${flag}`);
      }
      assert.strictEqual(inv.argv[inv.argv.indexOf('--tools') + 1], '');
      assert.ok(!inv.argv.includes('Read,Write,Bash'));
      assert.ok(!inv.argv.includes('bypassPermissions'));
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it('extractRca reads structured_output', () => {
    const inv = claude.buildGenerateInvocation({
      config: {},
      payload: '{}',
      schemaStr: RCA_SCHEMA_STR,
      workspaceDir: tmpdir(),
    });
    const out = inv.extractRca(
      JSON.stringify({ structured_output: { title: 'x' }, total_cost_usd: 0.5, session_id: 's1' }),
    );
    assert.deepStrictEqual(out.rcaData, { title: 'x' });
    assert.strictEqual(out.cost, 0.5);
    assert.strictEqual(out.sessionId, 's1');
  });
});

describe('codex adapter — buildGenerateInvocation', () => {
  it('uses fixed hardening flags, isolated cwd, workspace temp files, and stdin only', () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'provider-test-'));
    const inv = codex.buildGenerateInvocation({
      config: {
        codex: {
          binary: 'attacker-controlled',
          sandbox: 'danger-full-access',
          model: 'gpt-x',
        },
      },
      payload: JSON.stringify({ marker: 'complete-provider-payload', context: FAKE_CONTEXT }),
      schemaStr: RCA_SCHEMA_STR,
      workspaceDir,
    });
    try {
      assert.strictEqual(inv.cmd, 'codex');
      assert.strictEqual(inv.cwd, workspaceDir);
      assert.strictEqual(inv.argv[0], 'exec');
      for (const flag of [
        '--sandbox',
        '--ignore-user-config',
        '--ignore-rules',
        '--ephemeral',
        '--skip-git-repo-check',
        '--cd',
        '--output-schema',
        '-o',
      ]) {
        assert.ok(inv.argv.includes(flag), `argv must include ${flag}`);
      }
      const sIdx = inv.argv.indexOf('--sandbox');
      assert.strictEqual(inv.argv[sIdx + 1], 'read-only');
      assert.strictEqual(inv.argv[inv.argv.indexOf('--cd') + 1], workspaceDir);
      assert.ok(typeof inv.input === 'string' && inv.input.includes('complete-provider-payload'));
      assert.ok(!inv.argv.some((arg) => arg.includes(FAKE_CONTEXT.diff)));
      assert.ok(inv.argv[inv.argv.indexOf('--output-schema') + 1].startsWith(workspaceDir));
      assert.ok(inv.argv[inv.argv.indexOf('-o') + 1].startsWith(workspaceDir));
      assert.ok(!inv.argv.includes('danger-full-access'));
      assert.ok(inv.argv.includes('gpt-x'));
    } finally {
      inv.cleanup();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it('does not expose source RCA paths in analyst input', () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'provider-test-'));
    const sourcePath = join(ROOT, 'private', 'RCA-secret.md');
    const documentContent = '## Root Cause\nThe validated document body.';
    const inv = codex.buildAnalystInvocation({
      config: {},
      payload: JSON.stringify({ systemPrompt: 'Analyze carefully.', documentContent }),
      workspaceDir,
    });
    try {
      assert.ok(inv.input.includes('The validated document body.'));
      assert.ok(!inv.input.includes(sourcePath));
    } finally {
      inv.cleanup();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});

describe('provider environment allowlist', () => {
  it('preserves required Claude authentication but strips unrelated secrets', () => {
    const env = shared.buildProviderEnv('claude', {
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'test-anthropic-auth',
      CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-auth',
      DATABASE_URL: 'must-not-leak',
    });
    assert.deepStrictEqual(env, {
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'test-anthropic-auth',
      CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-auth',
    });
  });

  it('never passes CODEX_API_KEY or unrelated secrets to Codex', () => {
    const env = shared.buildProviderEnv('codex', {
      PATH: '/bin',
      OPENAI_API_KEY: 'test-openai-auth',
      CODEX_API_KEY: 'must-not-leak',
      DATABASE_URL: 'must-not-leak',
    });
    assert.deepStrictEqual(env, {
      PATH: '/bin',
      OPENAI_API_KEY: 'test-openai-auth',
    });
  });
});

describe('codex adapter — extractJsonObject', () => {
  it('parses a raw JSON object', () => {
    assert.deepStrictEqual(codex.extractJsonObject('{"a":1}'), { a: 1 });
  });

  it('parses a ```json fenced block', () => {
    assert.deepStrictEqual(codex.extractJsonObject('```json\n{"a":2}\n```'), { a: 2 });
  });

  it('parses a JSON object embedded in prose', () => {
    assert.deepStrictEqual(codex.extractJsonObject('Here is the result: {"a":3} done.'), { a: 3 });
  });

  it('throws SCHEMA_VALIDATION on unparseable output', () => {
    assert.throws(
      () => codex.extractJsonObject('not json at all'),
      (err) => err instanceof RcaError && err.code === 'SCHEMA_VALIDATION',
    );
  });
});
