import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { RcaError } from './errors.mjs';
import { run } from './util/exec.mjs';

const SCANNER_ENV_KEYS = ['SystemRoot', 'WINDIR'];
const MIN_GITLEAKS_VERSION = [8, 30, 1];
const MAX_SCANNER_BYTES = 128 * 1024 * 1024;
const SEMVER_PATTERN =
  /(?:^|[^0-9A-Za-z.-])v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?=$|[^0-9A-Za-z.-])/;

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

function getEnvironmentValue(sourceEnv, key) {
  const sourceKey = Object.keys(sourceEnv ?? {}).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return sourceKey === undefined ? undefined : sourceEnv[sourceKey];
}

function fingerprintScanner(path) {
  try {
    const linkInfo = lstatSync(path);
    if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) return null;

    const info = statSync(path);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_SCANNER_BYTES) return null;
    if (process.platform !== 'win32' && (info.mode & 0o111) === 0) return null;

    const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
    return {
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtimeMs: info.mtimeMs,
      digest,
    };
  } catch {
    return null;
  }
}

function fingerprintDirectory(path) {
  try {
    const linkInfo = lstatSync(path);
    if (!linkInfo.isDirectory() || linkInfo.isSymbolicLink()) return null;

    const canonicalPath = realpathSync(path);
    const info = statSync(canonicalPath);
    if (!info.isDirectory()) return null;

    return { canonicalPath, dev: info.dev, ino: info.ino };
  } catch {
    return null;
  }
}

function captureHostTemporaryDirectory() {
  let path;
  try {
    path = tmpdir();
  } catch {
    return null;
  }
  if (typeof path !== 'string' || !isAbsolute(path)) return null;

  try {
    return fingerprintDirectory(realpathSync(path));
  } catch {
    return null;
  }
}

function sameDirectory(left, right) {
  return (
    left.canonicalPath === right.canonicalPath && left.dev === right.dev && left.ino === right.ino
  );
}

function isHostTemporaryDirectoryUnchanged(directory) {
  const current = directory === null ? null : fingerprintDirectory(directory.canonicalPath);
  return current !== null && sameDirectory(directory, current);
}

function isDirectoryWithinHostTemporaryDirectory(path, directory) {
  const current = fingerprintDirectory(path);
  return (
    current !== null &&
    isHostTemporaryDirectoryUnchanged(directory) &&
    isPathWithin(current.canonicalPath, directory.canonicalPath)
  );
}

function resolveHostScanner(pathValue) {
  if (typeof pathValue !== 'string' || pathValue.length === 0) return null;

  const executable = process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks';
  for (const directory of pathValue.split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;

    const sourcePath = resolve(directory, executable);
    let commandPath;
    try {
      commandPath = realpathSync(sourcePath);
    } catch {
      continue;
    }

    const fingerprint = fingerprintScanner(commandPath);
    if (fingerprint) {
      return { sourcePath, commandPath, fingerprint };
    }
  }
  return null;
}

function sameFingerprint(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.digest === right.digest
  );
}

function createScannerSnapshot(scanner, temporaryDirectory) {
  let directory;
  try {
    if (!isHostTemporaryDirectoryUnchanged(temporaryDirectory)) return null;
    directory = mkdtempSync(join(temporaryDirectory.canonicalPath, 'codex-rca-gitleaks-bin-'));
    if (!isDirectoryWithinHostTemporaryDirectory(directory, temporaryDirectory)) {
      throw new RcaError('SECRET_SCANNER_UNAVAILABLE');
    }
    chmodSync(directory, 0o700);

    const executable = join(directory, process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks');
    copyFileSync(scanner.commandPath, executable, constants.COPYFILE_EXCL);
    chmodSync(executable, 0o700);

    const fingerprint = fingerprintScanner(executable);
    if (
      fingerprint === null ||
      fingerprint.size !== scanner.fingerprint.size ||
      fingerprint.digest !== scanner.fingerprint.digest
    ) {
      throw new RcaError('SECRET_SCANNER_UNAVAILABLE');
    }

    return { directory, commandPath: executable, fingerprint };
  } catch {
    if (
      directory !== undefined &&
      isDirectoryWithinHostTemporaryDirectory(directory, temporaryDirectory)
    ) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // The scanner remains unavailable; cleanup must not disclose paths.
      }
    }
    return null;
  }
}

