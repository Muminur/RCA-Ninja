import { readFileSync } from 'node:fs';
import matter from 'gray-matter';
import { run } from './util/exec.mjs';
import { RcaError } from './errors.mjs';

function stripFrontmatter(content) {
  try {
    const { content: body } = matter(content);
    return body.trim();
  } catch {
    return content;
  }
}

/**
 * Run the rca-analyst subagent against a written RCA file.
 *
 * @param {{
 *   writtenPath: string,
 *   systemPromptPath: string,
 *   config: object,
 *   _spawnFn?: (cmd: string, argv: string[], opts: object) => Promise<{stdout: string}>
 * }} opts
 * @returns {Promise<{ verdict: 'PUBLISH'|'REVISE'|'REJECT', findings: string }>}
 */
export async function runAnalyst({ writtenPath, systemPromptPath, config, _spawnFn }) {
  const systemPromptRaw = readFileSync(systemPromptPath, 'utf8');
  const systemPrompt = stripFrontmatter(systemPromptRaw);

  const timeoutMs = config?.claude?.timeout_ms || 60000;
  const binaryRaw = config?.claude?.binary || 'claude';
  const binaryParts = binaryRaw.split(/\s+/);
  const cmd = binaryParts[0];
  const cmdPrefix = binaryParts.slice(1);

  const argv = [...cmdPrefix];
  argv.push('-p', `Analyze this RCA file and provide a quality verdict: ${writtenPath}`);
  argv.push('--append-system-prompt', systemPrompt);
  argv.push('--output-format', 'json');
  argv.push('--allowedTools', 'Read');
  argv.push('--permission-mode', 'plan');

  const spawnFn = _spawnFn || ((c, a, o) => run(c, a, o));

  let stdout;
  try {
    const result = await spawnFn(cmd, argv, { timeoutMs });
    stdout = result.stdout;
  } catch (err) {
    throw new RcaError('CLAUDE_FAILURE', { detail: err.message });
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new RcaError('SCHEMA_VALIDATION', {
      ajv_first_error: 'analyst output was not valid JSON',
    });
  }

  const output = parsed?.structured_output || parsed;
  const verdict = output?.verdict;
  const findings = output?.findings || '';

  if (!['PUBLISH', 'REVISE', 'REJECT'].includes(verdict)) {
    throw new RcaError('SCHEMA_VALIDATION', {
      ajv_first_error: `analyst returned unexpected verdict: ${verdict}`,
    });
  }

  return { verdict, findings };
}
