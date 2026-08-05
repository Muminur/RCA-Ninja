import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run } from './util/exec.mjs';
import { validateRca } from './schema.mjs';
import { RcaError } from './errors.mjs';
import { estimatePayload, TOKEN_WARN_THRESHOLD, TOKEN_HARD_LIMIT } from './token-estimate.mjs';
import { getProvider } from './providers/index.mjs';
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

/**
 * Run generation through a single named provider (claude or codex): build the
 * invocation, run it with schema-validation retries, then post-process and
 * validate the RCA. Throws RcaError SCHEMA_VALIDATION (already retried) or
 * CLAUDE_FAILURE. The invocation's own temp files are cleaned up here.
 */
async function runProviderGenerate(
  providerName,
  { config, context, schema, payload, workspaceDir, scanFn, runFn },
) {
  const provider = getProvider(providerName);
  const inv = provider.buildGenerateInvocation({
    config,
    schemaStr: schema,
    payload,
    workspaceDir,
  });

  try {
    let lastError;
    for (let attempt = 0; attempt <= inv.maxRetries; attempt++) {
      try {
        await scanFn({ payload });
        const { stdout } = await runFn(inv.cmd, inv.argv, {
          cwd: inv.cwd,
          env: inv.env,
          timeoutMs: inv.timeoutMs,
          input: inv.input,
        });
        const { rcaData, cost, sessionId } = inv.extractRca(stdout);

        if (rcaData) {
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
          for (const key of Object.keys(rcaData)) {
            if (!ALLOWED_KEYS.has(key)) delete rcaData[key];
          }
          for (const f of ['title', 'symptom', 'root_cause', 'fix', 'impact']) {
            if (rcaData[f] && typeof rcaData[f] !== 'string') {
              rcaData[f] = Array.isArray(rcaData[f]) ? rcaData[f].join('. ') : String(rcaData[f]);
            }
          }
          for (const f of ['files', 'tags', 'references']) {
            if (rcaData[f] && !Array.isArray(rcaData[f])) {
              rcaData[f] = typeof rcaData[f] === 'string' ? [rcaData[f]] : [];
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
          if (
            !rcaData.confidence ||
            !['high', 'medium', 'low', 'unknown'].includes(rcaData.confidence)
          ) {
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
          // Optional new fields: fill silently with defaults (not tracked in autoFilled)
          if (!Array.isArray(rcaData.code_changes)) {
            rcaData.code_changes = [];
          }
          if (typeof rcaData.description !== 'string') {
            rcaData.description = '';
          }
          if (!Array.isArray(rcaData.components)) {
            rcaData.components = [];
          }

          const result = validateRca(rcaData);
          if (!result.valid) {
            throw new RcaError('SCHEMA_VALIDATION', {
              ajv_first_error: result.errors[0],
            });
          }

          return {
            rca: result.data,
            cost,
            sessionId,
            autoFilled,
          };
        }
      } catch (err) {
        lastError = err;
        if (err.code === 'SECRET_SCANNER_UNAVAILABLE' || err.code === 'SECRET_SCAN_FAILED') {
          throw err;
        }
        if (err.code === 'SCHEMA_VALIDATION' && attempt < inv.maxRetries) {
          continue;
        }
        if (err.code === 'SCHEMA_VALIDATION') throw err;
        throw new RcaError('CLAUDE_FAILURE', {
          exitCode: err.exitCode || err.code || 'unknown',
          stderr_first_line: (err.stderr || err.message || '').split('\n')[0],
        });
      }
    }
    throw lastError;
  } finally {
    try {
      inv?.cleanup?.();
    } catch {
      /* cleanup */
    }
  }
}

export async function generate({
  context,
  config,
  systemPromptPath,
  schemaPath,
  correctionHint,
  priorRcas,
  _scanFn,
  _runFn,
}) {
  let workspaceDir;

  try {
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

    workspaceDir = mkdtempSync(join(tmpdir(), 'codex-rca-provider-'));

    const runOpts = {
      config,
      context,
      schema,
      payload,
      workspaceDir,
      scanFn: _scanFn || scanProviderPayload,
      runFn: _runFn || run,
    };

    // Run the configured provider. On a non-schema failure of the default
    // (claude) provider, fall back to codex when it is explicitly configured —
    // the "Claude unavailable → Codex" resilience feature. We gate on
    // `config.codex` (which has no schema defaults, so it is only present when
    // the user opts in); `config.claude` is always defaulted, so we never
    // auto-fall-back the other direction onto the real claude binary.
    const primaryName = config.provider || 'claude';
    try {
      return await runProviderGenerate(primaryName, runOpts);
    } catch (primaryErr) {
      if (
        primaryErr.code === 'SCHEMA_VALIDATION' ||
        primaryErr.code === 'SECRET_SCANNER_UNAVAILABLE' ||
        primaryErr.code === 'SECRET_SCAN_FAILED'
      ) {
        throw primaryErr;
      }
      if (primaryName === 'claude' && config.codex) {
        process.stderr.write('WARN: claude generation failed; falling back to codex.\n');
        return await runProviderGenerate('codex', runOpts);
      }
      throw primaryErr;
    }
  } finally {
    if (workspaceDir !== undefined) {
      try {
        rmSync(workspaceDir, { recursive: true, force: true });
      } catch {
        /* cleanup */
      }
    }
  }
}
