import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { run } from './util/exec.mjs';
import { validateRca } from './schema.mjs';
import { RcaError } from './errors.mjs';
import { estimatePayload, TOKEN_WARN_THRESHOLD, TOKEN_HARD_LIMIT } from './token-estimate.mjs';

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

export async function generate({
  context,
  config,
  systemPromptPath,
  schemaPath,
  correctionHint,
  priorRcas,
}) {
  const contextFile = join(tmpdir(), `claude-rca-ctx-${randomUUID()}.json`);
  const diffFile = join(tmpdir(), `claude-rca-diff-${randomUUID()}.txt`);

  try {
    writeFileSync(
      contextFile,
      JSON.stringify(buildContextPayload({ context, priorRcas, diffFile })),
    );
    writeFileSync(diffFile, context.diff);

    const systemPrompt = readFileSync(systemPromptPath, 'utf8');
    const schema = readFileSync(schemaPath, 'utf8');

    const systemPromptStr = systemPrompt;
    const schemaStr = schema;
    const contextJsonStr = JSON.stringify(buildContextPayload({ context, priorRcas, diffFile }));
    const estimate = estimatePayload({
      systemPrompt: systemPromptStr,
      schema: schemaStr,
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

    const binaryRaw = config.claude?.binary || 'claude';
    const binaryParts = binaryRaw.split(/\s+/);
    const cmd = binaryParts[0];
    const cmdPrefix = binaryParts.slice(1);
    const permissionMode = config.claude?.permission_mode || 'plan';
    const allowedTools = config.claude?.allowed_tools || 'Read';
    const timeoutMs = config.claude?.timeout_ms || 60000;
    const maxRetries = config.claude?.max_retries ?? 1;

    const argv = [...cmdPrefix];
    let prompt = `Read ${contextFile} and ${diffFile} and produce an RCA.`;
    if (correctionHint) prompt += `\n\nCorrection hint: ${correctionHint}`;
    argv.push('-p', prompt);
    argv.push('--append-system-prompt', systemPrompt);
    argv.push('--output-format', 'json');
    argv.push('--json-schema', schema);
    argv.push('--allowedTools', allowedTools);
    argv.push('--permission-mode', permissionMode);

    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const { stdout } = await run(cmd, argv, { timeoutMs });
        const parsed = JSON.parse(stdout);
        let rcaData = parsed.structured_output;

        if (!rcaData && parsed.result) {
          const jsonMatch = parsed.result.match(/```json\s*([\s\S]*?)```/);
          const raw = jsonMatch ? jsonMatch[1].trim() : parsed.result.trim();
          try {
            rcaData = JSON.parse(raw);
          } catch (parseErr) {
            throw new RcaError('SCHEMA_VALIDATION', {
              ajv_first_error: `Could not parse RCA JSON from claude output: ${parseErr.message}`,
            });
          }
        }

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
            cost: parsed.total_cost_usd,
            sessionId: parsed.session_id,
            autoFilled,
          };
        }
      } catch (err) {
        lastError = err;
        if (err.code === 'SCHEMA_VALIDATION' && attempt < maxRetries) {
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
      unlinkSync(contextFile);
    } catch {
      /* cleanup */
    }
    try {
      unlinkSync(diffFile);
    } catch {
      /* cleanup */
    }
  }
}
