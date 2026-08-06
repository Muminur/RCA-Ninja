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
  it('uses a fixed binary, stdin payload, isolated cwd, and non-overridable safety flags', () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'provider-test-'));
    try {
      const payload = JSON.stringify({ marker: 'x'.repeat(50_000) });
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
      assert.ok(inv.input.includes(payload), 'the complete payload must use stdin');
      assert.ok(!inv.argv.some((arg) => arg.length > 10_000), 'large input must not enter argv');
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
      assert.ok(!inv.argv.some((arg) => arg.includes(payload)));
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

  it('returns only a static parse error for malformed provider output', () => {
    const inv = claude.buildGenerateInvocation({
      config: {},
      payload: '{}',
      schemaStr: RCA_SCHEMA_STR,
      workspaceDir: tmpdir(),
    });
    const sensitiveText = 'private provider output must not appear';

    for (const output of [sensitiveText, JSON.stringify({ result: sensitiveText })]) {
      assert.throws(
        () => inv.extractRca(output),
        (error) => {
          assert.strictEqual(error.code, 'SCHEMA_VALIDATION');
          assert.strictEqual(
            error.context.ajv_first_error,
            'Could not parse RCA JSON from claude output',
          );
          assert.ok(!error.message.includes(sensitiveText));
          assert.ok(!JSON.stringify(error.context).includes(sensitiveText));
          return true;
        },
      );
    }
  });

  it('returns only a static parse error for malformed analyst output', () => {
    const inv = claude.buildAnalystInvocation({
      config: {},
      payload: '{}',
      workspaceDir: tmpdir(),
    });
    const sensitiveText = 'PRIVATE_PROVIDER_ANALYST_OUTPUT';

    assert.throws(
      () => inv.extractVerdict(sensitiveText),
      (error) => {
        assert.strictEqual(error.code, 'SCHEMA_VALIDATION');
        assert.strictEqual(
          error.context.ajv_first_error,
          'Could not parse analyst JSON from claude output',
        );
        assert.ok(!error.message.includes(sensitiveText));
        assert.ok(!JSON.stringify(error.context).includes(sensitiveText));
        return true;
      },
    );
  });

  it('strips top-level $schema before passing to Claude CLI', () => {
    const schemaStr = JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    });
    const workspaceDir = mkdtempSync(join(tmpdir(), 'provider-test-'));
    try {
      const inv = claude.buildGenerateInvocation({
        config: {},
        payload: '{}',
        schemaStr,
        workspaceDir,
      });

      const schemaIdx = inv.argv.indexOf('--json-schema');
      const schemaArg = inv.argv[schemaIdx + 1];
      const parsed = JSON.parse(schemaArg);
      assert.ok(!parsed.$schema, 'Claude invocation payload should not include $schema');
      assert.strictEqual(parsed.type, 'object');
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

});

describe('codex adapter — buildGenerateInvocation', () => {
  it('uses documented fixed flags, isolated cwd, workspace temp files, and stdin only', () => {
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
        '--strict-config',
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
      assert.ok(!inv.argv.includes('shell_tool'));
      assert.ok(!inv.argv.includes('shell_snapshot'));
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
  it('fails closed when a sterile absolute provider root cannot be formed', () => {
    for (const workspaceDir of [undefined, '', 'relative-provider-root']) {
      assert.throws(
        () => shared.buildProviderEnv('codex', { PATH: '/bin' }, workspaceDir),
        (error) => error instanceof RcaError && error.code === 'PROVIDER_ISOLATION_UNAVAILABLE',
      );
    }
  });

  it('gives Claude sterile roots and no inherited auth, profile, or unrelated secrets', () => {
    const workspaceDir = join(tmpdir(), 'sterile-claude-workspace');
    const env = shared.buildProviderEnv(
      'claude',
      {
        PATH: '/bin',
        ANTHROPIC_API_KEY: 'test-anthropic-auth',
        CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-auth',
        HOME: '/real/profile',
        USERPROFILE: 'C:\\real\\profile',
        APPDATA: 'C:\\real\\profile\\appdata',
        TEMP: 'C:\\real\\temp',
        DATABASE_URL: 'must-not-leak',
      },
      workspaceDir,
    );
    assert.deepStrictEqual(env, {
      PATH: '/bin',
      HOME: workspaceDir,
      USERPROFILE: workspaceDir,
      APPDATA: workspaceDir,
      LOCALAPPDATA: workspaceDir,
      TEMP: workspaceDir,
      TMP: workspaceDir,
      TMPDIR: workspaceDir,
      CLAUDE_CONFIG_DIR: workspaceDir,
    });
  });

  it('gives Codex sterile roots and no inherited auth, profile, or unrelated secrets', () => {
    const workspaceDir = join(tmpdir(), 'sterile-codex-workspace');
    const env = shared.buildProviderEnv(
      'codex',
      {
        PATH: '/bin',
        OPENAI_API_KEY: 'test-openai-auth',
        CODEX_API_KEY: 'must-not-leak',
        HOME: '/real/profile',
        USERPROFILE: 'C:\\real\\profile',
        APPDATA: 'C:\\real\\profile\\appdata',
        TEMP: 'C:\\real\\temp',
        DATABASE_URL: 'must-not-leak',
      },
      workspaceDir,
    );
    assert.deepStrictEqual(env, {
      PATH: '/bin',
      HOME: workspaceDir,
      USERPROFILE: workspaceDir,
      APPDATA: workspaceDir,
      LOCALAPPDATA: workspaceDir,
      TEMP: workspaceDir,
      TMP: workspaceDir,
      TMPDIR: workspaceDir,
      CODEX_HOME: workspaceDir,
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
