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
import { delimiter, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const INSTALL_HOOK = join(ROOT, 'hooks', 'install-hook.sh');
const POST_COMMIT = join(ROOT, 'hooks', 'post-commit');
const BASH =
  process.platform === 'win32' && existsSync('C:\\Program Files\\Git\\bin\\bash.exe')
    ? 'C:\\Program Files\\Git\\bin\\bash.exe'
    : 'bash';

function git(args, cwd, env) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env,
  }).trim();
}

function makeIsolatedGitEnv(prefix) {
  const home = mkdtempSync(join(tmpdir(), `${prefix}-home-`));
  const gitconfig = join(home, 'global.gitconfig');
  writeFileSync(gitconfig, '[user]\n\tname = Test\n\temail = test@example.invalid\n');
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    const normalizedKey = key.toUpperCase();
    if (
      normalizedKey.startsWith('GIT_CONFIG_') ||
      [
        'HOME',
        'USERPROFILE',
        'XDG_CONFIG_HOME',
        'GIT_DIR',
        'GIT_WORK_TREE',
        'GIT_COMMON_DIR',
        'GIT_TEMPLATE_DIR',
      ].includes(normalizedKey)
    ) {
      delete env[key];
    }
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, 'xdg'),
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function setupRepo(tmp) {
  const env = makeIsolatedGitEnv('claude-rca-hook-setup');
  git(['init', '-q', '-b', 'main'], tmp, env);
  git(['config', '--local', 'core.hooksPath', join(tmp, '.git', 'hooks')], tmp, env);
  git(['config', '--local', 'user.email', 'test@test.com'], tmp, env);
  git(['config', '--local', 'user.name', 'Test'], tmp, env);
  mkdirSync(join(tmp, '.git', 'hooks'), { recursive: true });
  writeFileSync(join(tmp, 'file.js'), 'const x = 1;\n');
  git(['add', 'file.js'], tmp, env);
  git(['commit', '-m', 'feat: initial commit'], tmp, env);
  return env;
}

