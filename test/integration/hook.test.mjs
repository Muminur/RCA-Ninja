import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const INSTALL_HOOK = join(ROOT, 'hooks', 'install-hook.sh');
const POST_COMMIT = join(ROOT, 'hooks', 'post-commit');
const POST_MERGE = join(ROOT, 'hooks', 'post-merge');
const INSTALL_HOOK_MJS = join(ROOT, 'hooks', 'install-hook.mjs');

function git(args, cwd, env = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
  }).trim();
}

function setupRepo(tmp) {
  git(['init'], tmp);
  git(['config', 'user.email', 'test@test.com'], tmp);
  git(['config', 'user.name', 'Test'], tmp);
  mkdirSync(join(tmp, '.git', 'hooks'), { recursive: true });
  writeFileSync(join(tmp, 'file.js'), 'const x = 1;\n');
  git(['add', '.'], tmp);
  git(['commit', '-m', 'feat: initial commit'], tmp);
}

describe('hooks', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'claude-rca-hook-'));
    setupRepo(tmp);
  });

  it('post-commit hook file exists', () => {
    assert.ok(existsSync(POST_COMMIT), 'hooks/post-commit must exist');
  });

  it('post-commit hook has bash shebang', () => {
    const src = readFileSync(POST_COMMIT, 'utf8');
    assert.ok(src.includes('#!/usr/bin/env bash'), 'post-commit must have bash shebang');
  });

  it('install-hook.sh file exists and is non-trivial', () => {
    assert.ok(existsSync(INSTALL_HOOK), 'hooks/install-hook.sh must exist');
    const src = readFileSync(INSTALL_HOOK, 'utf8');
    assert.ok(src.length > 100, 'install-hook.sh must not be a stub');
  });

  it('post-commit hook delegates the trigger decision to the CLI', () => {
    const src = readFileSync(POST_COMMIT, 'utf8');
    assert.ok(src.includes('--if-triggered'), 'hook must call generate --if-triggered');
    assert.ok(
      !/^\s*case "\$MSG"/m.test(src),
      'hook must not carry its own subject-matching case statement',
    );
  });

  it('post-commit hook runs claude-rca in background (nohup or &)', () => {
    const src = readFileSync(POST_COMMIT, 'utf8');
    assert.ok(
      src.includes('nohup') || src.includes(' &'),
      'hook must run claude-rca in background',
    );
  });

  it('post-commit hook redirects output to log file (not stderr)', () => {
    const src = readFileSync(POST_COMMIT, 'utf8');
    assert.ok(src.includes('>>') || src.includes('log'), 'hook must redirect output to a log file');
  });

  it('post-commit hook bails silently when claude-rca not on PATH', () => {
    const hookDest = join(tmp, '.git', 'hooks', 'post-commit');
    copyFileSync(POST_COMMIT, hookDest);
    try {
      chmodSync(hookDest, 0o755);
    } catch {
      /* windows — skip chmod */
    }

    const minPath = process.execPath.replace(/[/\\][^/\\]+$/, '');
    // This commit must NOT throw (hook must exit 0 silently when claude-rca missing)
    assert.doesNotThrow(() => {
      execFileSync('git', ['commit', '--allow-empty', '-m', 'fix: test commit'], {
        cwd: tmp,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: minPath + (process.platform === 'win32' ? ';' : ':') + process.env.PATH,
          GIT_TERMINAL_PROMPT: '0',
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@test.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@test.com',
          HOME: tmp,
        },
        timeout: 10000,
      });
    }, 'git commit must succeed even when claude-rca is not on PATH');
  });

  it('post-commit hook logs to a file on every invocation', () => {
    const src = readFileSync(POST_COMMIT, 'utf8');
    assert.ok(
      src.includes('LOG_FILE=') && src.indexOf('LOG_FILE=') < src.indexOf('command -v'),
      'hook must define LOG_FILE before command -v check',
    );
  });

  it('post-commit hook logs error when claude-rca is not on PATH', () => {
    const src = readFileSync(POST_COMMIT, 'utf8');
    assert.ok(
      src.includes('not found') || src.includes('not installed'),
      'hook must log a "not found" message when claude-rca is missing',
    );
  });

  it('post-commit hook logs skip reason for non-fix commits', () => {
    const src = readFileSync(POST_COMMIT, 'utf8');
    assert.ok(src.includes('skipped'), 'hook must log "skipped" for non-fix commits');
  });

  it('post-commit hook log entry includes timestamp', () => {
    const src = readFileSync(POST_COMMIT, 'utf8');
    assert.ok(
      src.includes('date') || src.includes('TIMESTAMP'),
      'hook must include timestamps in log entries',
    );
  });

  it('install-hook.sh checks for bash availability', () => {
    const src = readFileSync(INSTALL_HOOK, 'utf8');
    assert.ok(
      src.includes('bash') && (src.includes('--version') || src.includes('BASH_VERSION')),
      'install-hook.sh must verify bash is available',
    );
  });

  it('post-merge hook exists and has a bash shebang', () => {
    assert.ok(existsSync(POST_MERGE), 'hooks/post-merge must exist');
    const src = readFileSync(POST_MERGE, 'utf8');
    assert.ok(src.startsWith('#!/usr/bin/env bash'), 'post-merge must have a bash shebang');
  });

  it('post-merge hook generates across the range the merge introduced', () => {
    const src = readFileSync(POST_MERGE, 'utf8');
    assert.ok(src.includes('ORIG_HEAD'), 'post-merge must anchor the range at ORIG_HEAD');
    assert.ok(src.includes('--since'), 'post-merge must call generate --since');
    assert.ok(src.includes('--max'), 'post-merge must cap how many commits one run processes');
  });

  it('post-merge hook bails silently when claude-rca is not on PATH', () => {
    const src = readFileSync(POST_MERGE, 'utf8');
    assert.ok(src.includes('not found'), 'post-merge must log a not-found message');
    assert.ok(src.includes('exit 0'), 'post-merge must never fail the merge');
  });

  it('both installers install the post-merge hook', () => {
    assert.ok(
      readFileSync(INSTALL_HOOK_MJS, 'utf8').includes("'post-merge'"),
      'install-hook.mjs HOOKS must list post-merge',
    );
    assert.ok(
      readFileSync(INSTALL_HOOK, 'utf8').includes('post-merge'),
      'install-hook.sh must install post-merge',
    );
  });

  it('install-hook.mjs installs post-merge into a real repo', () => {
    execFileSync(process.execPath, [INSTALL_HOOK_MJS, tmp], {
      cwd: tmp,
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, HOME: tmp },
    });
    assert.ok(
      existsSync(join(tmp, '.git', 'hooks', 'post-merge')),
      'post-merge must land in .git/hooks',
    );
  });

  it('install-hook.sh attempts npm link', () => {
    const src = readFileSync(INSTALL_HOOK, 'utf8');
    assert.ok(
      src.includes('npm link') || src.includes('npm-link'),
      'install-hook.sh should attempt npm link to make claude-rca globally accessible',
    );
  });
});
