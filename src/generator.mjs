import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { run } from './util/exec.mjs';
import { validateRca } from './schema.mjs';
import { RcaError } from './errors.mjs';

const SECRET_REGEX = /(api[_-]?key|secret|password|token)\s*[:=]\s*["']?[A-Za-z0-9+/=]{16,}/i;

export function scanForSecrets(diff) {
  return SECRET_REGEX.test(diff);
}

export async function generate({ context, config, systemPromptPath, schemaPath }) {
  const contextFile = join(tmpdir(), `claude-rca-ctx-${randomUUID()}.json`);
  const diffFile = join(tmpdir(), `claude-rca-diff-${randomUUID()}.txt`);

  try {
    writeFileSync(
      contextFile,
      JSON.stringify({
        ref: context.short_hash,
        branch: context.branch,
        commit_message: context.commit_message,
        files_changed: context.files_changed,
        diff_path: diffFile,
        logs: context.logs,
      }),
    );
    writeFileSync(diffFile, context.diff);

    const systemPrompt = readFileSync(systemPromptPath, 'utf8');
    const schema = readFileSync(schemaPath, 'utf8');

    const binaryRaw = config.claude?.binary || 'claude';
    const binaryParts = binaryRaw.split(/\s+/);
    const cmd = binaryParts[0];
    const cmdPrefix = binaryParts.slice(1);
    const useBare = config.claude?.use_bare !== false;
    const permissionMode = config.claude?.permission_mode || 'plan';
    const allowedTools = config.claude?.allowed_tools || 'Read';
    const timeoutMs = config.claude?.timeout_ms || 60000;
    const maxRetries = config.claude?.max_retries ?? 1;

    const argv = [...cmdPrefix];
    if (useBare) argv.push('--bare');
    argv.push('-p', `Read ${contextFile} and ${diffFile} and produce an RCA.`);
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
        const rcaData = parsed.structured_output;

        const result = validateRca(rcaData);
        if (!result.valid) {
          throw new RcaError('SCHEMA_VALIDATION', {
            ajv_first_error: result.errors[0],
          });
        }

        return { rca: result.data, cost: parsed.total_cost_usd, sessionId: parsed.session_id };
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
