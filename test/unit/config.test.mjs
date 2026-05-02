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
    assert.strictEqual(cfg.claude.use_bare, false);
    assert.strictEqual(cfg.obsidian.enabled, true);
    assert.strictEqual(cfg.obsidian.target_folder, '');
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

  it('loads .env file and sets OBSIDIAN_API_KEY from environment', () => {
    const envKey = 'test-env-key-' + Date.now();
    writeFileSync(join(tmp, '.env'), `OBSIDIAN_API_KEY=${envKey}\nOBSIDIAN_PORT=27124\n`);
    writeFileSync(
      join(tmp, '.claude-rca.json'),
      JSON.stringify({ version: 1, obsidian: { enabled: true } }),
    );
    const origKey = process.env.OBSIDIAN_API_KEY;
    const origPort = process.env.OBSIDIAN_PORT;
    delete process.env.OBSIDIAN_API_KEY;
    delete process.env.OBSIDIAN_PORT;
    try {
      const cfg = loadConfig({ cwd: tmp });
      assert.strictEqual(cfg.obsidian.api_key, envKey);
      assert.strictEqual(cfg.obsidian.api_port, 27124);
    } finally {
      if (origKey) process.env.OBSIDIAN_API_KEY = origKey;
      else delete process.env.OBSIDIAN_API_KEY;
      if (origPort) process.env.OBSIDIAN_PORT = origPort;
      else delete process.env.OBSIDIAN_PORT;
    }
  });

  it('.env does not override existing environment variables', () => {
    const envKey = 'existing-key-' + Date.now();
    process.env.OBSIDIAN_API_KEY = envKey;
    writeFileSync(join(tmp, '.env'), 'OBSIDIAN_API_KEY=should-not-override\n');
    writeFileSync(
      join(tmp, '.claude-rca.json'),
      JSON.stringify({ version: 1, obsidian: { enabled: true } }),
    );
    try {
      const cfg = loadConfig({ cwd: tmp });
      assert.strictEqual(cfg.obsidian.api_key, envKey);
    } finally {
      delete process.env.OBSIDIAN_API_KEY;
    }
  });

  it('OBSIDIAN_API_KEY env var overrides api_key in .claude-rca.json', () => {
    const envKey = 'env-override-key-' + Date.now();
    const configKey = 'config-file-key-should-be-overridden';
    writeFileSync(
      join(tmp, '.claude-rca.json'),
      JSON.stringify({
        version: 1,
        obsidian: { enabled: true, api_key: configKey },
      }),
    );
    const orig = process.env.OBSIDIAN_API_KEY;
    process.env.OBSIDIAN_API_KEY = envKey;
    try {
      const cfg = loadConfig({ cwd: tmp });
      assert.strictEqual(
        cfg.obsidian.api_key,
        envKey,
        'env var must take precedence over config file api_key',
      );
    } finally {
      if (orig) process.env.OBSIDIAN_API_KEY = orig;
      else delete process.env.OBSIDIAN_API_KEY;
    }
  });

  it('.env handles comments, empty lines, and quoted values', () => {
    writeFileSync(
      join(tmp, '.env'),
      '# comment\n\nOBSIDIAN_HOST="custom-host"\nOBSIDIAN_PORT=27125\n',
    );
    writeFileSync(join(tmp, '.claude-rca.json'), JSON.stringify({ version: 1 }));
    const origHost = process.env.OBSIDIAN_HOST;
    const origPort = process.env.OBSIDIAN_PORT;
    delete process.env.OBSIDIAN_HOST;
    delete process.env.OBSIDIAN_PORT;
    try {
      const cfg = loadConfig({ cwd: tmp });
      assert.strictEqual(cfg.obsidian.api_host, 'custom-host');
      assert.strictEqual(cfg.obsidian.api_port, 27125);
    } finally {
      if (origHost) process.env.OBSIDIAN_HOST = origHost;
      else delete process.env.OBSIDIAN_HOST;
      if (origPort) process.env.OBSIDIAN_PORT = origPort;
      else delete process.env.OBSIDIAN_PORT;
    }
  });
});
