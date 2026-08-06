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

export function installGitleaksStub(
  rootDir,
  { version = '8.30.1', identity = '', replaceOnVersionPath = '', cwdReceiptPath = '' } = {},
) {
  const binDir = join(rootDir, 'scanner-bin');
  mkdirSync(binDir, { recursive: true });

  if (process.platform === 'win32') {
    const sourcePath = join(binDir, 'GitleaksStub.cs');
    const executable = join(binDir, 'gitleaks.exe');
    const csharpIdentity = identity.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    const csharpReplacementPath = replaceOnVersionPath
      .replaceAll('\\', '\\\\')
      .replaceAll('"', '\\"');
    const csharpCwdReceiptPath = cwdReceiptPath.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    const csharpVersionMutation = csharpReplacementPath
      ? `File.WriteAllText("${csharpReplacementPath}", "replaced during version validation");`
      : '';
    const csharpCwdReceipt = csharpCwdReceiptPath
      ? `File.WriteAllText("${csharpCwdReceiptPath}", Directory.GetCurrentDirectory());`
      : '';
    const receiptContent = identity ? `"${csharpIdentity}\\n" + input` : 'input';
    writeFileSync(
      sourcePath,
      `using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

public class GitleaksStub {
  public static int Main(string[] args) {
    ${csharpCwdReceipt}
    if (args.Length > 0 && args[0] == "version") {
      ${csharpVersionMutation}
      Console.WriteLine("gitleaks version ${version}");
      return 0;
    }
    string input = Console.In.ReadToEnd();
    Match receipt = Regex.Match(input, @"SCANNER_RECEIPT:([A-Za-z0-9+/=]+)");
    if (receipt.Success) {
      string path = Encoding.UTF8.GetString(Convert.FromBase64String(receipt.Groups[1].Value));
      File.WriteAllText(path, ${receiptContent});
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

  const executable = join(binDir, 'gitleaks');
  writeFileSync(
    executable,
    `#!${process.execPath}
const { writeFileSync } = require('node:fs');
const replacementPath = ${JSON.stringify(replaceOnVersionPath)};
const cwdReceiptPath = ${JSON.stringify(cwdReceiptPath)};
if (cwdReceiptPath) writeFileSync(cwdReceiptPath, process.cwd());
if (process.argv[2] === 'version') {
  if (replacementPath) writeFileSync(replacementPath, 'replaced during version validation');
  process.stdout.write(${JSON.stringify(`gitleaks version ${version}\n`)});
  process.exit(0);
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const receipt = input.match(/SCANNER_RECEIPT:([A-Za-z0-9+/=]+)/);
  if (receipt) {
    const receiptContent = ${JSON.stringify(identity)} ? ${JSON.stringify(identity)} + '\\n' + input : input;
    writeFileSync(Buffer.from(receipt[1], 'base64').toString('utf8'), receiptContent);
  }
  if (input.includes('SCANNER_REJECT')) {
    process.stderr.write('scanner emitted sensitive diagnostics that must be redacted');
    process.exitCode = 1;
  }
});
`,
    'utf8',
  );
  chmodSync(executable, 0o755);
  return `${binDir}${delimiter}${process.env.PATH || ''}`;
}
