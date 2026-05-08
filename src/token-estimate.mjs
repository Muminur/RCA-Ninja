/** @module token-estimate */

/** Warn when estimated payload exceeds this many tokens. */
export const TOKEN_WARN_THRESHOLD = 80_000;

/** Hard limit — refuse generation above this. */
export const TOKEN_HARD_LIMIT = 180_000;

/**
 * Estimate tokens for a string using the 4 chars ≈ 1 token heuristic.
 * @param {string|null|undefined} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Estimate total token count for a Claude RCA generation payload.
 * @param {object} [payload]
 * @param {string} [payload.systemPrompt]
 * @param {string} [payload.schema]
 * @param {string} [payload.contextJson]
 * @param {string} [payload.diff]
 * @param {string} [payload.priorRcas]
 * @returns {{ total: number, breakdown: { system: number, schema: number, context: number, diff: number, prior: number } }}
 */
export function estimatePayload({ systemPrompt, schema, contextJson, diff, priorRcas } = {}) {
  const breakdown = {
    system: estimateTokens(systemPrompt),
    schema: estimateTokens(schema),
    context: estimateTokens(contextJson),
    diff: estimateTokens(diff),
    prior: estimateTokens(priorRcas),
  };
  const total = Object.values(breakdown).reduce((sum, v) => sum + v, 0);
  return { total, breakdown };
}
