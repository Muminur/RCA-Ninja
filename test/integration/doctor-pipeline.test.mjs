import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { pathWithoutGitleaks } from '../fixtures/gitleaks-test-env.mjs';
import { makeIsolatedGitEnv } from '../fixtures/isolated-git-env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const BIN = join(ROOT, 'bin', 'claude-rca');
const POST_COMMIT = join(ROOT, 'hooks', 'post-commit');

function makeIsolatedEnv(prefix, { globalHooksPath } = {}) {
  return makeIsolatedGitEnv(prefix, { globalHooksPath }).env;
}

function git(args, cwd, env) {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
}

function makeRepo(prefix, { globalHooksPath, setLocalHooksPath = true } = {}) {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  const env = makeIsolatedEnv(prefix, { globalHooksPath });
  git(['init', '-q', '-b', 'main'], repo, env);
  if (setLocalHooksPath) {
    git(['config', '--local', 'core.hooksPath', join(repo, '.git', 'hooks')], repo, env);
  }
  return { repo, env };
}

function runDoctor(repo, env) {
  return spawnSync('node', [BIN, '--cwd', repo, 'doctor'], {
    encoding: 'utf8',
    cwd: repo,
    env,
  });
}

function installVersionedGitleaks(root, version = '8.30.1') {
  const binDir = join(root, 'scanner-bin');
  mkdirSync(binDir, { recursive: true });

  if (process.platform === 'win32') {
    const sourcePath = join(binDir, 'VersionedGitleaks.cs');
    const executable = join(binDir, 'gitleaks.exe');
    writeFileSync(
      sourcePath,
      `using System;\npublic class VersionedGitleaks {\n  public static int Main(string[] args) {\n    Console.WriteLine("gitleaks version ${version}");\n    return 0;\n  }\n}\n`,
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
    assert.strictEqual(compile.status, 0, compile.stderr);
    assert.ok(existsSync(executable));
  } else {
    const executable = join(binDir, 'gitleaks');
    writeFileSync(executable, `#!/bin/sh\nprintf 'gitleaks version ${version}\\n'\n`, 'utf8');
    chmodSync(executable, 0o755);
  }

  return `${binDir}${delimiter}${process.env.PATH || ''}`;
}

function installLocalHook(repo) {
  const hooksDir = join(repo, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  copyFileSync(POST_COMMIT, join(hooksDir, 'post-commit'));
}

describe('doctor checks the RCA pipeline itself', () => {
  it('WARNs on the config check when no config can be resolved', () => {
    const { repo, env } = makeRepo('claude-rca-doc-noconfig-');
    const { stdout } = runDoctor(repo, { ...env, PATH: pathWithoutGitleaks() });
    assert.ok(/^config\s+WARN/m.test(stdout), `config must be reported WARN, got:\n${stdout}`);
  });

  it('WARNs on the hook check when no post-commit hook is installed', () => {
    const { repo, env } = makeRepo('claude-rca-doc-nohook-');
    writeFileSync(join(repo, '.claude-rca.json'), JSON.stringify({ version: 1 }));

    const { stdout } = runDoctor(repo, { ...env, PATH: pathWithoutGitleaks() });
    assert.ok(/^hook\s+WARN/m.test(stdout), `hook must be reported WARN, got:\n${stdout}`);
  });

  it('fails the scanner check with static remediation and refuses unsafe auto-generation', () => {
    const { repo, env } = makeRepo('claude-rca-doc-no-scanner-');
    writeFileSync(
      join(repo, '.claude-rca.json'),
      JSON.stringify({ version: 1, auto_generate: true }),
    );
    installLocalHook(repo);

    const { stdout, status } = runDoctor(repo, {
      ...env,
      PATH: pathWithoutGitleaks(),
    });

    assert.match(
      stdout,
      /^secret-scanner\s+FAIL\s+Gitleaks 8\.30\.1 or newer is required; install or upgrade Gitleaks\. Scanner failure refuses provider execution\.$/m,
    );
    assert.doesNotMatch(stdout, /^secret-scanner\s+ok/m);
    assert.match(stdout, /^auto-gen\s+FAIL\s+.*unsafe.*provider isolation/im);
    assert.doesNotMatch(stdout, /^auto-gen\s+ok/m);
    assert.strictEqual(status, 70);
  });

  it('reports a healthy scanner and local hook without claiming provider execution is safe', () => {
    const { repo, env } = makeRepo('claude-rca-doc-healthy-inputs-');
    writeFileSync(
      join(repo, '.claude-rca.json'),
      JSON.stringify({ version: 1, auto_generate: true }),
    );
    installLocalHook(repo);
    const scannerRoot = mkdtempSync(join(tmpdir(), 'claude-rca-doctor-scanner-'));

    const { stdout, status } = runDoctor(repo, {
      ...env,
      PATH: installVersionedGitleaks(scannerRoot),
    });

    assert.match(stdout, /^secret-scanner\s+ok\s+gitleaks version 8\.30\.1$/m);
    assert.match(stdout, /^hook\s+ok/m);
    assert.match(stdout, /^provider-isolation\s+FAIL/m);
    assert.match(stdout, /^auto-gen\s+FAIL\s+.*unsafe.*provider isolation/im);
    assert.doesNotMatch(stdout, /^auto-gen\s+ok/m);
    assert.strictEqual(status, 70);
  });

  it('fails closed when the installed Gitleaks version is below 8.30.1', () => {
    const { repo, env } = makeRepo('claude-rca-doc-old-scanner-');
    writeFileSync(join(repo, '.claude-rca.json'), JSON.stringify({ version: 1 }));
    const scannerRoot = mkdtempSync(join(tmpdir(), 'claude-rca-doctor-old-scanner-'));

    const { stdout } = runDoctor(repo, {
      ...env,
      PATH: installVersionedGitleaks(scannerRoot, '8.29.9'),
    });

    assert.match(stdout, /^secret-scanner\s+FAIL\s+Gitleaks 8\.30\.1 or newer is required;/m);
    assert.doesNotMatch(stdout, /^secret-scanner\s+ok/m);
  });

  it('fails closed for a prerelease at the minimum Gitleaks version boundary', () => {
    const { repo, env } = makeRepo('claude-rca-doc-prerelease-scanner-');
    writeFileSync(join(repo, '.claude-rca.json'), JSON.stringify({ version: 1 }));
    const scannerRoot = mkdtempSync(join(tmpdir(), 'claude-rca-doctor-prerelease-scanner-'));

    const { stdout } = runDoctor(repo, {
      ...env,
      PATH: installVersionedGitleaks(scannerRoot, '8.30.1-rc.1'),
    });

    assert.match(stdout, /^secret-scanner\s+FAIL\s+Gitleaks 8\.30\.1 or newer is required;/m);
    assert.doesNotMatch(stdout, /^secret-scanner\s+ok/m);
  });

  it('reports auto_generate off as unavailable WARN with all prerequisites named', () => {
    const { repo, env } = makeRepo('claude-rca-doc-off-');
    writeFileSync(
      join(repo, '.claude-rca.json'),
      JSON.stringify({ version: 1, auto_generate: false }),
    );
    installLocalHook(repo);

    const { stdout } = runDoctor(repo, { ...env, PATH: pathWithoutGitleaks() });
    assert.match(stdout, /^auto-gen\s+WARN/m);
    assert.match(stdout, /^auto-gen\s+WARN\s+.*disabled.*scanner.*hook.*provider isolation/im);
    assert.doesNotMatch(stdout, /config --set auto_generate=true/);
  });

  it('detects the hook through the effective local core.hooksPath', () => {
    const { repo, env } = makeRepo('claude-rca-doc-hookspath-');
    writeFileSync(join(repo, '.claude-rca.json'), JSON.stringify({ version: 1 }));
    const custom = join(repo, 'githooks');
    mkdirSync(custom, { recursive: true });
    copyFileSync(POST_COMMIT, join(custom, 'post-commit'));
    git(['config', '--local', 'core.hooksPath', custom], repo, env);

    const { stdout } = runDoctor(repo, { ...env, PATH: pathWithoutGitleaks() });
    assert.ok(/^hook\s+ok/m.test(stdout), `hook must be found via core.hooksPath, got:\n${stdout}`);
  });

  it('rejects an RCA hook inherited through global core.hooksPath', () => {
    const sharedHooks = mkdtempSync(join(tmpdir(), 'claude-rca-doctor-shared-hooks-'));
    copyFileSync(POST_COMMIT, join(sharedHooks, 'post-commit'));
    const { repo, env } = makeRepo('claude-rca-doc-inherited-hook-', {
      globalHooksPath: sharedHooks,
      setLocalHooksPath: false,
    });
    writeFileSync(
      join(repo, '.claude-rca.json'),
      JSON.stringify({ version: 1, auto_generate: true }),
    );

    const { stdout } = runDoctor(repo, { ...env, PATH: pathWithoutGitleaks() });

    assert.match(stdout, /^hook\s+WARN\s+.*not repository-local/im);
    assert.doesNotMatch(stdout, /^hook\s+ok/m);
    assert.match(stdout, /^auto-gen\s+FAIL\s+.*local hook/im);
  });

  it('rejects an RCA hook injected through command-scope core.hooksPath', () => {
    const sharedHooks = mkdtempSync(join(tmpdir(), 'claude-rca-doctor-command-hooks-'));
    copyFileSync(POST_COMMIT, join(sharedHooks, 'post-commit'));
    const { repo, env } = makeRepo('claude-rca-doc-command-hook-');
    writeFileSync(
      join(repo, '.claude-rca.json'),
      JSON.stringify({ version: 1, auto_generate: true }),
    );

    const { stdout } = runDoctor(repo, {
      ...env,
      PATH: pathWithoutGitleaks(),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: sharedHooks,
    });

    assert.match(stdout, /^hook\s+WARN\s+.*unsafe Git environment/im);
    assert.doesNotMatch(stdout, /^hook\s+ok/m);
    assert.match(stdout, /^auto-gen\s+FAIL\s+.*local hook/im);
  });

  it('refuses hook validation under ambient Git repository or config redirection', () => {
    const { repo, env } = makeRepo('claude-rca-doc-env-refuse-');
    const { repo: redirectedRepo } = makeRepo('claude-rca-doc-env-redirected-');
    writeFileSync(join(repo, '.claude-rca.json'), JSON.stringify({ version: 1 }));
    installLocalHook(repo);
    const legacyConfig = join(repo, 'legacy.gitconfig');
    writeFileSync(legacyConfig, '[core]\n\thooksPath = ignored\n', 'utf8');
    const cases = [
      { GIT_DIR: join(redirectedRepo, '.git') },
      { GIT_WORK_TREE: redirectedRepo },
      { GIT_COMMON_DIR: join(redirectedRepo, '.git') },
      { GIT_CONFIG: legacyConfig },
      { GIT_CONFIG_GLOBAL: legacyConfig },
      { GIT_CONFIG_NOSYSTEM: '1' },
      { GIT_ATTR_NOSYSTEM: '1' },
    ];

    for (const gitEnvironment of cases) {
      const { stdout } = runDoctor(repo, {
        ...env,
        ...gitEnvironment,
        PATH: pathWithoutGitleaks(),
      });
      assert.match(stdout, /^hook\s+WARN\s+.*unsafe Git environment/im);
      assert.doesNotMatch(stdout, /^hook\s+ok/m);
    }
  });

  it('rejects a locally configured hooksPath outside repository-owned roots', () => {
    const sharedHooks = mkdtempSync(join(tmpdir(), 'claude-rca-doctor-local-escape-'));
    copyFileSync(POST_COMMIT, join(sharedHooks, 'post-commit'));
    const { repo, env } = makeRepo('claude-rca-doc-local-escape-');
    writeFileSync(join(repo, '.claude-rca.json'), JSON.stringify({ version: 1 }));
    git(['config', '--local', 'core.hooksPath', sharedHooks], repo, env);

    const { stdout } = runDoctor(repo, { ...env, PATH: pathWithoutGitleaks() });

    assert.match(stdout, /^hook\s+WARN\s+.*outside.*repository/im);
    assert.doesNotMatch(stdout, /^hook\s+ok/m);
  });

  it('does not trust an unrelated post-commit hook that only mentions claude-rca', () => {
    const { repo, env } = makeRepo('claude-rca-doc-unrelated-hook-');
    writeFileSync(join(repo, '.claude-rca.json'), JSON.stringify({ version: 1 }));
    const hooksDir = join(repo, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(
      join(hooksDir, 'post-commit'),
      '#!/bin/sh\n# claude-rca compatibility is handled elsewhere\n',
      'utf8',
    );

    const { stdout } = runDoctor(repo, { ...env, PATH: pathWithoutGitleaks() });

    assert.match(stdout, /^hook\s+WARN\s+.*not a managed RCA hook/im);
    assert.doesNotMatch(stdout, /^hook\s+ok/m);
  });

  it('rejects managed post-commit hooks that are symlinked or hard-linked', () => {
    for (const linkType of ['symlink', 'hardlink']) {
      const { repo, env } = makeRepo(`claude-rca-doc-${linkType}-hook-`);
      writeFileSync(join(repo, '.claude-rca.json'), JSON.stringify({ version: 1 }));
      const hooksDir = join(repo, '.git', 'hooks');
      const externalRoot = mkdtempSync(join(tmpdir(), `claude-rca-doc-${linkType}-external-`));
      const externalHook = join(externalRoot, 'post-commit');
      copyFileSync(POST_COMMIT, externalHook);
      if (linkType === 'symlink') {
        try {
          symlinkSync(externalHook, join(hooksDir, 'post-commit'), 'file');
        } catch (error) {
          if (process.platform === 'win32' && error?.code === 'EPERM') continue;
          throw error;
        }
      } else {
        linkSync(externalHook, join(hooksDir, 'post-commit'));
      }

      const { stdout } = runDoctor(repo, { ...env, PATH: pathWithoutGitleaks() });

      assert.match(stdout, /^hook\s+WARN\s+.*unsafe managed hook/im);
      assert.doesNotMatch(stdout, /^hook\s+ok/m);
    }
  });

  it('rejects a managed hook reached through a linked hooks directory', () => {
    const { repo, env } = makeRepo('claude-rca-doc-linked-hooks-dir-');
    writeFileSync(join(repo, '.claude-rca.json'), JSON.stringify({ version: 1 }));
    const actualHooks = join(repo, 'actual-hooks');
    const linkedHooks = join(repo, 'linked-hooks');
    mkdirSync(actualHooks, { recursive: true });
    copyFileSync(POST_COMMIT, join(actualHooks, 'post-commit'));
    symlinkSync(actualHooks, linkedHooks, process.platform === 'win32' ? 'junction' : 'dir');
    git(['config', '--local', 'core.hooksPath', linkedHooks], repo, env);

    const { stdout } = runDoctor(repo, { ...env, PATH: pathWithoutGitleaks() });

    assert.match(stdout, /^hook\s+WARN\s+.*unsafe hooks directory/im);
    assert.doesNotMatch(stdout, /^hook\s+ok/m);
  });

  it('isolates doctor from an ambient mixed-case legacy GIT_CONFIG', () => {
    const sharedRoot = mkdtempSync(join(tmpdir(), 'claude-rca-doctor-legacy-config-'));
    const sharedHooks = join(sharedRoot, 'hooks');
    const legacyConfig = join(sharedRoot, 'legacy.gitconfig');
    mkdirSync(sharedHooks, { recursive: true });
    copyFileSync(POST_COMMIT, join(sharedHooks, 'post-commit'));
    writeFileSync(
      legacyConfig,
      `[core]\n\thooksPath = ${sharedHooks.replaceAll('\\', '/')}\n`,
      'utf8',
    );
    const legacyKey = 'GIT_CONFIG';
    const originalEntries = Object.entries(process.env).filter(
      ([key]) => key.toUpperCase() === legacyKey,
    );

    try {
      process.env.Git_Config = legacyConfig;
      const { repo, env } = makeRepo('claude-rca-doc-legacy-config-', {
        globalHooksPath: sharedHooks,
        setLocalHooksPath: false,
      });
      writeFileSync(
        join(repo, '.claude-rca.json'),
        JSON.stringify({ version: 1, auto_generate: true }),
      );

      const { stdout } = runDoctor(repo, { ...env, PATH: pathWithoutGitleaks() });

      assert.doesNotMatch(stdout, /^hook\s+ok/m);
      assert.match(stdout, /^hook\s+WARN\s+.*not repository-local/im);
      assert.match(stdout, /^auto-gen\s+FAIL\s+.*local hook/im);
      assert.deepStrictEqual(
        Object.keys(env).filter((key) => key.toUpperCase() === legacyKey),
        [],
        'doctor test environment must scrub legacy GIT_CONFIG regardless of casing',
      );
    } finally {
      for (const key of Object.keys(process.env)) {
        if (key.toUpperCase() === legacyKey) delete process.env[key];
      }
      for (const [key, value] of originalEntries) process.env[key] = value;
    }
  });
});
