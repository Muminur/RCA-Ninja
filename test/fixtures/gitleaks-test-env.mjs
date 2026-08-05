import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

export function scannerRejectPayload() {
  return `api_key = ${'A1b2C3d4E5f6G7h8' + 'I9j0K1l2M3n4O5p6'}`;
}

export function installGitleaksStub(rootDir) {
  const binDir = join(rootDir, 'scanner-bin');
  mkdirSync(binDir, { recursive: true });

  if (process.platform === 'win32') {
    const where = spawnSync('where.exe', ['gitleaks.exe'], { encoding: 'utf8' });
    let source = where.status === 0 ? where.stdout.split(/\r?\n/).find(Boolean) : undefined;
    if (!source) {
      for (const entry of readdirSync(tmpdir(), { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('codex-rca-ninja-gitleaks-')) continue;
        const candidate = join(tmpdir(), entry.name, 'gitleaks.exe');
        if (existsSync(candidate)) {
          source = candidate;
          break;
        }
      }
    }
    if (!source) throw new Error('gitleaks test executable is unavailable');
    copyFileSync(source, join(binDir, 'gitleaks.exe'));
    return `${binDir}${delimiter}${process.env.PATH || ''}`;
  }

  const stubPath = join(binDir, 'gitleaks-stub.mjs');
  writeFileSync(
    stubPath,
    `let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
if (input.includes('api_key =')) {
  process.stderr.write('scanner emitted sensitive diagnostics that must be redacted');
  process.exitCode = 1;
}
`,
    'utf8',
  );

  const executable = join(binDir, 'gitleaks');
  writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${stubPath}" "$@"\n`, 'utf8');
  chmodSync(executable, 0o755);

  return `${binDir}${delimiter}${process.env.PATH || ''}`;
}
