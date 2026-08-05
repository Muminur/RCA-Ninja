// Shared helpers for LLM provider adapters.
//
// Adapters live under src/providers/ and are the ONLY place allowed to know
// about a specific LLM CLI's flags and output shape. Everything outside this
// directory must stay provider-agnostic.

const PROVIDER_ENV_KEYS = [
  'PATH',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
];

const PROVIDER_AUTH_ENV_KEYS = {
  // Claude Code supports direct API-key and OAuth-token authentication. These
  // are the only secret-bearing variables retained for the Claude process.
  claude: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
  // Codex uses OPENAI_API_KEY. CODEX_API_KEY is intentionally not accepted.
  codex: ['OPENAI_API_KEY'],
};

export function buildProviderEnv(providerName, sourceEnv = process.env) {
  const safeEnv = {};
  const sourceKeys = Object.keys(sourceEnv ?? {});
  const allowedKeys = [...PROVIDER_ENV_KEYS, ...(PROVIDER_AUTH_ENV_KEYS[providerName] || [])];

  for (const allowedKey of allowedKeys) {
    const sourceKey = sourceKeys.find((key) => key.toLowerCase() === allowedKey.toLowerCase());
    if (sourceKey !== undefined && sourceEnv[sourceKey] !== undefined) {
      safeEnv[allowedKey] = sourceEnv[sourceKey];
    }
  }

  return safeEnv;
}

/**
 * Split a configured binary string into a command + fixed prefix args.
 *
 * Supports values like `"claude"`, `"codex"`, or `"node /path/to/stub.mjs"`
 * (used by the test stubs) by splitting on whitespace.
 *
 * @param {string|undefined} binaryRaw configured binary (may include args)
 * @param {string} fallback default binary when none configured
 * @returns {{ cmd: string, cmdPrefix: string[] }}
 */
export function resolveBinary(binaryRaw, fallback) {
  const parts = (binaryRaw || fallback).split(/\s+/).filter(Boolean);
  return { cmd: parts[0], cmdPrefix: parts.slice(1) };
}

/**
 * Derive an OpenAI-structured-output-compatible ("strict") JSON Schema from the
 * project's RCA schema. The OpenAI structured-output mode used by Codex's
 * `--output-schema` is stricter than AJV: every property must be listed in
 * `required`, `additionalProperties` must be false, and validation keywords like
 * `minLength`/`maxLength`/`pattern`/`minItems`/`format`/`default` are not
 * supported. We strip those keywords and mark every property required so Codex
 * accepts the schema; the REAL validation still happens locally via AJV against
 * the original schema after the model responds.
 *
 * @param {object} schema parsed JSON Schema (the RCA schema)
 * @returns {object} a strict-mode-safe clone
 */
export function toStrictSchema(schema) {
  const UNSUPPORTED = new Set([
    'minLength',
    'maxLength',
    'pattern',
    'format',
    'minItems',
    'maxItems',
    'uniqueItems',
    'minimum',
    'maximum',
    'default',
    '$schema',
    '$id',
  ]);

  function clean(node) {
    if (Array.isArray(node)) return node.map(clean);
    if (node && typeof node === 'object') {
      const out = {};
      for (const [key, value] of Object.entries(node)) {
        if (UNSUPPORTED.has(key)) continue;
        out[key] = clean(value);
      }
      if (out.type === 'object' && out.properties) {
        out.additionalProperties = false;
        // strict mode: every declared property must be required
        out.required = Object.keys(out.properties);
      }
      return out;
    }
    return node;
  }

  return clean(schema);
}
