import { readFileSync } from 'node:fs';
import { RcaError } from './errors.mjs';
import { estimatePayload, TOKEN_WARN_THRESHOLD, TOKEN_HARD_LIMIT } from './token-estimate.mjs';
import { scanProviderPayload } from './secret-scan.mjs';
import { validateRca } from './schema.mjs';
import { getProvider, SUPPORTED_PROVIDERS } from './providers/index.mjs';
import {
  withProviderWorkspace,
  runProviderInvocation,
  classifyProviderFailure,
  UNUSABLE_REASONS,
} from './provider-run.mjs';

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

// A model may return extra keys, or a string where the schema wants a list.
// Everything outside this set is dropped rather than passed to AJV, so one
// stray field does not cost a whole regeneration.
const ALLOWED_KEYS = new Set([
  'title',
  'symptom',
  'root_cause',
  'fix',
  'impact',
  'files',
  'tags',
  'references',
  'confidence',
  'code_changes',
  'description',
  'components',
]);

const STRING_FIELDS = ['title', 'symptom', 'root_cause', 'fix', 'impact'];
const LIST_FIELDS = ['files', 'tags', 'references'];

/**
 * Coerce a model response into the RCA schema, recording which required fields
 * had to be filled in. `audit` reports those, so a degraded RCA is visible
 * rather than passing as a real analysis.
 *
 * @returns {{ rca: object, autoFilled: string[] }}
 * @throws {RcaError} SCHEMA_VALIDATION when the result still does not validate
 */
function normaliseRca(rcaData, context) {
  for (const key of Object.keys(rcaData)) {
    if (!ALLOWED_KEYS.has(key)) delete rcaData[key];
  }
  for (const field of STRING_FIELDS) {
    if (rcaData[field] && typeof rcaData[field] !== 'string') {
      rcaData[field] = Array.isArray(rcaData[field])
        ? rcaData[field].join('. ')
        : String(rcaData[field]);
    }
  }
  for (const field of LIST_FIELDS) {
    if (rcaData[field] && !Array.isArray(rcaData[field])) {
      rcaData[field] = typeof rcaData[field] === 'string' ? [rcaData[field]] : [];
    }
  }

  const autoFilled = [];
  if (!rcaData.files || rcaData.files.length === 0) {
    rcaData.files = context.files_changed || ['unknown'];
    autoFilled.push('files');
  }
  if (!rcaData.references) {
    rcaData.references = [];
    autoFilled.push('references');
  }
  if (!rcaData.confidence || !['high', 'medium', 'low', 'unknown'].includes(rcaData.confidence)) {
    rcaData.confidence = 'medium';
    autoFilled.push('confidence');
  }
  if (!rcaData.tags || rcaData.tags.length < 2) {
    rcaData.tags = ['rca', 'bugfix'];
    autoFilled.push('tags');
  }
  if (!rcaData.impact) {
    rcaData.impact = rcaData.symptom || 'See symptom for affected scope.';
    autoFilled.push('impact');
  }
  // Optional fields: defaulted silently, since their absence is not degradation.
  if (!Array.isArray(rcaData.code_changes)) rcaData.code_changes = [];
  if (typeof rcaData.description !== 'string') rcaData.description = '';
  if (!Array.isArray(rcaData.components)) rcaData.components = [];

  const result = validateRca(rcaData);
  if (!result.valid) {
    throw new RcaError('SCHEMA_VALIDATION', { ajv_first_error: result.errors[0] });
  }
  return { rca: result.data, autoFilled };
}

/**
 * Run one provider end to end inside its own throwaway workspace.
 *
 * Distinguishes two failures that need different responses: the provider could
 * not run at all (not installed, logged out, rate limited) — try another one —
 * versus the provider ran and answered badly — retry it, then give up, because
 * a different model would usually fail the same way.
 *
 * @returns {Promise<{ok: true, rca: object, autoFilled: string[], cost?: number, sessionId?: string}
 *   | {ok: false, unusable: 'MISSING'|'AUTH'|'LIMIT'}
 *   | {ok: false, schemaError: RcaError}>}
 */
async function attemptProvider(providerName, { config, payload, schemaStr, context }) {
  const provider = getProvider(providerName);

  return withProviderWorkspace(async (workspaceDir) => {
    const inv = provider.buildGenerateInvocation({ config, payload, schemaStr, workspaceDir });
    const maxRetries = inv.maxRetries ?? 1;
    let schemaError = null;

    try {
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const outcome = await runProviderInvocation(inv);

        let rcaData = null;
        let cost;
        let sessionId;
        try {
          ({ rcaData, cost, sessionId } = inv.extractRca(outcome.stdout) ?? {});
        } catch {
          rcaData = null;
        }

        if (!rcaData) {
          // Classified only now, after extraction has already failed, so an RCA
          // that legitimately discusses a "rate limit" is never mistaken for one.
          const unusable = classifyProviderFailure(outcome);
          if (unusable) return { ok: false, unusable };
          schemaError = new RcaError('SCHEMA_VALIDATION', {
            ajv_first_error: `${providerName} returned no RCA object`,
          });
          continue;
        }

        try {
          const { rca, autoFilled } = normaliseRca(rcaData, context);
          return { ok: true, rca, autoFilled, cost, sessionId };
        } catch (err) {
          schemaError = err;
        }
      }

      return {
        ok: false,
        schemaError:
          schemaError ??
          new RcaError('SCHEMA_VALIDATION', {
            ajv_first_error: `${providerName} produced no usable RCA`,
          }),
      };
    } finally {
      try {
        inv?.cleanup?.();
      } catch {
        /* the workspace is removed either way */
      }
    }
  });
}

export async function generate({
  context,
  config,
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

  // The gate: nothing reaches a provider until the payload has been scanned.
  await scanProviderPayload({ payload, workspaceRoot: context.repo_root ?? context.cwd });

  // Configured provider first, then the others. A logged-out or rate-limited
  // primary must not cost the commit its RCA.
  const primary = config?.provider || 'claude';
  const order = [primary, ...SUPPORTED_PROVIDERS.filter((p) => p !== primary)];

  const unusable = [];
  let schemaError = null;

  for (const providerName of order) {
    const outcome = await attemptProvider(providerName, {
      config,
      payload,
      schemaStr: schema,
      context,
    });

    if (outcome.ok) {
      if (providerName !== primary) {
        process.stderr.write(`INFO: ${primary} unavailable — generated with ${providerName}\n`);
      }
      return {
        rca: outcome.rca,
        autoFilled: outcome.autoFilled,
        cost: outcome.cost,
        sessionId: outcome.sessionId,
        provider: providerName,
      };
    }

    if (outcome.unusable) {
      unusable.push(`${providerName} (${UNUSABLE_REASONS[outcome.unusable]})`);
      continue;
    }

    // The provider ran. Keep its complaint, but still let the next one try —
    // a different model sometimes answers a schema the first one fumbled.
    schemaError = outcome.schemaError;
  }

  if (schemaError) throw schemaError;
  throw new RcaError('PROVIDER_UNAVAILABLE', { providers: unusable.join(', ') });
}
