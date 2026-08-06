import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BLOCKED_GIT_ENV_KEYS = new Set([
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'GIT_CONFIG',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_TEMPLATE_DIR',
]);

export function makeIsolatedGitEnv(
  prefix,
  { globalHooksPath, userName = 'Test', userEmail = 'test@example.invalid' } = {},
) {
  const home = mkdtempSync(join(tmpdir(), `${prefix}-home-`));
  const gitconfig = join(home, '.gitconfig');
  const hooksConfig = globalHooksPath
    ? `[core]\n\thooksPath = ${globalHooksPath.replaceAll('\\', '/')}\n`
    : '';
  const initialConfig = `${hooksConfig}[user]\n\tname = ${userName}\n\temail = ${userEmail}\n`;
  writeFileSync(gitconfig, initialConfig);

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    const normalizedKey = key.toUpperCase();
    if (normalizedKey.startsWith('GIT_CONFIG_') || BLOCKED_GIT_ENV_KEYS.has(normalizedKey)) {
      delete env[key];
    }
  }
  const pathValue = env.PATH ?? env.Path;
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'PATH') {
      delete env[key];
    }
  }

  return {
    home,
    gitconfig,
    initialConfig,
    env: {
      ...env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, 'xdg'),
      PATH: pathValue,
      GIT_TERMINAL_PROMPT: '0',
    },
  };
}

export function installGitDirectorySwapTrap(root, { hooksDir, externalDir }) {
  const realGit =
    process.platform === 'win32'
      ? execFileSync('where.exe', ['git'], { encoding: 'utf8' }).trim().split(/\r?\n/, 1)[0]
      : execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const swapScript = join(root, 'swap-hooks-directory.mjs');
  writeFileSync(
    swapScript,
    `import { existsSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
if (!existsSync(process.env.RCA_SWAP_MARKER)) {
  writeFileSync(process.env.RCA_SWAP_MARKER, 'swapped');
  renameSync(process.env.RCA_HOOKS_DIR, process.env.RCA_MOVED_HOOKS_DIR);
  symlinkSync(
    process.env.RCA_EXTERNAL_HOOKS_DIR,
    process.env.RCA_HOOKS_DIR,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
}
`,
    'utf8',
  );
  const nodePreload = join(root, 'swap-git-preload.cjs');
  writeFileSync(
    nodePreload,
    `const { syncBuiltinESMExports } = require('node:module');
const childProcess = require('node:child_process');
const execFileSync = childProcess.execFileSync;
childProcess.execFileSync = (file, args, options) => {
  const result = execFileSync(file, args, options);
  if (file === 'git' && args?.includes('--show-toplevel')) {
    execFileSync(process.execPath, [process.env.RCA_SWAP_SCRIPT], { env: process.env });
  }
  return result;
};
syncBuiltinESMExports();
`,
    'utf8',
  );
  const bashEnv = join(root, 'swap-git-bash-env.sh');
  writeFileSync(
    bashEnv,
    `git() {
  local OUTPUT
  local STATUS
  local ARG
  OUTPUT="$("$RCA_REAL_GIT" "$@")"
  STATUS=$?
  for ARG in "$@"; do
    if [ "$ARG" = "--show-toplevel" ]; then
      node "$RCA_SWAP_SCRIPT"
      break
    fi
  done
  printf '%s\\n' "$OUTPUT"
  return "$STATUS"
}
`,
    'utf8',
  );

  const swapGit = join(root, 'git');
  writeFileSync(
    swapGit,
    `#!/bin/sh
OUTPUT="$("$RCA_REAL_GIT" "$@")"
STATUS=$?
for ARG in "$@"; do
  if [ "$ARG" = "--show-toplevel" ]; then
    node "$RCA_SWAP_SCRIPT"
    break
  fi
done
printf '%s\\n' "$OUTPUT"
exit "$STATUS"
`,
    'utf8',
  );
  try {
    chmodSync(swapGit, 0o755);
  } catch {
    /* windows */
  }

  return {
    nodePreload,
    bashEnv,
    swapGit,
    env: {
      RCA_REAL_GIT: realGit,
      RCA_HOOKS_DIR: hooksDir,
      RCA_MOVED_HOOKS_DIR: `${hooksDir}-validated`,
      RCA_EXTERNAL_HOOKS_DIR: externalDir,
      RCA_SWAP_MARKER: join(root, 'git-swap-complete'),
      RCA_SWAP_SCRIPT: swapScript,
    },
  };
}
