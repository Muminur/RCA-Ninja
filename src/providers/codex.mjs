// OpenAI Codex CLI adapter.
//
// Encapsulates everything specific to `codex exec` headless generation. The
// flag mapping was verified against codex-cli 0.141.0:
//
//   codex exec --sandbox read-only --skip-git-repo-check \
//     --output-schema <schemaFile> -o <outFile> "<prompt>"
//
// Two deliberate design choices for portability and correctness:
//
//  1. Context is INLINED into the prompt rather than referenced as temp file
//     paths. Codex's read-only sandbox (Landlock on Linux, Seatbelt on macOS)
//     may forbid reading files outside the workspace root, so "Read <tmpfile>"
//     is not portable. Inlining removes the dependency on the model's file-read
//     tool entirely.
//  2. The schema passed to `--output-schema` is converted to OpenAI strict
//     structured-output form (see toStrictSchema). The REAL validation still
//     happens locally via AJV against the original schema after the model
//     responds, so local enforcement is unchanged.
//
// Codex writes its final message to the `-o/--output-last-message` file on
// success; the adapter reads and parses that file.

import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { RcaError } from '../errors.mjs';
import { resolveBinary, toStrictSchema } from './shared.mjs';

export const name = 'codex';

/** Default binary name when `config.codex.binary` is unset. */
export const defaultBinary = 'codex';

function buildContextBlock({ context, priorRcas }) {
  return {
    ref: context.short_hash,
    branch: context.branch,
    commit_message: context.commit_message,
    files_changed: context.files_changed,
    logs: context.logs,
    ...(priorRcas && priorRcas.length > 0 ? { prior_rcas: priorRcas } : {}),
  };
}

function buildGeneratePrompt({ systemPrompt, context, priorRcas, correctionHint }) {
  const block = buildContextBlock({ context, priorRcas });
  let prompt = systemPrompt.trim();
  prompt +=
    '\n\n## Task\nProduce a Root Cause Analysis for the bug fix below as a single JSON object' +
    ' conforming to the provided output schema. Respond with ONLY the JSON object — no prose,' +
    ' no markdown fences.';
  prompt += `\n\n## Commit context\n${JSON.stringify(block, null, 2)}`;
  prompt += `\n\n## Diff\n\`\`\`diff\n${context.diff}\n\`\`\``;
  if (correctionHint) prompt += `\n\n## Correction hint\n${correctionHint}`;
  return prompt;
}

/**
 * Parse a JSON object out of Codex's final message. Tolerant of a raw object, a
 * ```json fenced block, or surrounding prose.
 */
export function extractJsonObject(text) {
  const trimmed = (text || '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    throw new RcaError('SCHEMA_VALIDATION', {
      ajv_first_error: 'Could not parse RCA JSON from codex output',
    });
  }
}

function writeStrictSchema(schemaStr) {
  const schemaFile = join(tmpdir(), `claude-rca-codex-schema-${randomUUID()}.json`);
  writeFileSync(schemaFile, JSON.stringify(toStrictSchema(JSON.parse(schemaStr))));
  return schemaFile;
}

function codexBaseArgs(cmdPrefix, c) {
  const argv = [...cmdPrefix, 'exec'];
  argv.push('--sandbox', c.sandbox || 'read-only');
  argv.push('--skip-git-repo-check');
  if (c.model) argv.push('--model', c.model);
  return argv;
}

/**
 * Build a generation invocation for the Codex CLI. Same interface as the Claude
 * adapter; see src/providers/claude.mjs.
 */
export function buildGenerateInvocation({
  config,
  systemPrompt,
  schemaStr,
  correctionHint,
  context,
  priorRcas,
}) {
  const c = config.codex || {};
  const { cmd, cmdPrefix } = resolveBinary(c.binary, defaultBinary);

  const outFile = join(tmpdir(), `claude-rca-codex-out-${randomUUID()}.json`);
  const schemaFile = writeStrictSchema(schemaStr);
  const prompt = buildGeneratePrompt({ systemPrompt, context, priorRcas, correctionHint });

  // Codex reads the prompt from stdin when no positional PROMPT arg is given.
  // We use stdin (not argv) so large diffs never hit the OS arg-length limit.
  const argv = codexBaseArgs(cmdPrefix, c);
  argv.push('--output-schema', schemaFile);
  argv.push('-o', outFile);

  return {
    cmd,
    argv,
    input: prompt,
    timeoutMs: c.timeout_ms || 120000,
    maxRetries: c.max_retries ?? 1,
    extractRca: () => {
      // A missing output file (codex exited 0 but wrote no final message)
      // surfaces as a native fs error here; the generator maps any non-schema
      // error to CLAUDE_FAILURE (exit 21).
      const body = readFileSync(outFile, 'utf8');
      return { rcaData: extractJsonObject(body), cost: undefined, sessionId: undefined };
    },
    cleanup: () => {
      try {
        unlinkSync(outFile);
      } catch {
        /* cleanup */
      }
      try {
        unlinkSync(schemaFile);
      } catch {
        /* cleanup */
      }
    },
  };
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['PUBLISH', 'REVISE', 'REJECT'] },
    findings: { type: 'string' },
  },
};

/**
 * Build an analyst invocation for the Codex CLI. The RCA file content is inlined
 * into the prompt (same sandbox-portability rationale as generation).
 *
 * @param {{ config: object, systemPrompt: string, writtenPath: string }} opts
 */
export function buildAnalystInvocation({ config, systemPrompt, writtenPath }) {
  const c = config?.codex || {};
  const { cmd, cmdPrefix } = resolveBinary(c.binary, defaultBinary);

  const outFile = join(tmpdir(), `claude-rca-codex-analyst-${randomUUID()}.json`);
  const schemaFile = join(tmpdir(), `claude-rca-codex-analyst-schema-${randomUUID()}.json`);
  writeFileSync(schemaFile, JSON.stringify(VERDICT_SCHEMA));

  let rcaContent = '';
  try {
    rcaContent = readFileSync(writtenPath, 'utf8');
  } catch {
    /* the path is also named in the prompt as a fallback */
  }

  let prompt = systemPrompt.trim();
  prompt +=
    '\n\n## Task\nAnalyze the RCA document below and return a JSON object' +
    ' { "verdict": "PUBLISH"|"REVISE"|"REJECT", "findings": string } conforming to the output' +
    ' schema. Respond with ONLY the JSON object.';
  prompt += `\n\n## RCA file path\n${writtenPath}`;
  prompt += `\n\n## RCA content\n${rcaContent}`;

  const argv = codexBaseArgs(cmdPrefix, c);
  argv.push('--output-schema', schemaFile);
  argv.push('-o', outFile);

  return {
    cmd,
    argv,
    input: prompt,
    timeoutMs: c?.timeout_ms || 120000,
    extractVerdict: () => {
      const body = readFileSync(outFile, 'utf8');
      const output = extractJsonObject(body);
      return { verdict: output?.verdict, findings: output?.findings || '' };
    },
    cleanup: () => {
      try {
        unlinkSync(outFile);
      } catch {
        /* cleanup */
      }
      try {
        unlinkSync(schemaFile);
      } catch {
        /* cleanup */
      }
    },
  };
}
