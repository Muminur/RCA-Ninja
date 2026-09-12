import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import matter from 'gray-matter';
import { RcaError } from './errors.mjs';
import { scanProviderPayload } from './secret-scan.mjs';
import { getProvider, SUPPORTED_PROVIDERS } from './providers/index.mjs';
import {
  withProviderWorkspace,
  runProviderInvocation,
  classifyProviderFailure,
  UNUSABLE_REASONS,
} from './provider-run.mjs';

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
 *   cwd?: string
 * }} opts
 * @returns {Promise<{ verdict: 'PUBLISH'|'REVISE'|'REJECT', findings: string }>}
 */
export async function runAnalyst({ writtenPath, systemPromptPath, config, cwd }) {
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
  const rootCandidate = cwd ?? dirname(writtenPath);
  const workspaceRoot = typeof rootCandidate === 'string' ? resolve(rootCandidate) : rootCandidate;

  await scanProviderPayload({ payload, workspaceRoot });

  const primary = config?.provider || 'claude';
  const order = [primary, ...SUPPORTED_PROVIDERS.filter((p) => p !== primary)];
  const unusable = [];

  for (const providerName of order) {
    const provider = getProvider(providerName);
    const verdict = await withProviderWorkspace(async (workspaceDir) => {
      const inv = provider.buildAnalystInvocation({ config, payload, workspaceDir });
      try {
        const outcome = await runProviderInvocation(inv);
        try {
          const parsed = inv.extractVerdict(outcome.stdout);
          if (parsed?.verdict) return parsed;
        } catch {
          /* fall through to classification */
        }
        const reason = classifyProviderFailure(outcome);
        if (reason) {
          unusable.push(`${providerName} (${UNUSABLE_REASONS[reason]})`);
          return null;
        }
        throw new RcaError('SCHEMA_VALIDATION', {
          ajv_first_error: `${providerName} returned no analyst verdict`,
        });
      } finally {
        try {
          inv?.cleanup?.();
        } catch {
          /* the workspace is removed either way */
        }
      }
    });
    if (verdict) return verdict;
  }

  throw new RcaError('PROVIDER_UNAVAILABLE', { providers: unusable.join(', ') });
}
