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

  // diff_filter section tests
  it('diff_filter.per_file_cap_bytes: 30000 validates', () => {
    const result = validateConfig({ version: 1, diff_filter: { per_file_cap_bytes: 30000 } });
    assert.strictEqual(result.valid, true);
  });

  it('diff_filter.per_file_cap_bytes: 500 rejects (below min 1024)', () => {
    const result = validateConfig({ version: 1, diff_filter: { per_file_cap_bytes: 500 } });
    assert.strictEqual(result.valid, false);
  });

  it('diff_filter.drop_import_only_hunks: true validates as boolean', () => {
    const result = validateConfig({
      version: 1,
      diff_filter: { drop_import_only_hunks: true },
    });
    assert.strictEqual(result.valid, true);
  });

  it('diff_filter.use_function_context: true validates as boolean', () => {
    const result = validateConfig({
      version: 1,
      diff_filter: { use_function_context: true },
    });
    assert.strictEqual(result.valid, true);
  });

  it('diff_filter.ast_extraction validates with enabled, threshold, and languages', () => {
    const result = validateConfig({
      version: 1,
      diff_filter: {
        ast_extraction: {
          enabled: true,
          single_hunk_threshold_bytes: 5000,
          languages: ['js', 'ts', 'py'],
        },
      },
    });
    assert.strictEqual(result.valid, true);
  });

  // token_budget section tests
  it('token_budget.warn_at: 80000, hard_limit: 180000 validates', () => {
    const result = validateConfig({
      version: 1,
      token_budget: { warn_at: 80000, hard_limit: 180000 },
    });
    assert.strictEqual(result.valid, true);
  });

  it('token_budget.hard_limit: -1 rejects (minimum 0)', () => {
    const result = validateConfig({ version: 1, token_budget: { hard_limit: -1 } });
    assert.strictEqual(result.valid, false);
  });

  // regression guard: config without diff_filter/token_budget still validates
  it('config without diff_filter or token_budget still validates', () => {
    const result = validateConfig({ version: 1 });
    assert.strictEqual(result.valid, true);
  });
});
