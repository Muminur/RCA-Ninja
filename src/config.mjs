import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
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
  claude: { use_bare: true, permission_mode: 'plan', allowed_tools: 'Read,Bash' },
  obsidian: { enabled: false },
};

const INIT_CONFIG = {
  version: 1,
  output_dir: './rca',
  claude: { use_bare: true, permission_mode: 'plan', allowed_tools: 'Read,Bash' },
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

export function loadConfig({ cwd = process.cwd(), configPath = null } = {}) {
  loadDotenv(cwd);

  const sources = [];

  sources.push(DEFAULTS);

  const xdgHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const xdgConfig = tryLoadJson(join(xdgHome, 'claude-rca', 'config.json'));
  if (xdgConfig) sources.push(xdgConfig);

  const projectConfig = tryLoadJson(join(cwd, '.claude-rca.json'));
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

  if (data.output_dir) {
    data.output_dir = resolve(cwd, data.output_dir);
  }

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
