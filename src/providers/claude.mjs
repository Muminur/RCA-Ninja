// Claude Code CLI adapter.
//
// Encapsulates everything specific to `claude -p` headless generation: the
// command-line flags (`--append-system-prompt`, `--json-schema`,
// `--allowedTools`, `--permission-mode`, `--output-format json`) and the shape
// of Claude's JSON stdout (`structured_output` / `result`, `total_cost_usd`,
// `session_id`). The generator stays agnostic and only consumes the interface
// below.

import { RcaError } from '../errors.mjs';
import { resolveBinary } from './shared.mjs';

export const name = 'claude';

/** Default binary name when `config.claude.binary` is unset. */
export const defaultBinary = 'claude';

/**
 * Parse Claude's JSON stdout into `{ rcaData, cost, sessionId }`.
 *
 * Mirrors the historical behavior exactly:
 *  - prefers `structured_output`
 *  - falls back to a ```json fenced block (or raw) inside `result`
 *  - a `result` body that is not parseable JSON is a SCHEMA_VALIDATION error
 *  - malformed top-level stdout throws SyntaxError (the generator maps that to
 *    CLAUDE_FAILURE, exit 21)
 */
function extractRca(stdout) {
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

  return { rcaData, cost: parsed.total_cost_usd, sessionId: parsed.session_id };
}

/**
 * Build a generation invocation for the Claude CLI.
 *
 * @param {{
 *   config: object,
 *   contextFile: string,
 *   diffFile: string,
 *   systemPrompt: string,
 *   schemaStr: string,
 *   correctionHint?: string,
 * }} opts
 * @returns {{ cmd: string, argv: string[], timeoutMs: number, maxRetries: number,
 *            extractRca: (stdout: string) => object, cleanup: () => void }}
 */
export function buildGenerateInvocation({ config, contextFile, diffFile, systemPrompt, schemaStr, correctionHint }) {
  const c = config.claude || {};
  const { cmd, cmdPrefix } = resolveBinary(c.binary, defaultBinary);
  const permissionMode = c.permission_mode || 'plan';
  const allowedTools = c.allowed_tools || 'Read';

  const argv = [...cmdPrefix];
  let prompt = `Read ${contextFile} and ${diffFile} and produce an RCA.`;
  if (correctionHint) prompt += `\n\nCorrection hint: ${correctionHint}`;
  argv.push('-p', prompt);
  argv.push('--append-system-prompt', systemPrompt);
  argv.push('--output-format', 'json');
  argv.push('--json-schema', schemaStr);
  argv.push('--allowedTools', allowedTools);
  argv.push('--permission-mode', permissionMode);

  return {
    cmd,
    argv,
    timeoutMs: c.timeout_ms || 60000,
    maxRetries: c.max_retries ?? 1,
    extractRca,
    cleanup: () => {},
  };
}

/**
 * Build an analyst invocation for the Claude CLI (quality verdict on a written
 * RCA file). Returns the same interface as buildGenerateInvocation, but
 * extractVerdict parses the analyst's `{ verdict, findings }` output.
 *
 * @param {{ config: object, systemPrompt: string, writtenPath: string }} opts
 */
export function buildAnalystInvocation({ config, systemPrompt, writtenPath }) {
  const c = config?.claude || {};
  const { cmd, cmdPrefix } = resolveBinary(c.binary, defaultBinary);

  const argv = [...cmdPrefix];
  argv.push('-p', `Analyze this RCA file and provide a quality verdict: ${writtenPath}`);
  argv.push('--append-system-prompt', systemPrompt);
  argv.push('--output-format', 'json');
  argv.push('--allowedTools', 'Read');
  argv.push('--permission-mode', 'plan');

  return {
    cmd,
    argv,
    timeoutMs: c?.timeout_ms || 60000,
    extractVerdict: (stdout) => {
      const parsed = JSON.parse(stdout);
      const output = parsed?.structured_output || parsed;
      return { verdict: output?.verdict, findings: output?.findings || '' };
    },
    cleanup: () => {},
  };
}
