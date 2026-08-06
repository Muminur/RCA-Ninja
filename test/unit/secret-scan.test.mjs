import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

import { ERROR_TABLE, RcaError } from '../../src/errors.mjs';
import {
  installGitleaksStub,
  pathWithoutGitleaks,
  scannerReceiptMarker,
  scannerRejectPayload,
} from '../fixtures/gitleaks-test-env.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SECRET_SCAN_URL = pathToFileURL(join(REPO_ROOT, 'src', 'secret-scan.mjs')).href;
const scannerBootstrapDir = mkdtempSync(join(tmpdir(), 'rca-secret-scan-bootstrap-'));
const scannerCwdReceiptPath = join(scannerBootstrapDir, 'scanner-cwd-receipt.txt');

// The scanner intentionally snapshots the host executable at module evaluation.
// Install one controlled host scanner before importing the boundary under test.
process.env.PATH = installGitleaksStub(scannerBootstrapDir, {
  cwdReceiptPath: scannerCwdReceiptPath,
});
const secretScanner = await import('../../src/secret-scan.mjs');
const { buildScannerEnv, scanProviderPayload } = secretScanner;
process.once('exit', () => rmSync(scannerBootstrapDir, { recursive: true, force: true }));

function isPathWithin(path, root) {
  const child = relative(root, path);
  return child === '' || (child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child));
}

