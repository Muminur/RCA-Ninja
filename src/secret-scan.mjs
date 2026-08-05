import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RcaError } from './errors.mjs';
import { run } from './util/exec.mjs';

const SCANNER_ENV_KEYS = [
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
];

export function buildScannerEnv(sourceEnv) {
  const safeEnv = {};
  const sourceKeys = Object.keys(sourceEnv ?? {});

  for (const allowedKey of SCANNER_ENV_KEYS) {
    const sourceKey = sourceKeys.find((key) => key.toLowerCase() === allowedKey.toLowerCase());
    if (sourceKey !== undefined && sourceEnv[sourceKey] !== undefined) {
      safeEnv[allowedKey] = sourceEnv[sourceKey];
    }
  }

  return safeEnv;
}

export async function scanProviderPayload(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new RcaError('SECRET_SCAN_FAILED');
  }

  const { payload, _runFn = run } = options;
  if (typeof payload !== 'string') {
    throw new RcaError('SECRET_SCAN_FAILED');
  }

  let scannerCwd;
  let scannerError;

  try {
    scannerCwd = await mkdtemp(join(tmpdir(), 'codex-rca-gitleaks-'));
    const ignorePath = join(scannerCwd, '.gitleaks-ignore');

    try {
      await _runFn(
        'gitleaks',
        [
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
        ],
        {
          cwd: scannerCwd,
          timeoutMs: 30_000,
          env: buildScannerEnv(process.env),
          input: payload,
        },
      );
    } catch (error) {
      scannerError = new RcaError(
        error?.code === 'ENOENT' ? 'SECRET_SCANNER_UNAVAILABLE' : 'SECRET_SCAN_FAILED',
      );
    }
  } catch {
    scannerError = new RcaError('SECRET_SCAN_FAILED');
  } finally {
    if (scannerCwd !== undefined) {
      try {
        await rm(scannerCwd, { recursive: true, force: true });
      } catch {
        scannerError = new RcaError('SECRET_SCAN_FAILED');
      }
    }
  }

  if (scannerError !== undefined) {
    throw scannerError;
  }
}
