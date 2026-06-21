// Shared helpers for LLM provider adapters.
//
// Adapters live under src/providers/ and are the ONLY place allowed to know
// about a specific LLM CLI's flags and output shape. Everything outside this
// directory must stay provider-agnostic.

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
