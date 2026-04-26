import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('config schema', () => {
  let validateConfig;

  it('can import schema module', async () => {
    const mod = await import('../../src/schema.mjs');
    validateConfig = mod.validateConfig;
    assert.strictEqual(typeof validateConfig, 'function');
  });

  it('accepts minimal valid config', () => {
    const result = validateConfig({ version: 1 });
    assert.strictEqual(result.valid, true);
  });

  it('requires version: 1', () => {
    const result = validateConfig({});
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('version')));
  });

  it('rejects version !== 1', () => {
    const result = validateConfig({ version: 2 });
    assert.strictEqual(result.valid, false);
  });

  it('rejects unknown top-level keys', () => {
    const result = validateConfig({ version: 1, bogus_key: true });
    assert.strictEqual(result.valid, false);
  });

  it('rejects unknown nested keys', () => {
    const result = validateConfig({ version: 1, claude: { bogus: true } });
    assert.strictEqual(result.valid, false);
  });

  it('accepts full valid config', () => {
    const result = validateConfig({
      version: 1,
      enabled: true,
      output_dir: './rca',
      auto_generate: false,
      claude: {
        binary: 'claude',
        use_bare: true,
        permission_mode: 'plan',
        allowed_tools: 'Read',
        timeout_ms: 60000,
        max_retries: 1,
      },
      obsidian: {
        enabled: false,
        vault_path: '',
        target_folder: 'RCA Inbox',
        update_daily_note: true,
        daily_note_format: 'YYYY-MM-DD',
        daily_notes_folder: 'Daily Notes',
        open_on_create: false,
      },
      naming: { max_slug_words: 5, include_short_hash: true },
      log: { level: 'info', file: '' },
    });
    assert.strictEqual(result.valid, true);
  });

  it('rejects invalid permission_mode', () => {
    const result = validateConfig({ version: 1, claude: { permission_mode: 'yolo' } });
    assert.strictEqual(result.valid, false);
  });

  it('rejects timeout_ms below minimum', () => {
    const result = validateConfig({ version: 1, claude: { timeout_ms: 500 } });
    assert.strictEqual(result.valid, false);
  });

  it('rejects max_retries above maximum', () => {
    const result = validateConfig({ version: 1, claude: { max_retries: 10 } });
    assert.strictEqual(result.valid, false);
  });

  it('rejects invalid log level', () => {
    const result = validateConfig({ version: 1, log: { level: 'verbose' } });
    assert.strictEqual(result.valid, false);
  });
});
