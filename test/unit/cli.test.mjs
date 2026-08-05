import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const BIN = join(ROOT, 'bin', 'claude-rca');
const CODEX_BIN = join(ROOT, 'bin', 'codex-rca');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

describe('cli', () => {
  it('prints the version from package.json', () => {
    const out = execFileSync('node', [BIN, 'version'], {
      encoding: 'utf8',
      cwd: ROOT,
    }).trim();
    assert.strictEqual(out, pkg.version);
  });

  it('prints help without error', () => {
    const out = execFileSync('node', [BIN, 'help'], {
      encoding: 'utf8',
      cwd: ROOT,
    });
    assert.ok(out.includes('claude-rca'));
    assert.ok(out.includes('generate'));
    assert.ok(out.includes('search'));
    assert.ok(out.includes('init'));
  });

  it('codex-rca alias prints Codex-facing help', () => {
    const out = execFileSync('node', [CODEX_BIN, 'help'], {
      encoding: 'utf8',
      cwd: ROOT,
    });
    assert.ok(out.includes('codex-rca'));
    assert.ok(out.includes('generate'));
    assert.ok(out.includes('search'));
  });

  it('codex-rca alias prints the version from package.json', () => {
    const out = execFileSync('node', [CODEX_BIN, 'version'], {
      encoding: 'utf8',
      cwd: ROOT,
    }).trim();
    assert.strictEqual(out, pkg.version);
  });

  it('exits 0 on --help', () => {
    const out = execFileSync('node', [BIN, '--help'], {
      encoding: 'utf8',
      cwd: ROOT,
    });
    assert.ok(out.length > 0);
  });

  it('exits 0 on --version', () => {
    const out = execFileSync('node', [BIN, '--version'], {
      encoding: 'utf8',
      cwd: ROOT,
    }).trim();
    assert.strictEqual(out, pkg.version);
  });

  it('lists future commands as stubs in help', () => {
    const out = execFileSync('node', [BIN, 'help'], {
      encoding: 'utf8',
      cwd: ROOT,
    });
    const commands = ['init', 'generate', 'search', 'recent', 'show', 'config', 'doctor'];
    for (const cmd of commands) {
      assert.ok(out.includes(cmd), `help output should mention "${cmd}"`);
    }
  });

  it('trends command appears in help', () => {
    const out = execFileSync('node', [BIN, 'help'], { encoding: 'utf8', cwd: ROOT });
    assert.ok(out.includes('trends'), 'help should mention trends command');
  });

  it('amend command appears in help', () => {
    const out = execFileSync('node', [BIN, 'help'], { encoding: 'utf8', cwd: ROOT });
    assert.ok(out.includes('amend'), 'help should mention amend command');
  });

  it('generate --help shows --since option', () => {
    const out = execFileSync('node', [BIN, 'generate', '--help'], { encoding: 'utf8', cwd: ROOT });
    assert.ok(out.includes('--since'), 'generate --help should show --since option');
  });

  it('rejects the removed --no-secret-scan bypass before generation', () => {
    const result = spawnSync('node', [BIN, 'generate', '--no-secret-scan'], {
      encoding: 'utf8',
      cwd: ROOT,
    });

    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /unknown option ['"]--no-secret-scan['"]/i);
    assert.doesNotMatch(result.stderr, /use --no-secret-scan to bypass/i);
  });

  it('documents the scanner requirement in generate help', () => {
    const out = execFileSync('node', [BIN, 'generate', '--help'], { encoding: 'utf8', cwd: ROOT });

    assert.match(out, /Gitleaks 8\.30\.1 or newer/i);
    assert.match(out, /scanner\s+failure.*provider execution/i);
    assert.doesNotMatch(out, /--no-secret-scan/);
  });
});