describe('secret scanner', () => {
  it('uses the real scanner path even when a public runner is injected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rca-secret-scan-real-'));
    const receiptPath = join(dir, 'scanner-receipt.txt');
    let injectedCalls = 0;
    const payload = `provider input ${scannerReceiptMarker(receiptPath)}`;

    try {
      await assert.doesNotReject(() =>
        scanProviderPayload({
          payload,
          workspaceRoot: REPO_ROOT,
          _runFn: async () => {
            injectedCalls += 1;
            throw new Error('private injected runner diagnostic');
          },
        }),
      );

      assert.strictEqual(injectedCalls, 0);
      assert.strictEqual(readFileSync(receiptPath, 'utf8'), payload);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds a minimal scanner environment without loader or configuration injection', () => {
    const env = buildScannerEnv({
      Path: 'mixed-case-path',
      SystemRoot: 'C:\\Windows',
      LD_LIBRARY_PATH: '/hostile/loader',
      DYLD_LIBRARY_PATH: '/hostile/dyld',
      DYLD_FALLBACK_LIBRARY_PATH: '/hostile/fallback',
      LIBPATH: '/hostile/libpath',
      SHLIB_PATH: '/hostile/shlib',
      GITLEAKS_CONFIG: 'untrusted-config.toml',
      GITLEAKS_CONFIG_TOML: 'untrusted-inline-config',
      NODE_OPTIONS: '--require hostile-hook',
      SECRET_PARENT_VALUE: 'must-not-be-copied',
    });

    assert.deepStrictEqual(env, {
      SystemRoot: 'C:\\Windows',
    });
  });

  it('reports the version only from the captured scanner snapshot', () => {
    assert.strictEqual(
      secretScanner.checkSecretScannerReadiness(REPO_ROOT),
      'gitleaks version 8.30.1',
    );
  });

  it('refuses an exact-minimum prerelease before delivering payload to the scanner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rca-secret-scan-prerelease-'));
    const receiptPath = join(dir, 'scanner-receipt.txt');
    const payload = `PRIVATE_VERSION_PAYLOAD ${scannerReceiptMarker(receiptPath)}`;

    try {
      const scannerPath = installGitleaksStub(dir, { version: '8.30.1-rc.1' });
      const result = runSnapshotChild({
        dir,
        initialPath: scannerPath,
        afterImportPath: scannerPath,
        payload,
      });

      assert.strictEqual(result.code, 'SECRET_SCANNER_UNAVAILABLE');
      assert.deepStrictEqual(result.context, {});
      assert.ok(!JSON.stringify(result).includes('PRIVATE_VERSION_PAYLOAD'));
      assert.ok(!JSON.stringify(result).includes('8.30.1-rc.1'));
      assert.strictEqual(existsSync(receiptPath), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a prerelease only when its later semantic version exceeds the minimum', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rca-secret-scan-later-prerelease-'));

    try {
      const scannerPath = installGitleaksStub(dir, { version: '8.30.2-rc.1' });
      const result = runSnapshotChild({
        dir,
        initialPath: scannerPath,
        afterImportPath: scannerPath,
        payload: 'safe provider input',
      });

      assert.deepStrictEqual(result, { ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('binds scanner execution to the pre-configuration host path and rejects workspace-local spoofing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rca-secret-scan-path-binding-'));
    const hostRoot = join(dir, 'host-scanner');
    const workspaceRoot = join(dir, 'workspace');
    const hostReceipt = join(dir, 'host-receipt.txt');
    const workspaceReceipt = join(dir, 'workspace-receipt.txt');

    try {
      const hostPath = installGitleaksStub(hostRoot, { identity: 'host' });
      const workspacePath = installGitleaksStub(workspaceRoot, { identity: 'workspace' });
      const payload = 'payload ' + scannerReceiptMarker(hostReceipt);

      const pathChangedAfterImport = runSnapshotChild({
        dir,
        initialPath: hostPath,
        afterImportPath: workspacePath,
        payload,
        workspaceRoot,
      });

      assert.deepStrictEqual(pathChangedAfterImport, { ok: true });
      assert.strictEqual(readFileSync(hostReceipt, 'utf8'), 'host\n' + payload);
      assert.strictEqual(existsSync(workspaceReceipt), false);

      const workspaceOnly = runSnapshotChild({
        dir,
        initialPath: workspacePath,
        afterImportPath: workspacePath,
        payload: 'payload ' + scannerReceiptMarker(workspaceReceipt),
        workspaceRoot,
      });

      assert.strictEqual(workspaceOnly.code, 'SECRET_SCANNER_UNAVAILABLE');
      assert.strictEqual(existsSync(workspaceReceipt), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses payload after the source scanner changes during version validation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rca-secret-scan-source-swap-'));
    const receiptPath = join(dir, 'scanner-receipt.txt');
    const sourcePath = join(
      dir,
      'scanner-bin',
      process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks',
    );

    try {
      const scannerPath = installGitleaksStub(dir, { replaceOnVersionPath: sourcePath });
      const result = runSnapshotChild({
        dir,
        initialPath: scannerPath,
        afterImportPath: scannerPath,
        payload: 'payload ' + scannerReceiptMarker(receiptPath),
      });

      assert.strictEqual(result.code, 'SECRET_SCANNER_UNAVAILABLE');
      assert.strictEqual(existsSync(receiptPath), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed for a missing or noncanonical supplied workspace root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rca-secret-scan-invalid-workspace-'));
    const receiptPath = join(dir, 'scanner-receipt.txt');
    const payload = 'payload ' + scannerReceiptMarker(receiptPath);
    const fileRoot = join(dir, 'workspace-file');
    writeFileSync(fileRoot, 'not a directory', 'utf8');

    try {
      for (const workspaceRoot of [
        undefined,
        null,
        join(dir, 'missing-workspace'),
        'relative-workspace',
        fileRoot,
      ]) {
        await assert.rejects(
          () => scanProviderPayload({ payload, workspaceRoot }),
          (error) => error.code === 'SECRET_SCANNER_UNAVAILABLE',
        );
      }
      assert.strictEqual(existsSync(receiptPath), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps scanner execution outside a target-selected temporary directory after import', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rca-secret-scan-runtime-temp-'));
    const targetTemp = mkdtempSync(join(dir, 'target-controlled-temp-'));
    const originalEnv = Object.fromEntries(
      ['TMPDIR', 'TEMP', 'TMP'].map((key) => [key, process.env[key]]),
    );

    try {
      rmSync(scannerCwdReceiptPath, { force: true });
      for (const key of Object.keys(originalEnv)) process.env[key] = targetTemp;

      await assert.doesNotReject(() =>
        scanProviderPayload({ payload: 'safe provider input', workspaceRoot: targetTemp }),
      );

      const scannerCwd = readFileSync(scannerCwdReceiptPath, 'utf8').trim();
      assert.strictEqual(isPathWithin(scannerCwd, targetTemp), false);
    } finally {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a captured host temporary directory after it becomes a directory link', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rca-secret-scan-temp-link-'));
    const hostTemp = mkdtempSync(join(dir, 'captured-host-temp-'));
    const movedHostTemp = join(dir, 'moved-host-temp');
    const targetWorkspace = mkdtempSync(join(dir, 'target-workspace-'));
    const scannerPath = installGitleaksStub(join(dir, 'host-scanner'));
    const receiptPath = join(dir, 'scanner-receipt.txt');

    try {
      const result = runTempDirectoryLinkChild({
        dir,
        initialPath: scannerPath,
        hostTemp,
        movedHostTemp,
        workspaceRoot: targetWorkspace,
        payload: `PRIVATE_TEMP_LINK_PAYLOAD ${scannerReceiptMarker(receiptPath)}`,
      });

      assert.strictEqual(result.code, 'SECRET_SCANNER_UNAVAILABLE');
      assert.deepStrictEqual(result.context, {});
      assert.strictEqual(existsSync(receiptPath), false);
      assert.ok(!JSON.stringify(result).includes('PRIVATE_TEMP_LINK_PAYLOAD'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps a missing executable to a static unavailable error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rca-secret-scan-missing-'));
    const payload = 'provider payload must not leak';

    try {
      const scannerPath = pathWithoutGitleaks();
      const result = runSnapshotChild({
        dir,
        initialPath: scannerPath,
        afterImportPath: scannerPath,
        payload,
      });

      assert.strictEqual(result.code, 'SECRET_SCANNER_UNAVAILABLE');
      assert.strictEqual(result.category, 'env');
      assert.notStrictEqual(result.exitCode, 0);
      assert.strictEqual(
        result.message,
        'An approved secret scanner is unavailable; provider execution was refused.',
      );
      assert.deepStrictEqual(result.context, {});
      assertUniqueExitCode(result);
      assert.ok(!JSON.stringify(result).includes(payload));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps scanner rejection to a static scan-failed error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rca-secret-scan-reject-'));
    const payload = `${scannerRejectPayload()} provider payload must not leak`;

    try {
      await assert.rejects(
        () => scanProviderPayload({ payload, workspaceRoot: REPO_ROOT }),
        (error) => {
          assert.ok(error instanceof RcaError);
          assert.strictEqual(error.code, 'SECRET_SCAN_FAILED');
          assert.notStrictEqual(error.exitCode, 0);
          assert.strictEqual(error.message, 'The secret scanner blocked provider execution.');
          assert.deepStrictEqual(error.context, {});
          assertUniqueExitCode(error);
          assert.ok(!error.message.includes('sensitive diagnostics'));
          assert.ok(!error.message.includes(payload));
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps malformed payloads to a static scan-failed error without invoking the scanner', async () => {
    await assert.rejects(
      () => scanProviderPayload({ payload: { secret: 'provider payload must not leak' } }),
      (error) => {
        assert.strictEqual(error.code, 'SECRET_SCAN_FAILED');
        assert.deepStrictEqual(error.context, {});
        assert.ok(!error.message.includes('provider payload'));
        return true;
      },
    );
  });

  it('maps omitted and null options to static scan-failed errors', async () => {
    for (const options of [undefined, null]) {
      await assert.rejects(
        () => scanProviderPayload(options),
        (error) => {
          assert.ok(error instanceof RcaError);
          assert.strictEqual(error.code, 'SECRET_SCAN_FAILED');
          assert.strictEqual(error.message, 'The secret scanner blocked provider execution.');
          assert.deepStrictEqual(error.context, {});
          return true;
        },
      );
    }
  });

  it('does not expose the retired regex-only secret scanner API', async () => {
    const generator = await import('../../src/generator.mjs');
    assert.strictEqual(Object.hasOwn(generator, 'scanForSecrets'), false);
  });
});

function assertUniqueExitCode(error) {
  const conflictingCodes = Object.entries(ERROR_TABLE)
    .filter(([code, entry]) => code !== error.code && entry.exit === error.exitCode)
    .map(([code]) => code);
  assert.deepStrictEqual(conflictingCodes, []);
}

function runSnapshotChild({
  dir,
  initialPath,
  afterImportPath,
  payload,
  workspaceRoot = REPO_ROOT,
}) {
  const entryPath = join(dir, 'scanner-snapshot-' + Math.random().toString(16).slice(2) + '.mjs');
  writeFileSync(
    entryPath,
    [
      'const { scanProviderPayload } = await import(' + JSON.stringify(SECRET_SCAN_URL) + ');',
      'process.env.PATH = process.env.RCA_TEST_AFTER_IMPORT_PATH;',
      'try {',
      '  await scanProviderPayload({',
      '    payload: process.env.RCA_TEST_PAYLOAD,',
      '    workspaceRoot: process.env.RCA_TEST_WORKSPACE_ROOT,',
      '  });',
      '  process.stdout.write(JSON.stringify({ ok: true }));',
      '} catch (error) {',
      '  process.stdout.write(JSON.stringify({',
      '    code: error.code,',
      '    message: error.message,',
      '    context: error.context,',
      '    category: error.category,',
      '    exitCode: error.exitCode,',
      '  }));',
      '}',
    ].join('\n'),
    'utf8',
  );
  const result = spawnSync(process.execPath, [entryPath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: initialPath,
      RCA_TEST_AFTER_IMPORT_PATH: afterImportPath,
      RCA_TEST_PAYLOAD: payload,
      RCA_TEST_WORKSPACE_ROOT: workspaceRoot,
    },
  });
  assert.strictEqual(result.status, 0, result.stdout + '\n' + result.stderr);
  return JSON.parse(result.stdout);
}

function runTempDirectoryLinkChild({
  dir,
  initialPath,
  hostTemp,
  movedHostTemp,
  workspaceRoot,
  payload,
}) {
  const entryPath = join(dir, 'scanner-temp-link-' + Math.random().toString(16).slice(2) + '.mjs');
  writeFileSync(
    entryPath,
    [
      "import { renameSync, symlinkSync } from 'node:fs';",
      'const { scanProviderPayload } = await import(' + JSON.stringify(SECRET_SCAN_URL) + ');',
      'renameSync(process.env.RCA_TEST_HOST_TEMP, process.env.RCA_TEST_MOVED_HOST_TEMP);',
      "symlinkSync(process.env.RCA_TEST_MOVED_HOST_TEMP, process.env.RCA_TEST_HOST_TEMP, process.platform === 'win32' ? 'junction' : 'dir');",
      'try {',
      '  await scanProviderPayload({',
      '    payload: process.env.RCA_TEST_PAYLOAD,',
      '    workspaceRoot: process.env.RCA_TEST_WORKSPACE_ROOT,',
      '  });',
      '  process.stdout.write(JSON.stringify({ ok: true }));',
      '} catch (error) {',
      '  process.stdout.write(JSON.stringify({',
      '    code: error.code,',
      '    message: error.message,',
      '    context: error.context,',
      '  }));',
      '}',
    ].join('\n'),
    'utf8',
  );
  const result = spawnSync(process.execPath, [entryPath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: initialPath,
      TMPDIR: hostTemp,
      TEMP: hostTemp,
      TMP: hostTemp,
      RCA_TEST_HOST_TEMP: hostTemp,
      RCA_TEST_MOVED_HOST_TEMP: movedHostTemp,
      RCA_TEST_PAYLOAD: payload,
      RCA_TEST_WORKSPACE_ROOT: workspaceRoot,
    },
  });
  assert.strictEqual(result.status, 0, result.stdout + '\n' + result.stderr);
  return JSON.parse(result.stdout);
}
