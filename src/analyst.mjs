import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import matter from 'gray-matter';
import { RcaError } from './errors.mjs';
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
 * @param {{
 *   writtenPath: string,
 *   systemPromptPath: string,
 *   config: object,
 *   cwd?: string
 * }} opts
 * @returns {Promise<{ verdict: 'PUBLISH'|'REVISE'|'REJECT', findings: string }>}
 */
export async function runAnalyst({ writtenPath, systemPromptPath, config: _config, cwd }) {
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
  throw new RcaError('PROVIDER_ISOLATION_UNAVAILABLE');
}
