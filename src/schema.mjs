import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

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
    provider: { enum: ['claude', 'codex'], default: 'claude' },
    claude: {
      type: 'object',
      additionalProperties: false,
      properties: {
        binary: { type: 'string', default: 'claude' },
        use_bare: { type: 'boolean', default: true },
        permission_mode: { enum: ['plan', 'default', 'bypassPermissions'], default: 'plan' },
        allowed_tools: { type: 'string', default: 'Read' },
        timeout_ms: { type: 'integer', minimum: 1000, default: 60000 },
        max_retries: { type: 'integer', minimum: 0, maximum: 5, default: 1 },
      },
    },
    codex: {
      type: 'object',
      additionalProperties: false,
      properties: {
        binary: { type: 'string', default: 'codex' },
        sandbox: {
          enum: ['read-only', 'workspace-write', 'danger-full-access'],
          default: 'read-only',
        },
        model: { type: 'string' },
        timeout_ms: { type: 'integer', minimum: 1000, default: 120000 },
        max_retries: { type: 'integer', minimum: 0, maximum: 5, default: 1 },
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

// Ajv costs ~150ms to import and ~50ms per compile. Every CLI invocation used to
// pay that at module load, including `version` and the per-commit hook. Defer it
// to first use and compile each schema at most once.
let ajvInstance = null;
function getAjv() {
  if (!ajvInstance) {
    const ajvMod = require('ajv/dist/2020.js');
    const formatsMod = require('ajv-formats');
    const Ajv2020 = ajvMod.default || ajvMod;
    const addFormats = formatsMod.default || formatsMod;
    ajvInstance = new Ajv2020({ allErrors: true, useDefaults: true });
    addFormats(ajvInstance);
  }
  return ajvInstance;
}

function formatErrors(errors) {
  return errors.map(
    (e) =>
      `${e.instancePath || '/'} ${e.message}${e.params?.allowedValue !== undefined ? ` (expected: ${e.params.allowedValue})` : ''}`,
  );
}

let configValidator = null;
function getConfigValidator() {
  if (!configValidator) configValidator = getAjv().compile(CONFIG_SCHEMA);
  return configValidator;
}

export function validateConfig(data) {
  const validate = getConfigValidator();
  const copy = JSON.parse(JSON.stringify(data));
  const valid = validate(copy);
  if (valid) {
    return { valid: true, data: copy, errors: [] };
  }
  return { valid: false, data: copy, errors: formatErrors(validate.errors) };
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

// Only generation validates an RCA, so neither the schema file read nor its
// compilation belongs on the module-load path.
let rcaValidator = null;
function getRcaValidator() {
  if (!rcaValidator) {
    const schema = JSON.parse(
      readFileSync(join(__dirname, '..', 'prompts', 'rca-schema.json'), 'utf8'),
    );
    rcaValidator = getAjv().compile(schema);
  }
  return rcaValidator;
}

export function validateRca(data) {
  // A provider can return a well-formed envelope with no structured output. Treat
  // that as a schema failure the caller can retry, not a JSON.parse(undefined) throw.
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, data: null, errors: [`/ expected an object, got ${typeof data}`] };
  }
  const validate = getRcaValidator();
  const copy = JSON.parse(JSON.stringify(data));
  const valid = validate(copy);
  if (valid) {
    return { valid: true, data: copy, errors: [] };
  }
  return { valid: false, data: copy, errors: formatErrors(validate.errors) };
}

export { CONFIG_SCHEMA };