function captureHostScanner(pathValue, temporaryDirectory) {
  const scanner = resolveHostScanner(pathValue);
  if (scanner === null) return null;

  const snapshot = createScannerSnapshot(scanner, temporaryDirectory);
  return snapshot === null ? null : { ...scanner, snapshot };
}

function isPathWithin(path, root) {
  const child = relative(root, path);
  return child === '' || (child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child));
}

function canonicalWorkspaceRoot(path) {
  if (typeof path !== 'string' || path.length === 0 || !isAbsolute(path)) return null;
  try {
    const canonicalPath = realpathSync(path);
    return statSync(canonicalPath).isDirectory() ? canonicalPath : null;
  } catch {
    return null;
  }
}

function isScannerOutsideRoots(scanner, roots) {
  const scannerPaths = [scanner.sourcePath, scanner.commandPath, scanner.snapshot.commandPath];
  return roots.every((root) => scannerPaths.every((path) => !isPathWithin(path, root)));
}

function isPathOutsideRoots(path, roots) {
  return roots.every((root) => !isPathWithin(path, root));
}

function isSourceScannerUnchanged(scanner) {
  const current = fingerprintScanner(scanner.commandPath);
  return current !== null && sameFingerprint(scanner.fingerprint, current);
}

function isSnapshotUnchanged(scanner) {
  const current = fingerprintScanner(scanner.snapshot.commandPath);
  return current !== null && sameFingerprint(scanner.snapshot.fingerprint, current);
}

function isTrustedScannerUnchanged(scanner) {
  return isSourceScannerUnchanged(scanner) && isSnapshotUnchanged(scanner);
}

function getTrustedScanner(workspaceRoot) {
  const launchRoot = canonicalWorkspaceRoot(HOST_WORKING_DIRECTORY);
  const callerRoot = canonicalWorkspaceRoot(workspaceRoot);
  const roots = [launchRoot, callerRoot].filter((root) => typeof root === 'string');

  if (
    HOST_SCANNER === null ||
    launchRoot === null ||
    callerRoot === null ||
    HOST_TEMP_DIRECTORY === null ||
    !isHostTemporaryDirectoryUnchanged(HOST_TEMP_DIRECTORY) ||
    !isPathOutsideRoots(HOST_TEMP_DIRECTORY.canonicalPath, roots) ||
    !isScannerOutsideRoots(HOST_SCANNER, roots) ||
    !isTrustedScannerUnchanged(HOST_SCANNER)
  ) {
    throw new RcaError('SECRET_SCANNER_UNAVAILABLE');
  }
  return HOST_SCANNER;
}

function supportsGitleaksVersion(output) {
  const match = String(output).match(SEMVER_PATTERN);
  if (!match) return false;

  const actual = match.slice(1, 4).map(Number);
  for (let index = 0; index < MIN_GITLEAKS_VERSION.length; index += 1) {
    if (actual[index] > MIN_GITLEAKS_VERSION[index]) return true;
    if (actual[index] < MIN_GITLEAKS_VERSION[index]) return false;
  }

  // An exact-minimum prerelease precedes the required stable release.
  return match[4] === undefined;
}

function isStaticScannerError(error) {
  return (
    error instanceof RcaError &&
    (error.code === 'SECRET_SCANNER_UNAVAILABLE' || error.code === 'SECRET_SCAN_FAILED')
  );
}

async function verifyScannerVersion({ cwd, env, scanner }) {
  if (!isSnapshotUnchanged(scanner)) {
    throw new RcaError('SECRET_SCANNER_UNAVAILABLE');
  }

  let stdout;
  try {
    ({ stdout } = await run(scanner.snapshot.commandPath, ['version'], {
      cwd,
      timeoutMs: 5_000,
      env,
    }));
  } catch {
    throw new RcaError('SECRET_SCANNER_UNAVAILABLE');
  }

  if (!supportsGitleaksVersion(stdout)) {
    throw new RcaError('SECRET_SCANNER_UNAVAILABLE');
  }
}

