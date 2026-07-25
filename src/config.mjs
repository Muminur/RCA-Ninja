import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { validateConfig, VALID_KEYS } from './schema.mjs';
import { RcaError } from './errors.mjs';

function loadDotenv(dir) {
  const envPath = join(dir, '.env');
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

export const DEFAULTS = {
  version: 1,
  output_dir: './rca',
  claude: { use_bare: false, permission_mode: 'plan', allowed_tools: 'Read,Bash' },
  obsidian: { enabled: false },
};

const INIT_CONFIG = {
  version: 1,
  output_dir: './rca',
  claude: { use_bare: false, permission_mode: 'plan', allowed_tools: 'Read,Bash' },
  obsidian: { enabled: false },
};

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function tryLoadJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export const PROJECT_CONFIG_NAME = '.claude-rca.json';

/** Case/separator-insensitive path compare (Windows drive + slash variance). */
function samePath(a, b) {
  return a.replace(/[\\/]+/g, sep).toLowerCase() === b.replace(/[\\/]+/g, sep).toLowerCase();
}

/** Synchronous, non-throwing git query. Returns null outside a repo. */
function gitSync(args, cwd) {
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    const trimmed = out.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

/**
 * Resolve a git path query to an absolute path. `--path-format=absolute` needs
 * git >= 2.31; older versions fall back to resolving the raw output against cwd.
 */
function gitAbsPath(what, cwd) {
  const modern = gitSync(['rev-parse', '--path-format=absolute', what], cwd);
  if (modern) return resolve(modern);
  const legacy = gitSync(['rev-parse', what], cwd);
  return legacy ? resolve(cwd, legacy) : null;
}

/**
 * Locate the project config file.
 *
 * Order matters, and each step exists for a concrete failure:
 *   1. cwd — the common case, and lets a worktree override deliberately.
 *   2. Walk up, BOUNDED at the repo top-level — so running from a subdirectory
 *      works without adopting an unrelated config from a parent directory.
 *   3. The main checkout, via --git-common-dir — a linked worktree never
 *      contains the (gitignored) config, and its top-level is itself, so the
 *      bounded walk above cannot find it.
 *
 * Returns null when no config exists, leaving callers on DEFAULTS.
 */
export function findProjectConfig(cwd) {
  const direct = join(cwd, PROJECT_CONFIG_NAME);
  if (existsSync(direct)) return direct;

  const top = gitAbsPath('--show-toplevel', cwd);
  if (top) {
    let dir = resolve(cwd);
    // Depth guard: cwd is normally under `top`, but never loop unbounded if not.
    for (let depth = 0; depth < 64; depth += 1) {
      const candidate = join(dir, PROJECT_CONFIG_NAME);
      if (existsSync(candidate)) return candidate;
      if (samePath(dir, top)) break;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  const commonDir = gitAbsPath('--git-common-dir', cwd);
  if (commonDir) {
    const candidate = join(dirname(commonDir), PROJECT_CONFIG_NAME);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

export function loadConfig({ cwd = process.cwd(), configPath = null } = {}) {
  loadDotenv(cwd);

  const sources = [];

  sources.push(DEFAULTS);

  const xdgHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const xdgConfig = tryLoadJson(join(xdgHome, 'claude-rca', 'config.json'));
  if (xdgConfig) sources.push(xdgConfig);

  const projectConfigPath = findProjectConfig(cwd);
  const projectConfig = projectConfigPath ? tryLoadJson(projectConfigPath) : null;
  if (projectConfig) sources.push(projectConfig);

  const envPath = process.env.CLAUDE_RCA_CONFIG;
  if (envPath) {
    const envConfig = tryLoadJson(envPath);
    if (envConfig) sources.push(envConfig);
  }

  if (configPath) {
    const flagConfig = tryLoadJson(configPath);
    if (flagConfig) sources.push(flagConfig);
  }

  let merged = {};
  for (const source of sources) {
    merged = deepMerge(merged, source);
  }

  const { data } = validateConfig(merged);

  // A relative output_dir belongs to the project that owns the config, not to
  // wherever the process happens to be running. Without this, a hook firing in
  // a linked worktree writes RCAs into the worktree and they die with it.
  if (data.output_dir) {
    const baseDir = projectConfigPath ? dirname(projectConfigPath) : cwd;
    data.output_dir = resolve(baseDir, data.output_dir);
  }

  // Record provenance so callers (and `doctor`) can report which file was used.
  Object.defineProperty(data, 'configPath', {
    value: projectConfigPath,
    enumerable: false,
  });

  if (process.env.OBSIDIAN_API_KEY) {
    if (!data.obsidian) data.obsidian = {};
    data.obsidian.api_key = process.env.OBSIDIAN_API_KEY;
  }
  if (process.env.OBSIDIAN_HOST) {
    if (!data.obsidian) data.obsidian = {};
    data.obsidian.api_host = process.env.OBSIDIAN_HOST;
  }
  if (process.env.OBSIDIAN_PORT) {
    if (!data.obsidian) data.obsidian = {};
    data.obsidian.api_port = parseInt(process.env.OBSIDIAN_PORT, 10);
  }

  return data;
}

export function getConfigValue(cfg, keyPath) {
  if (!VALID_KEYS.has(keyPath)) {
    throw new RcaError('INVALID_CONFIG_KEY', { key: keyPath });
  }
  const parts = keyPath.split('.');
  let val = cfg;
  for (const p of parts) {
    if (val == null || typeof val !== 'object') return undefined;
    val = val[p];
  }
  return val;
}

export function setConfigValue(configPath, keyPath, rawValue) {
  if (!VALID_KEYS.has(keyPath)) {
    throw new RcaError('INVALID_CONFIG_KEY', { key: keyPath });
  }

  const data = JSON.parse(readFileSync(configPath, 'utf8'));
  const parts = keyPath.split('.');
  const lastKey = parts.pop();
  let obj = data;
  for (const p of parts) {
    if (!obj[p] || typeof obj[p] !== 'object') obj[p] = {};
    obj = obj[p];
  }

  let value = rawValue;
  if (rawValue === 'true') value = true;
  else if (rawValue === 'false') value = false;
  else if (/^\d+$/.test(rawValue)) value = parseInt(rawValue, 10);

  obj[lastKey] = value;

  const result = validateConfig(data);
  if (!result.valid) {
    throw new RcaError('INVALID_CONFIG_VALUE', {
      key: keyPath,
      reason: result.errors.join('; '),
    });
  }

  writeFileSync(configPath, JSON.stringify(data, null, 2) + '\n');
}

export function initProject(cwd) {
  const configPath = join(cwd, '.claude-rca.json');
  const rcaDir = join(cwd, 'rca');

  if (existsSync(configPath)) {
    throw new RcaError('ALREADY_INIT', { path: configPath });
  }

  mkdirSync(rcaDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(INIT_CONFIG, null, 2) + '\n');

  return { configPath, rcaDir };
}
