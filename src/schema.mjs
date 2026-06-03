import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const CONFIG_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'claude-rca.config.v1',
  type: 'object',
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    enabled: { type: 'boolean', default: true },
    output_dir: { type: 'string', default: './rca' },
    auto_generate: { type: 'boolean', default: false },
    claude: {
      type: 'object',
      additionalProperties: false,
      properties: {
        binary: { type: 'string', default: 'claude' },
        use_bare: { type: 'boolean', default: true },
        permission_mode: { enum: ['plan', 'default', 'bypassPermissions'], default: 'plan' },
        allowed_tools: { type: 'string', default: 'Read,Bash' },
        timeout_ms: { type: 'integer', minimum: 1000, default: 60000 },
        max_retries: { type: 'integer', minimum: 0, maximum: 5, default: 1 },
      },
    },
    codex: {
      type: 'object',
      additionalProperties: false,
      properties: {
        binary: { type: 'string', default: 'codex' },
        timeout_ms: { type: 'integer', minimum: 1000, default: 60000 },
      },
    },
    obsidian: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', default: false },
        vault_path: { type: 'string', default: '' },
        target_folder: { type: 'string', default: '' },
        update_daily_note: { type: 'boolean', default: true },
        daily_note_format: { type: 'string', default: 'YYYY-MM-DD' },
        daily_notes_folder: { type: 'string', default: 'Daily Notes' },
        open_on_create: { type: 'boolean', default: false },
        api_key: { type: 'string', default: '' },
        api_host: { type: 'string', default: '127.0.0.1' },
        api_port: { type: 'integer', minimum: 1, maximum: 65535, default: 27124 },
        api_protocol: { enum: ['https', 'http'], default: 'https' },
      },
    },
    naming: {
      type: 'object',
      additionalProperties: false,
      properties: {
        max_slug_words: { type: 'integer', minimum: 1, maximum: 12, default: 5 },
        include_short_hash: { type: 'boolean', default: true },
      },
    },
    log: {
      type: 'object',
      additionalProperties: false,
      properties: {
        level: { enum: ['silent', 'error', 'warn', 'info', 'debug', 'trace'], default: 'info' },
        file: { type: 'string', default: '' },
      },
    },
    webhooks: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', default: false },
        url: { type: 'string', default: '' },
        format: { enum: ['slack', 'discord', 'generic'], default: 'generic' },
      },
    },
    diff_filter: {
      type: 'object',
      properties: {
        skip_files: { type: 'array', items: { type: 'string' } },
        skip_binary: { type: 'boolean' },
        per_file_cap_bytes: { type: 'integer', minimum: 1024 },
        drop_import_only_hunks: { type: 'boolean' },
        use_function_context: { type: 'boolean' },
        ast_extraction: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            single_hunk_threshold_bytes: { type: 'integer', minimum: 512 },
            languages: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    token_budget: {
      type: 'object',
      properties: {
        warn_at: { type: 'integer', minimum: 0 },
        hard_limit: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  required: ['version'],
};

const ajv = new Ajv2020({ allErrors: true, useDefaults: true });
addFormats(ajv);
const validate = ajv.compile(CONFIG_SCHEMA);

export function validateConfig(data) {
  const copy = JSON.parse(JSON.stringify(data));
  const valid = validate(copy);
  if (valid) {
    return { valid: true, data: copy, errors: [] };
  }
  const errors = validate.errors.map(
    (e) =>
      `${e.instancePath || '/'} ${e.message}${e.params?.allowedValue !== undefined ? ` (expected: ${e.params.allowedValue})` : ''}`,
  );
  return { valid: false, data: copy, errors };
}

export const VALID_KEYS = new Set();
function collectKeys(schema, prefix = '') {
  if (schema.properties) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      const path = prefix ? `${prefix}.${key}` : key;
      VALID_KEYS.add(path);
      if (sub.type === 'object' && sub.properties) {
        collectKeys(sub, path);
      }
    }
  }
}
collectKeys(CONFIG_SCHEMA);

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RCA_SCHEMA = JSON.parse(
  readFileSync(join(__dirname, '..', 'prompts', 'rca-schema.json'), 'utf8'),
);

const rcaValidate = ajv.compile(RCA_SCHEMA);

export function validateRca(data) {
  const copy = JSON.parse(JSON.stringify(data));
  const valid = rcaValidate(copy);
  if (valid) {
    return { valid: true, data: copy, errors: [] };
  }
  const errors = rcaValidate.errors.map(
    (e) =>
      `${e.instancePath || '/'} ${e.message}${e.params?.allowedValue !== undefined ? ` (expected: ${e.params.allowedValue})` : ''}`,
  );
  return { valid: false, data: copy, errors };
}

export { CONFIG_SCHEMA, RCA_SCHEMA };
