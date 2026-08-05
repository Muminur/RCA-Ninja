import { readFileSync } from 'node:fs';
import { RcaError } from './errors.mjs';
import { estimatePayload, TOKEN_WARN_THRESHOLD, TOKEN_HARD_LIMIT } from './token-estimate.mjs';
import { scanProviderPayload } from './secret-scan.mjs';

const SECRET_REGEX = new RegExp(
  [
    // key=value style: api_key, secret, password, token followed by assignment
    '(api[_-]?key|secret|password|token)\\s*[:=]\\s*["\']?[A-Za-z0-9+/=]{16,}',
    // AWS access key IDs: AKIA/ASIA/AROA + 16 uppercase alphanumeric chars
    'A(?:KIA|SIA|ROA)[0-9A-Z]{16}',
    // Stripe/generic service keys: sk_live_, sk_test_, pk_live_, rk_live_
    '(?:sk|pk|rk)_(?:live|test)_[0-9a-zA-Z]{20,}',
    // JWT Bearer tokens: "Bearer eyJ..."
    'Bearer\\s+eyJ[A-Za-z0-9_-]{20,}',
  ].join('|'),
  'i',
);

export function scanForSecrets(diff) {
  return SECRET_REGEX.test(diff);
}

export function buildContextPayload({ context, priorRcas, diffFile }) {
  return {
    ref: context.short_hash,
    branch: context.branch,
    commit_message: context.commit_message,
    files_changed: context.files_changed,
    diff_path: diffFile,
    logs: context.logs,
    ...(priorRcas && priorRcas.length > 0 ? { prior_rcas: priorRcas } : {}),
  };
}

export function buildGenerationPayload({
  systemPrompt,
  schema,
  context,
  priorRcas,
  correctionHint,
}) {
  return JSON.stringify({
    systemPrompt,
    schema,
    context,
    priorRcas: priorRcas ?? null,
    correctionHint: correctionHint ?? null,
  });
}

export async function generate({
  context,
  systemPromptPath,
  schemaPath,
  correctionHint,
  priorRcas,
}) {
  const systemPrompt = readFileSync(systemPromptPath, 'utf8');
  const schema = readFileSync(schemaPath, 'utf8');
  const payload = buildGenerationPayload({
    systemPrompt,
    schema,
    context,
    priorRcas,
    correctionHint,
  });

  const contextJsonStr = JSON.stringify(context);
  const estimate = estimatePayload({
    systemPrompt,
    schema,
    contextJson: contextJsonStr,
    diff: context.diff,
    priorRcas: JSON.stringify(priorRcas || []),
  });

  if (estimate.total > TOKEN_HARD_LIMIT) {
    throw new RcaError('TOKEN_BUDGET_EXCEEDED', {
      reason: `Estimated ${estimate.total} tokens exceeds hard limit of ${TOKEN_HARD_LIMIT}. Breakdown: system=${estimate.breakdown.system}, schema=${estimate.breakdown.schema}, context=${estimate.breakdown.context}, diff=${estimate.breakdown.diff}, prior=${estimate.breakdown.prior}`,
    });
  }
  if (estimate.total > TOKEN_WARN_THRESHOLD) {
    process.stderr.write(
      `WARN: Token estimate ${estimate.total} exceeds warning threshold (${TOKEN_WARN_THRESHOLD}). Breakdown: ${JSON.stringify(estimate.breakdown)}\n`,
    );
  }
  process.stderr.write(`INFO: estimated_tokens=${estimate.total}\n`);

  await scanProviderPayload({ payload });
  throw new RcaError('PROVIDER_ISOLATION_UNAVAILABLE');
}
