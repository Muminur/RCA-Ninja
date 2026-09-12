import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  classifyProviderFailure,
  withProviderWorkspace,
  verifyProviderIsolation,
  UNUSABLE_REASONS,
} from '../../src/provider-run.mjs';

describe('classifyProviderFailure', () => {
  it('reads the real not-logged-in envelope Claude returns', () => {
    const stdout = JSON.stringify({
      duration_api_ms: 0,
      is_error: true,
      result: 'Not logged in · Please run /login',
    });
    assert.strictEqual(classifyProviderFailure({ stdout }), 'AUTH');
  });

  it('reads the real refusal Codex returns for an unavailable model', () => {
    const stderr =
      'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error",' +
      '"message":"The \'gpt-5.3-codex-spark\' model is not supported when using Codex with a ChatGPT account."}}';
    assert.strictEqual(classifyProviderFailure({ stderr }), 'LIMIT');
  });

  it('reports a missing binary', () => {
    const error = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    assert.strictEqual(classifyProviderFailure({ error }), 'MISSING');
  });

  it('recognises rate limiting and 429', () => {
    assert.strictEqual(classifyProviderFailure({ stderr: 'rate limit exceeded' }), 'LIMIT');
    assert.strictEqual(classifyProviderFailure({ stderr: 'HTTP 429 Too Many Requests' }), 'LIMIT');
  });

  it('returns null for a provider that ran and simply answered badly', () => {
    assert.strictEqual(classifyProviderFailure({ stdout: '{"result":"not json"}' }), null);
    assert.strictEqual(classifyProviderFailure({}), null);
  });

  it('names every reason it can return', () => {
    for (const reason of ['MISSING', 'AUTH', 'LIMIT']) {
      assert.strictEqual(typeof UNUSABLE_REASONS[reason], 'string');
    }
  });
});

describe('withProviderWorkspace', () => {
  it('creates an absolute workspace and removes it afterwards', async () => {
    let seen;
    const returned = await withProviderWorkspace(async (dir) => {
      seen = dir;
      assert.ok(existsSync(dir), 'the workspace must exist while the provider runs');
      return 'value';
    });
    assert.strictEqual(returned, 'value');
    assert.strictEqual(existsSync(seen), false, 'the workspace must not survive the call');
  });

  it('removes the workspace even when the provider throws', async () => {
    let seen;
    await assert.rejects(
      withProviderWorkspace(async (dir) => {
        seen = dir;
        throw new Error('provider blew up');
      }),
    );
    assert.strictEqual(existsSync(seen), false);
  });
});

describe('verifyProviderIsolation', () => {
  it('passes for both providers and leaves no probe directory behind', () => {
    for (const provider of ['claude', 'codex']) {
      const detail = verifyProviderIsolation(provider);
      assert.match(detail, /workspace-isolated/);
      assert.match(detail, /no API keys/);
    }
  });

  it('keeps API keys out of the provider environment even when they are set', async () => {
    const { buildProviderEnv } = await import('../../src/providers/shared.mjs');
    const workspaceDir = resolve(mkdtempSync(join(tmpdir(), 'rca-env-probe-')));
    try {
      const env = buildProviderEnv(
        'claude',
        {
          PATH: '/bin',
          HOME: '/real/home',
          ANTHROPIC_API_KEY: 'leak-me',
          OPENAI_API_KEY: 'leak-me-too',
          GITHUB_TOKEN: 'and-me',
          DATABASE_URL: 'and-me-as-well',
        },
        workspaceDir,
      );
      for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'DATABASE_URL']) {
        assert.ok(!(key in env), `${key} must not reach the provider`);
      }
      // The credential directory is the single documented exception.
      assert.strictEqual(env.HOME, '/real/home');
      assert.strictEqual(env.TEMP, workspaceDir);
      assert.strictEqual(env.TMPDIR, workspaceDir);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