const HOST_WORKING_DIRECTORY = process.cwd();
const HOST_TEMP_DIRECTORY = captureHostTemporaryDirectory();
const HOST_SCANNER_ENV = Object.freeze(buildScannerEnv(process.env));
const HOST_SCANNER = captureHostScanner(
  getEnvironmentValue(process.env, 'PATH'),
  HOST_TEMP_DIRECTORY,
);

if (HOST_SCANNER !== null) {
  process.once('exit', () => {
    if (
      isDirectoryWithinHostTemporaryDirectory(HOST_SCANNER.snapshot.directory, HOST_TEMP_DIRECTORY)
    ) {
      try {
        rmSync(HOST_SCANNER.snapshot.directory, { recursive: true, force: true });
      } catch {
        // The process is exiting; never surface scanner paths during cleanup.
      }
    }
  });
}

export function checkSecretScannerReadiness(workspaceRoot) {
  const scanner = getTrustedScanner(workspaceRoot);
  if (!isSnapshotUnchanged(scanner)) {
    throw new RcaError('SECRET_SCANNER_UNAVAILABLE');
  }

  let output;
  try {
    output = execFileSync(scanner.snapshot.commandPath, ['version'], {
      cwd: scanner.snapshot.directory,
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      shell: false,
      env: HOST_SCANNER_ENV,
    });
  } catch {
    throw new RcaError('SECRET_SCANNER_UNAVAILABLE');
  }

  if (!supportsGitleaksVersion(output)) {
    throw new RcaError('SECRET_SCANNER_UNAVAILABLE');
  }
  getTrustedScanner(workspaceRoot);
  return output.trim().split(/\r?\n/, 1)[0];
}

export async function scanProviderPayload(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new RcaError('SECRET_SCAN_FAILED');
  }

  const { payload, workspaceRoot } = options;
  if (typeof payload !== 'string') {
    throw new RcaError('SECRET_SCAN_FAILED');
  }

  let scannerCwd;
  let scannerError;

  try {
    const scanner = getTrustedScanner(workspaceRoot);
    scannerCwd = await mkdtemp(join(HOST_TEMP_DIRECTORY.canonicalPath, 'codex-rca-gitleaks-'));
    const ignorePath = join(scannerCwd, '.gitleaks-ignore');

    try {
      if (!isDirectoryWithinHostTemporaryDirectory(scannerCwd, HOST_TEMP_DIRECTORY)) {
        throw new RcaError('SECRET_SCANNER_UNAVAILABLE');
      }
      await verifyScannerVersion({ cwd: scannerCwd, env: HOST_SCANNER_ENV, scanner });
      if (
        !isTrustedScannerUnchanged(scanner) ||
        !isDirectoryWithinHostTemporaryDirectory(scannerCwd, HOST_TEMP_DIRECTORY)
      ) {
        throw new RcaError('SECRET_SCANNER_UNAVAILABLE');
      }
      await run(
        scanner.snapshot.commandPath,
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
          env: HOST_SCANNER_ENV,
          input: payload,
        },
      );
    } catch (error) {
      scannerError = isStaticScannerError(error)
        ? new RcaError(error.code)
        : new RcaError(
            error?.code === 'ENOENT' ? 'SECRET_SCANNER_UNAVAILABLE' : 'SECRET_SCAN_FAILED',
          );
    }
  } catch (error) {
    scannerError = isStaticScannerError(error)
      ? new RcaError(error.code)
      : new RcaError('SECRET_SCAN_FAILED');
  } finally {
    if (scannerCwd !== undefined) {
      if (!isDirectoryWithinHostTemporaryDirectory(scannerCwd, HOST_TEMP_DIRECTORY)) {
        scannerError = new RcaError('SECRET_SCANNER_UNAVAILABLE');
      } else {
        try {
          await rm(scannerCwd, { recursive: true, force: true });
        } catch {
          scannerError = new RcaError('SECRET_SCAN_FAILED');
        }
      }
    }
  }

  if (scannerError !== undefined) {
    throw scannerError;
  }
}
