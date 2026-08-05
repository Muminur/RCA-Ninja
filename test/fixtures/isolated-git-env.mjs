import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BLOCKED_GIT_ENV_KEYS = new Set([
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
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
  const gitconfig = join(home, 'global.gitconfig');
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

  return {
    home,
    gitconfig,
    initialConfig,
    env: {
      ...env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, 'xdg'),
      GIT_CONFIG_GLOBAL: gitconfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  };
}
