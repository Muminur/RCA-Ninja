import { RcaError } from '../errors.mjs';
import { buildProviderEnv } from './shared.mjs';

export const name = 'claude';
export const defaultBinary = 'claude';

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

function claudeBaseArgs() {
  return [
    '--bare',
    '--safe-mode',
    '--tools',
    '',
    '--no-session-persistence',
    '-p',
    '--output-format',
    'json',
  ];
}

export function buildGenerateInvocation({ config, payload, schemaStr, workspaceDir }) {
  const c = config?.claude || {};
  const env = buildProviderEnv(name, process.env, workspaceDir);
  const prompt =
    'Produce a Root Cause Analysis as one JSON object conforming to the supplied schema. ' +
    `Use only this inline input:\n${payload}`;
  const argv = claudeBaseArgs();
  argv.push('--json-schema', schemaStr);

  return {
    cmd: defaultBinary,
    argv,
    cwd: workspaceDir,
    env,
    input: prompt,
    timeoutMs: c.timeout_ms || 60000,
    maxRetries: c.max_retries ?? 1,
    extractRca,
    cleanup: () => {},
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
  const c = config?.claude || {};
  const env = buildProviderEnv(name, process.env, workspaceDir);
  const prompt =
    'Analyze the RCA and return one JSON object with verdict and findings. ' +
    `Use only this inline input:\n${payload}`;
  const argv = claudeBaseArgs();
  argv.push('--json-schema', JSON.stringify(VERDICT_SCHEMA));

  return {
    cmd: defaultBinary,
    argv,
    cwd: workspaceDir,
    env,
    input: prompt,
    timeoutMs: c.timeout_ms || 60000,
    extractVerdict: (stdout) => {
      const parsed = JSON.parse(stdout);
      const output = parsed?.structured_output || parsed;
      return { verdict: output?.verdict, findings: output?.findings || '' };
    },
    cleanup: () => {},
  };
}
