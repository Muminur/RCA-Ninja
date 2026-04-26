import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const BIN = join(ROOT, 'bin', 'claude-rca');
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

  it('stub commands exit 1 with not-implemented message', () => {
    const stubs = ['generate', 'doctor'];
    for (const cmd of stubs) {
      try {
        execFileSync('node', [BIN, cmd], { encoding: 'utf8', cwd: ROOT });
        assert.fail(`${cmd} should have exited non-zero`);
      } catch (err) {
        assert.strictEqual(err.status, 1, `${cmd} should exit 1`);
        assert.ok(
          err.stderr.includes('Not yet implemented'),
          `${cmd} stderr should say "Not yet implemented"`,
        );
      }
    }
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
});
