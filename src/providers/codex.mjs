import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RcaError } from '../errors.mjs';
import { buildProviderEnv, toStrictSchema } from './shared.mjs';

export const name = 'codex';
export const defaultBinary = 'codex';

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

function writeSchema(workspaceDir, prefix, schema) {
  const schemaFile = join(workspaceDir, `${prefix}-${randomUUID()}.json`);
  writeFileSync(schemaFile, JSON.stringify(schema));
  return schemaFile;
}

function codexBaseArgs(config, workspaceDir) {
  const argv = [
    'exec',
    '--sandbox',
    'read-only',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '--strict-config',
    '--config',
    'agents.enabled=false',
    '--skip-git-repo-check',
    '--cd',
    workspaceDir,
  ];
  if (config.model) argv.push('--model', config.model);
  return argv;
}

function cleanupFiles(paths) {
  for (const path of paths) {
    try {
      unlinkSync(path);
    } catch {
      /* provider workspace cleanup is the final fallback */
    }
  }
}

export function buildGenerateInvocation({ config, payload, schemaStr, workspaceDir }) {
  const c = config?.codex || {};
  const env = buildProviderEnv(name, process.env, workspaceDir);
  const outFile = join(workspaceDir, `codex-rca-output-${randomUUID()}.json`);
  const schemaFile = writeSchema(
    workspaceDir,
    'codex-rca-schema',
    toStrictSchema(JSON.parse(schemaStr)),
  );
  const argv = codexBaseArgs(c, workspaceDir);
  argv.push('--output-schema', schemaFile, '-o', outFile);

  return {
    cmd: defaultBinary,
    argv,
    cwd: workspaceDir,
    env,
    input:
      'Produce a Root Cause Analysis as one JSON object conforming to the output schema. ' +
      `Use only this inline input:\n${payload}`,
    timeoutMs: c.timeout_ms || 120000,
    maxRetries: c.max_retries ?? 1,
    extractRca: () => {
      const body = readFileSync(outFile, 'utf8');
      return {
        rcaData: extractJsonObject(body),
        cost: undefined,
        sessionId: undefined,
      };
    },
    cleanup: () => cleanupFiles([outFile, schemaFile]),
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

export function buildAnalystInvocation({ config, payload, workspaceDir }) {
  const c = config?.codex || {};
  const env = buildProviderEnv(name, process.env, workspaceDir);
  const outFile = join(workspaceDir, `codex-analyst-output-${randomUUID()}.json`);
  const schemaFile = writeSchema(workspaceDir, 'codex-analyst-schema', VERDICT_SCHEMA);
  const argv = codexBaseArgs(c, workspaceDir);
  argv.push('--output-schema', schemaFile, '-o', outFile);

  return {
    cmd: defaultBinary,
    argv,
    cwd: workspaceDir,
    env,
    input:
      'Analyze the RCA and return one JSON object with verdict and findings. ' +
      `Use only this inline input:\n${payload}`,
    timeoutMs: c.timeout_ms || 120000,
    extractVerdict: () => {
      const output = extractJsonObject(readFileSync(outFile, 'utf8'));
      return { verdict: output?.verdict, findings: output?.findings || '' };
    },
    cleanup: () => cleanupFiles([outFile, schemaFile]),
  };
}
