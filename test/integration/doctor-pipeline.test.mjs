import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const BIN = join(ROOT, 'bin', 'claude-rca');
const POST_COMMIT = join(ROOT, 'hooks', 'post-commit');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 't@t.local'], dir);
  git(['config', 'user.name', 'test'], dir);
  return dir;
}

function runDoctor(cwd) {
  return spawnSync('node', [BIN, '--cwd', cwd, 'doctor'], { encoding: 'utf8', cwd });
}

/**
 * doctor previously checked only external tools (node/git/rg/claude), so a repo
 * whose RCA pipeline was completely dead still reported healthy. These checks
 * make the outage that hid for three days visible in one command.
 */
describe('doctor checks the RCA pipeline itself', () => {
  it('WARNs on the config check when no config can be resolved', () => {
    const repo = makeRepo('claude-rca-doc-noconfig-');
    const { stdout } = runDoctor(repo);
    assert.ok(/^config\s+WARN/m.test(stdout), `config must be reported WARN, got:\n${stdout}`);
  });

  it('WARNs on the hook check when no post-commit hook is installed', () => {
    const repo = makeRepo('claude-rca-doc-nohook-');
    writeFileSync(join(repo, '.claude-rca.json'), JSON.stringify({ version: 1 }));
    // Point at an empty hooks dir so the result does not depend on whether the
    // machine running the tests has a global core.hooksPath fallback installed.
    const empty = join(repo, 'empty-hooks');
    mkdirSync(empty, { recursive: true });
    git(['config', 'core.hooksPath', empty], repo);

    const { stdout } = runDoctor(repo);
    assert.ok(/^hook\s+WARN/m.test(stdout), `hook must be reported WARN, got:\n${stdout}`);
  });

  it('passes both checks for a properly wired repo and reports auto_generate', () => {
    const repo = makeRepo('claude-rca-doc-ok-');
    writeFileSync(
      join(repo, '.claude-rca.json'),
      JSON.stringify({ version: 1, auto_generate: true }),
    );
    const hooksDir = join(repo, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    copyFileSync(POST_COMMIT, join(hooksDir, 'post-commit'));

    const { stdout } = runDoctor(repo);
    assert.ok(/^config\s+ok/m.test(stdout), `config must pass, got:\n${stdout}`);
    assert.ok(/^hook\s+ok/m.test(stdout), `hook must pass, got:\n${stdout}`);
    assert.ok(
      /^auto-gen\s+ok\s+.*(true|on|enabled)/im.test(stdout),
      `auto_generate state must be reported, got:\n${stdout}`,
    );
  });

  it('reports auto_generate off as a WARN, not a silent pass', () => {
    const repo = makeRepo('claude-rca-doc-off-');
    writeFileSync(
      join(repo, '.claude-rca.json'),
      JSON.stringify({ version: 1, auto_generate: false }),
    );
    const hooksDir = join(repo, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    copyFileSync(POST_COMMIT, join(hooksDir, 'post-commit'));

    const { stdout } = runDoctor(repo);
    assert.ok(
      /^auto-gen\s+WARN/m.test(stdout),
      `auto_generate=false must be visible as WARN, got:\n${stdout}`,
    );
  });

  it('detects the hook through core.hooksPath, not just .git/hooks', () => {
    const repo = makeRepo('claude-rca-doc-hookspath-');
    writeFileSync(join(repo, '.claude-rca.json'), JSON.stringify({ version: 1 }));
    const custom = join(repo, 'githooks');
    mkdirSync(custom, { recursive: true });
    copyFileSync(POST_COMMIT, join(custom, 'post-commit'));
    git(['config', 'core.hooksPath', custom], repo);

    const { stdout } = runDoctor(repo);
    assert.ok(/^hook\s+ok/m.test(stdout), `hook must be found via core.hooksPath, got:\n${stdout}`);
  });
});
