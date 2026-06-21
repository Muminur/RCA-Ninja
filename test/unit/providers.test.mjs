import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getProvider, SUPPORTED_PROVIDERS } from '../../src/providers/index.mjs';
import { resolveBinary, toStrictSchema } from '../../src/providers/shared.mjs';
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
    assert.deepStrictEqual(resolveBinary('claude', 'claude'), { cmd: 'claude', cmdPrefix: [] });
  });

  it('splits "node /path/to/stub.mjs" into cmd + prefix args', () => {
    assert.deepStrictEqual(resolveBinary('node /tmp/stub.mjs', 'claude'), {
      cmd: 'node',
      cmdPrefix: ['/tmp/stub.mjs'],
    });
  });

  it('uses the fallback when binary is undefined', () => {
    assert.deepStrictEqual(resolveBinary(undefined, 'codex'), { cmd: 'codex', cmdPrefix: [] });
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
  const strict = toStrictSchema(JSON.parse(RCA_SCHEMA_STR));

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
  it('produces the canonical claude argv and no stdin input', () => {
    const inv = claude.buildGenerateInvocation({
      config: { claude: { binary: 'claude' } },
      contextFile: '/tmp/ctx.json',
      diffFile: '/tmp/diff.txt',
      systemPrompt: 'SYS',
      schemaStr: RCA_SCHEMA_STR,
    });
    assert.strictEqual(inv.cmd, 'claude');
    assert.strictEqual(inv.input, undefined, 'claude passes the prompt via -p, not stdin');
    for (const flag of [
      '-p',
      '--append-system-prompt',
      '--output-format',
      '--json-schema',
      '--allowedTools',
      '--permission-mode',
    ]) {
      assert.ok(inv.argv.includes(flag), `argv must include ${flag}`);
    }
    const pmIdx = inv.argv.indexOf('--permission-mode');
    assert.strictEqual(inv.argv[pmIdx + 1], 'plan');
    assert.ok(!inv.argv.includes('--bare'), 'argv must never contain --bare');
  });

  it('extractRca reads structured_output', () => {
    const inv = claude.buildGenerateInvocation({
      config: {},
      contextFile: '/tmp/c',
      diffFile: '/tmp/d',
      systemPrompt: 'S',
      schemaStr: RCA_SCHEMA_STR,
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
  it('produces a `codex exec` invocation with schema/output flags and stdin input', () => {
    const inv = codex.buildGenerateInvocation({
      config: { codex: { binary: 'codex' } },
      systemPrompt: 'SYS-PROMPT',
      schemaStr: RCA_SCHEMA_STR,
      context: FAKE_CONTEXT,
      priorRcas: [],
    });
    try {
      assert.strictEqual(inv.cmd, 'codex');
      assert.strictEqual(inv.argv[0], 'exec');
      for (const flag of ['--sandbox', '--skip-git-repo-check', '--output-schema', '-o']) {
        assert.ok(inv.argv.includes(flag), `argv must include ${flag}`);
      }
      const sIdx = inv.argv.indexOf('--sandbox');
      assert.strictEqual(inv.argv[sIdx + 1], 'read-only');
      // The prompt (with the diff) goes via stdin, NOT argv — avoids arg-length limits.
      assert.ok(typeof inv.input === 'string' && inv.input.includes('SYS-PROMPT'));
      assert.ok(
        inv.input.includes(FAKE_CONTEXT.diff),
        'diff must be inlined into the stdin prompt',
      );
      assert.ok(
        !inv.argv.some((a) => a.includes(FAKE_CONTEXT.diff)),
        'diff must not appear in argv',
      );
    } finally {
      inv.cleanup();
    }
  });

  it('honors sandbox and model overrides', () => {
    const inv = codex.buildGenerateInvocation({
      config: { codex: { binary: 'codex', sandbox: 'workspace-write', model: 'gpt-x' } },
      systemPrompt: 'S',
      schemaStr: RCA_SCHEMA_STR,
      context: FAKE_CONTEXT,
    });
    try {
      const sIdx = inv.argv.indexOf('--sandbox');
      assert.strictEqual(inv.argv[sIdx + 1], 'workspace-write');
      const mIdx = inv.argv.indexOf('--model');
      assert.strictEqual(inv.argv[mIdx + 1], 'gpt-x');
    } finally {
      inv.cleanup();
    }
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
