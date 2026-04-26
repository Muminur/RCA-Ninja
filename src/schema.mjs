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
    obsidian: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', default: false },
        vault_path: { type: 'string', default: '' },
        target_folder: { type: 'string', default: 'RCA Inbox' },
        update_daily_note: { type: 'boolean', default: true },
        daily_note_format: { type: 'string', default: 'YYYY-MM-DD' },
        daily_notes_folder: { type: 'string', default: 'Daily Notes' },
        open_on_create: { type: 'boolean', default: false },
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

export { CONFIG_SCHEMA };
