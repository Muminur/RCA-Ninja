import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';

import { ERROR_TABLE, RcaError } from '../../src/errors.mjs';
import { buildScannerEnv, scanProviderPayload } from '../../src/secret-scan.mjs';

describe('secret scanner', () => {
  it('runs gitleaks against stdin in an isolated temporary directory', async () => {
    const payload = 'provider input with a sentinel value';
    let scannerCwd;
    const originalConfig = process.env.GITLEAKS_CONFIG;
    const originalInlineConfig = process.env.GITLEAKS_CONFIG_TOML;
    const originalSentinel = process.env.SHOULD_NOT_REACH_SCANNER;
    process.env.GITLEAKS_CONFIG = 'untrusted-config.toml';
    process.env.GITLEAKS_CONFIG_TOML = 'untrusted-inline-config';
    process.env.SHOULD_NOT_REACH_SCANNER = 'sensitive-parent-value';

    try {
      await scanProviderPayload({
        payload,
        _runFn: async (command, args, options) => {
          scannerCwd = options.cwd;
          const ignorePath = join(scannerCwd, '.gitleaks-ignore');

          assert.strictEqual(command, 'gitleaks');
          assert.deepStrictEqual(args, [
            'detect',
            '--pipe',
            '--no-banner',
            '--no-color',
            '--redact=100',
            '--ignore-gitleaks-allow',
            '--gitleaks-ignore-path',
            ignorePath,
            '--timeout',
            '30',
          ]);
          assert.ok(existsSync(scannerCwd));
          assert.strictEqual(dirname(scannerCwd), tmpdir());
          assert.deepStrictEqual(readdirSync(scannerCwd), []);
          assert.strictEqual(existsSync(ignorePath), false);
          assert.strictEqual(options.input, payload);
          assert.strictEqual(options.timeoutMs, 30_000);
          assert.strictEqual(options.env.GITLEAKS_CONFIG, undefined);
          assert.strictEqual(options.env.GITLEAKS_CONFIG_TOML, undefined);
          assert.strictEqual(options.env.SHOULD_NOT_REACH_SCANNER, undefined);
          assert.ok(options.env.PATH);
          assert.deepStrictEqual(
            Object.keys(options.env).filter(
              (key) =>
                ![
                  'PATH',
                  'SystemRoot',
                  'WINDIR',
                  'ComSpec',
                  'PATHEXT',
                  'LD_LIBRARY_PATH',
                  'DYLD_LIBRARY_PATH',
                  'DYLD_FALLBACK_LIBRARY_PATH',
                  'LIBPATH',
                  'SHLIB_PATH',
                ].includes(key),
            ),
            [],
          );
          return { stdout: '', stderr: '' };
        },
      });
    } finally {
      restoreEnv('GITLEAKS_CONFIG', originalConfig);
      restoreEnv('GITLEAKS_CONFIG_TOML', originalInlineConfig);
      restoreEnv('SHOULD_NOT_REACH_SCANNER', originalSentinel);
    }

    assert.strictEqual(existsSync(scannerCwd), false);
  });

  it('builds a minimal executable environment without Gitleaks configuration', () => {
    const env = buildScannerEnv({
      Path: 'mixed-case-path',
      SystemRoot: 'C:\\Windows',
      LD_LIBRARY_PATH: '/trusted/loader',
      GITLEAKS_CONFIG: 'untrusted-config.toml',
      GITLEAKS_CONFIG_TOML: 'untrusted-inline-config',
      SECRET_PARENT_VALUE: 'must-not-be-copied',
    });

    assert.deepStrictEqual(env, {
      PATH: 'mixed-case-path',
      SystemRoot: 'C:\\Windows',
      LD_LIBRARY_PATH: '/trusted/loader',
    });
  });

  it('maps a missing executable to a static unavailable error', async () => {
    const originalText = 'spawn gitleaks ENOENT from private cwd';
    const missingExecutable = Object.assign(new Error(originalText), { code: 'ENOENT' });

    await assert.rejects(
      () =>
        scanProviderPayload({
          payload: 'provider payload must not leak',
          _runFn: async () => {
            throw missingExecutable;
          },
        }),
      (error) => {
        assert.ok(error instanceof RcaError);
        assert.strictEqual(error.code, 'SECRET_SCANNER_UNAVAILABLE');
        assert.strictEqual(error.category, 'env');
        assert.notStrictEqual(error.exitCode, 0);
        assert.strictEqual(
          error.message,
          'An approved secret scanner is unavailable; provider execution was refused.',
        );
        assert.deepStrictEqual(error.context, {});
        assertUniqueExitCode(error);
        assert.ok(!error.message.includes(originalText));
        assert.ok(!error.message.includes('provider payload'));
        return true;
      },
    );
  });

  it('maps scanner rejection to a static scan-failed error', async () => {
    const originalText = 'scanner output included a private token';
    const scannerFailure = Object.assign(new Error(originalText), {
      code: 1,
      stdout: 'private stdout',
      stderr: 'private stderr',
    });

    await assert.rejects(
      () =>
        scanProviderPayload({
          payload: 'provider payload must not leak',
          _runFn: async () => {
            throw scannerFailure;
          },
        }),
      (error) => {
        assert.ok(error instanceof RcaError);
        assert.strictEqual(error.code, 'SECRET_SCAN_FAILED');
        assert.ok(error.category === 'input' || error.category === 'security');
        assert.notStrictEqual(error.exitCode, 0);
        assert.strictEqual(error.message, 'The secret scanner blocked provider execution.');
        assert.deepStrictEqual(error.context, {});
        assertUniqueExitCode(error);
        assert.ok(!error.message.includes(originalText));
        assert.ok(!error.message.includes('private stdout'));
        assert.ok(!error.message.includes('private stderr'));
        assert.ok(!error.message.includes('provider payload'));
        return true;
      },
    );
  });

  it('maps a malformed payload to a static scan-failed error without invoking gitleaks', async () => {
    let invoked = false;

    await assert.rejects(
      () =>
        scanProviderPayload({
          payload: { secret: 'provider payload must not leak' },
          _runFn: async () => {
            invoked = true;
          },
        }),
      (error) => {
        assert.strictEqual(error.code, 'SECRET_SCAN_FAILED');
        assert.deepStrictEqual(error.context, {});
        assert.ok(!error.message.includes('provider payload'));
        return true;
      },
    );

    assert.strictEqual(invoked, false);
  });

  it('maps omitted options to a static scan-failed error', async () => {
    await assert.rejects(
      () => scanProviderPayload(),
      (error) => {
        assert.ok(error instanceof RcaError);
        assert.strictEqual(error.code, 'SECRET_SCAN_FAILED');
        assert.strictEqual(error.message, 'The secret scanner blocked provider execution.');
        assert.deepStrictEqual(error.context, {});
        return true;
      },
    );
  });

  it('maps null options to a static scan-failed error', async () => {
    await assert.rejects(
      () => scanProviderPayload(null),
      (error) => {
        assert.ok(error instanceof RcaError);
        assert.strictEqual(error.code, 'SECRET_SCAN_FAILED');
        assert.strictEqual(error.message, 'The secret scanner blocked provider execution.');
        assert.deepStrictEqual(error.context, {});
        return true;
      },
    );
  });

  it('resolves when gitleaks succeeds', async () => {
    await assert.doesNotReject(() =>
      scanProviderPayload({
        payload: 'safe provider input',
        _runFn: async () => ({ stdout: '', stderr: '' }),
      }),
    );
  });
});

function restoreEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function assertUniqueExitCode(error) {
  const conflictingCodes = Object.entries(ERROR_TABLE)
    .filter(([code, entry]) => code !== error.code && entry.exit === error.exitCode)
    .map(([code]) => code);
  assert.deepStrictEqual(conflictingCodes, []);
}
