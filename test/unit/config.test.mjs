import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('config', () => {
  let loadConfig, getConfigValue, setConfigValue, DEFAULTS;
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'claude-rca-config-'));
  });

  it('can import config module', async () => {
    const mod = await import('../../src/config.mjs');
    loadConfig = mod.loadConfig;
    getConfigValue = mod.getConfigValue;
    setConfigValue = mod.setConfigValue;
    DEFAULTS = mod.DEFAULTS;
    assert.ok(loadConfig);
    assert.ok(DEFAULTS);
  });

  it('returns defaults when no config file exists', () => {
    const cfg = loadConfig({ cwd: tmp });
    assert.strictEqual(cfg.version, 1);
    assert.strictEqual(cfg.output_dir, join(tmp, 'rca'));
  });

  it('loads config from project file', () => {
    writeFileSync(
      join(tmp, '.claude-rca.json'),
      JSON.stringify({ version: 1, output_dir: './custom-rca' }),
    );
    const cfg = loadConfig({ cwd: tmp });
    assert.strictEqual(cfg.output_dir, join(tmp, 'custom-rca'));
  });

  it('CLI flag config overrides project config', () => {
    writeFileSync(
      join(tmp, '.claude-rca.json'),
      JSON.stringify({ version: 1, output_dir: './project-rca' }),
    );
    const flagDir = join(tmp, 'flag-config');
    mkdirSync(flagDir, { recursive: true });
    writeFileSync(
      join(flagDir, 'config.json'),
      JSON.stringify({ version: 1, output_dir: './flag-rca' }),
    );
    const cfg = loadConfig({ cwd: tmp, configPath: join(flagDir, 'config.json') });
    assert.strictEqual(cfg.output_dir, join(tmp, 'flag-rca'));
  });

  it('deep-merges objects from multiple sources', () => {
    writeFileSync(
      join(tmp, '.claude-rca.json'),
      JSON.stringify({
        version: 1,
        claude: { timeout_ms: 30000 },
        obsidian: { enabled: true, vault_path: '/tmp/vault' },
      }),
    );
    const cfg = loadConfig({ cwd: tmp });
    assert.strictEqual(cfg.claude.timeout_ms, 30000);
    assert.strictEqual(cfg.claude.use_bare, true);
    assert.strictEqual(cfg.obsidian.enabled, true);
    assert.strictEqual(cfg.obsidian.target_folder, 'RCA Inbox');
  });

  it('normalizes output_dir to absolute path', () => {
    writeFileSync(
      join(tmp, '.claude-rca.json'),
      JSON.stringify({ version: 1, output_dir: './relative/path' }),
    );
    const cfg = loadConfig({ cwd: tmp });
    assert.ok(cfg.output_dir.startsWith(tmp));
    assert.ok(
      cfg.output_dir.endsWith('relative/path') || cfg.output_dir.endsWith('relative\\path'),
    );
  });

  it('get returns nested values by dot path', () => {
    const cfg = { version: 1, claude: { timeout_ms: 60000 }, log: { level: 'info' } };
    assert.strictEqual(getConfigValue(cfg, 'version'), 1);
    assert.strictEqual(getConfigValue(cfg, 'claude.timeout_ms'), 60000);
    assert.strictEqual(getConfigValue(cfg, 'log.level'), 'info');
  });

  it('get throws INVALID_CONFIG_KEY for unknown keys', () => {
    const cfg = { version: 1 };
    assert.throws(
      () => getConfigValue(cfg, 'nonexistent'),
      (err) => err.code === 'INVALID_CONFIG_KEY',
    );
  });

  it('set round-trips with get', () => {
    const configPath = join(tmp, '.claude-rca.json');
    writeFileSync(configPath, JSON.stringify({ version: 1 }));
    setConfigValue(configPath, 'claude.timeout_ms', '30000');
    const data = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.strictEqual(data.claude.timeout_ms, 30000);
  });

  it('set rejects invalid keys', () => {
    const configPath = join(tmp, '.claude-rca.json');
    writeFileSync(configPath, JSON.stringify({ version: 1 }));
    assert.throws(
      () => setConfigValue(configPath, 'bogus_key', 'value'),
      (err) => err.code === 'INVALID_CONFIG_KEY',
    );
  });

  it('set rejects invalid values', () => {
    const configPath = join(tmp, '.claude-rca.json');
    writeFileSync(configPath, JSON.stringify({ version: 1 }));
    assert.throws(
      () => setConfigValue(configPath, 'claude.timeout_ms', '100'),
      (err) => err.code === 'INVALID_CONFIG_VALUE',
    );
  });
});
