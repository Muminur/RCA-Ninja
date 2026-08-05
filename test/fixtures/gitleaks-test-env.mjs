import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, join } from 'node:path';

export function scannerRejectPayload() {
  return 'SCANNER_REJECT';
}

export function scannerReceiptMarker(path) {
  return `SCANNER_RECEIPT:${Buffer.from(path, 'utf8').toString('base64')}`;
}

export function pathWithoutGitleaks() {
  return (process.env.PATH || '')
    .split(delimiter)
    .filter((entry) => {
      const names = process.platform === 'win32' ? ['gitleaks.exe'] : ['gitleaks'];
      return !names.some((name) => existsSync(join(entry, name)));
    })
    .join(delimiter);
}

export function installGitleaksStub(rootDir) {
  const binDir = join(rootDir, 'scanner-bin');
  mkdirSync(binDir, { recursive: true });

  if (process.platform === 'win32') {
    const sourcePath = join(binDir, 'GitleaksStub.cs');
    const executable = join(binDir, 'gitleaks.exe');
    writeFileSync(
      sourcePath,
      `using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

public class GitleaksStub {
  public static int Main(string[] args) {
    string input = Console.In.ReadToEnd();
    Match receipt = Regex.Match(input, @"SCANNER_RECEIPT:([A-Za-z0-9+/=]+)");
    if (receipt.Success) {
      string path = Encoding.UTF8.GetString(Convert.FromBase64String(receipt.Groups[1].Value));
      File.WriteAllText(path, input);
    }
    if (input.Contains("SCANNER_REJECT")) {
      Console.Error.Write("scanner emitted sensitive diagnostics that must be redacted");
      return 1;
    }
    return 0;
  }
}
`,
      'utf8',
    );
    const quote = (value) => value.replaceAll("'", "''");
    const compile = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Add-Type -Path '${quote(sourcePath)}' -OutputAssembly '${quote(executable)}' -OutputType ConsoleApplication`,
      ],
      { encoding: 'utf8' },
    );
    if (compile.status !== 0 || !existsSync(executable)) {
      throw new Error('could not build controlled gitleaks test fixture');
    }
    return `${binDir}${delimiter}${process.env.PATH || ''}`;
  }

  const stubPath = join(binDir, 'gitleaks-stub.mjs');
  writeFileSync(
    stubPath,
    `import { writeFileSync } from 'node:fs';
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const receipt = input.match(/SCANNER_RECEIPT:([A-Za-z0-9+/=]+)/);
if (receipt) writeFileSync(Buffer.from(receipt[1], 'base64').toString('utf8'), input);
if (input.includes('SCANNER_REJECT')) {
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