describe('hooks', () => {
  let tmp;
  let testGitEnv;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'claude-rca-hook-'));
    testGitEnv = setupRepo(tmp);
  });

  it('isolates repository setup from an inherited user post-commit hook', () => {
    const hostileHome = mkdtempSync(join(tmpdir(), 'claude-rca-hostile-home-'));
    const sharedHooks = join(hostileHome, 'shared-hooks');
    const marker = join(hostileHome, 'user-hook-executed');
    const globalConfig = join(hostileHome, 'global.gitconfig');
    mkdirSync(sharedHooks, { recursive: true });
    const hostileHook = join(sharedHooks, 'post-commit');
    writeFileSync(
      hostileHook,
      `#!/bin/sh\nprintf invoked > "${marker.replaceAll('\\', '/')}"\n`,
      'utf8',
    );
    chmodSync(hostileHook, 0o755);
    writeFileSync(
      globalConfig,
      `[core]\n\thooksPath = ${sharedHooks.replaceAll('\\', '/')}\n`,
      'utf8',
    );
    const original = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    };

    try {
      process.env.HOME = hostileHome;
      process.env.USERPROFILE = hostileHome;
      process.env.GIT_CONFIG_GLOBAL = globalConfig;
      const isolatedRepo = mkdtempSync(join(tmpdir(), 'claude-rca-isolated-setup-'));
      setupRepo(isolatedRepo);
      assert.strictEqual(
        existsSync(marker),
        false,
        'repository setup must not execute inherited user hooks',
      );
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('scrubs mixed-case Git command config before the setup commit', () => {
    const hostileHome = mkdtempSync(join(tmpdir(), 'claude-rca-hostile-command-config-'));
    const sharedHooks = join(hostileHome, 'shared-hooks');
    const marker = join(hostileHome, 'command-config-hook-executed');
    mkdirSync(sharedHooks, { recursive: true });
    const hostileHook = join(sharedHooks, 'post-commit');
    writeFileSync(
      hostileHook,
      `#!/bin/sh\nprintf invoked > "${marker.replaceAll('\\', '/')}"\n`,
      'utf8',
    );
    chmodSync(hostileHook, 0o755);

    const injectedKeys = ['Git_Config_Count', 'Git_Config_Key_0', 'Git_Config_Value_0'];
    const injectedKeySet = new Set(injectedKeys.map((key) => key.toUpperCase()));
    const originalEntries = Object.entries(process.env).filter(([key]) =>
      injectedKeySet.has(key.toUpperCase()),
    );

    try {
      process.env.Git_Config_Count = '1';
      process.env.Git_Config_Key_0 = 'core.hooksPath';
      process.env.Git_Config_Value_0 = sharedHooks;
      const isolatedRepo = mkdtempSync(join(tmpdir(), 'claude-rca-command-config-setup-'));
      const isolatedEnv = setupRepo(isolatedRepo);

      assert.deepStrictEqual(
        Object.keys(isolatedEnv).filter((key) => injectedKeySet.has(key.toUpperCase())),
        [],
        'repository setup must scrub Git command config without relying on key casing',
      );
      assert.strictEqual(
        existsSync(marker),
        false,
        'repository setup must not execute hooks injected through mixed-case Git config',
      );
    } finally {
      for (const key of Object.keys(process.env)) {
        if (injectedKeySet.has(key.toUpperCase())) delete process.env[key];
      }
      for (const [key, value] of originalEntries) process.env[key] = value;
    }
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

  it('post-commit hook checks for fix: prefix', () => {
    const src = readFileSync(POST_COMMIT, 'utf8');
    assert.ok(src.includes('fix:'), 'hook must check for fix: prefix');
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
          ...testGitEnv,
          PATH: minPath + (process.platform === 'win32' ? ';' : ':') + process.env.PATH,
          GIT_TERMINAL_PROMPT: '0',
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@test.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@test.com',
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

  it('install-hook.sh installs locally without invoking npm or mutating global config', () => {
    const home = mkdtempSync(join(tmpdir(), 'claude-rca-hook-home-'));
    const gitconfig = join(home, 'global.gitconfig');
    const initialConfig = '[user]\n\tname = Test\n\temail = test@example.invalid\n';
    writeFileSync(gitconfig, initialConfig);
    const trapDir = join(home, 'trap-bin');
    const marker = join(home, 'npm-was-invoked');
    mkdirSync(trapDir, { recursive: true });
    const npmTrap = join(trapDir, 'npm');
    writeFileSync(npmTrap, `#!/bin/sh\nprintf invoked > "${marker}"\nexit 99\n`, 'utf8');
    try {
      chmodSync(npmTrap, 0o755);
    } catch {
      /* windows */
    }
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      GIT_CONFIG_GLOBAL: gitconfig,
      PATH:
        process.platform === 'win32'
          ? [
              trapDir,
              'C:\\Program Files\\Git\\cmd',
              'C:\\Program Files\\Git\\usr\\bin',
              'C:\\Windows\\System32',
            ].join(delimiter)
          : `${trapDir}${delimiter}/usr/bin${delimiter}/bin`,
      GIT_TERMINAL_PROMPT: '0',
    };
    git(['config', '--local', 'core.hooksPath', join(tmp, '.git', 'hooks')], tmp, env);

    const result = spawnSync(BASH, [INSTALL_HOOK, tmp], { cwd: tmp, encoding: 'utf8', env });

    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.strictEqual(existsSync(marker), false, 'shell installer must never invoke npm link');
    assert.strictEqual(readFileSync(gitconfig, 'utf8'), initialConfig);
  });

  it('install-hook.sh refuses an inherited global hooksPath without writing there', () => {
    const home = mkdtempSync(join(tmpdir(), 'claude-rca-hook-inherited-home-'));
    const sharedHooks = mkdtempSync(join(tmpdir(), 'claude-rca-hook-shared-'));
    const gitconfig = join(home, 'global.gitconfig');
    const initialConfig = `[core]\n\thooksPath = ${sharedHooks.replaceAll('\\', '/')}\n`;
    writeFileSync(gitconfig, initialConfig);
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      GIT_CONFIG_GLOBAL: gitconfig,
      GIT_TERMINAL_PROMPT: '0',
    };
    git(['config', '--local', '--unset', 'core.hooksPath'], tmp, env);

    const result = spawnSync(BASH, [INSTALL_HOOK, tmp], { cwd: tmp, encoding: 'utf8', env });

    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /inherited core\.hooksPath/i);
    assert.strictEqual(existsSync(join(sharedHooks, 'post-commit')), false);
    assert.strictEqual(existsSync(join(sharedHooks, 'commit-msg')), false);
    assert.strictEqual(readFileSync(gitconfig, 'utf8'), initialConfig);
  });
});
