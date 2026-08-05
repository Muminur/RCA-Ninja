import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import matter from 'gray-matter';
import { RcaError } from './errors.mjs';
import { getProvider } from './providers/index.mjs';
import { scanProviderPayload } from './secret-scan.mjs';

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
 *   _scanFn?: (opts: {payload: string}) => Promise<void>,
 *   _spawnFn?: (cmd: string, argv: string[], opts: object) => Promise<{stdout: string}>
 * }} opts
 * @returns {Promise<{ verdict: 'PUBLISH'|'REVISE'|'REJECT', findings: string }>}
 */
export async function runAnalyst({ writtenPath, systemPromptPath, config, _scanFn, _spawnFn }) {
  let systemPromptRaw;
  let documentContent;
  try {
    systemPromptRaw = readFileSync(systemPromptPath, 'utf8');
    documentContent = readFileSync(writtenPath, 'utf8');
  } catch {
    throw new RcaError('DISK_ERROR', {
      op: 'reading analyst input',
      errno: 'unavailable',
    });
  }
  const systemPrompt = stripFrontmatter(systemPromptRaw);
  const payload = JSON.stringify({ systemPrompt, documentContent });

  if (typeof _spawnFn !== 'function') {
    throw new RcaError('PROVIDER_ISOLATION_UNAVAILABLE');
  }

  const workspaceDir = mkdtempSync(join(tmpdir(), 'codex-rca-provider-'));

  const spawnFn = _spawnFn;
  const scanFn = _scanFn || scanProviderPayload;
  let inv;

  try {
    const provider = getProvider(config?.provider);
    inv = provider.buildAnalystInvocation({ config, payload, workspaceDir });
    let stdout;
    await scanFn({ payload });
    try {
      const result = await spawnFn(inv.cmd, inv.argv, {
        cwd: inv.cwd,
        env: inv.env,
        timeoutMs: inv.timeoutMs,
        input: inv.input,
      });
      stdout = result.stdout;
    } catch {
      throw new RcaError('CLAUDE_FAILURE', {
        exitCode: 'unavailable',
        stderr_first_line: 'provider execution failed',
      });
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
    inv?.cleanup?.();
    try {
      rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      /* cleanup */
    }
  }
}
