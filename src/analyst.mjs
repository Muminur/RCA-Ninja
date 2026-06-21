import { readFileSync } from 'node:fs';
import matter from 'gray-matter';
import { run } from './util/exec.mjs';
import { RcaError } from './errors.mjs';
import { getProvider } from './providers/index.mjs';

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
 * Provider-agnostic: the active LLM adapter (config.provider, default "claude")
 * builds the invocation and parses the verdict. Works with `claude -p` and
 * `codex exec` alike.
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

  const provider = getProvider(config?.provider);
  const inv = provider.buildAnalystInvocation({ config, systemPrompt, writtenPath });

  const spawnFn = _spawnFn || ((c, a, o) => run(c, a, o));

  try {
    let stdout;
    try {
      const result = await spawnFn(inv.cmd, inv.argv, { timeoutMs: inv.timeoutMs, input: inv.input });
      stdout = result.stdout;
    } catch (err) {
      throw new RcaError('CLAUDE_FAILURE', { detail: err.message });
    }

    let verdict;
    let findings;
    try {
      ({ verdict, findings } = inv.extractVerdict(stdout));
    } catch (err) {
      if (err instanceof RcaError) throw err;
      throw new RcaError('SCHEMA_VALIDATION', {
        ajv_first_error: 'analyst output was not valid JSON',
      });
    }

    if (!['PUBLISH', 'REVISE', 'REJECT'].includes(verdict)) {
      throw new RcaError('SCHEMA_VALIDATION', {
        ajv_first_error: `analyst returned unexpected verdict: ${verdict}`,
      });
    }

    return { verdict, findings };
  } finally {
    inv.cleanup?.();
  }
}
