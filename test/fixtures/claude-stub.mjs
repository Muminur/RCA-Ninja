#!/usr/bin/env node

import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);
const logPath = process.env.CLAUDE_STUB_LOG || join(tmpdir(), 'claude-stub.log');
writeFileSync(logPath, JSON.stringify({ argv: args, cwd: process.cwd() }) + '\n', { flag: 'a' });

if (process.env.CLAUDE_STUB_EXIT) {
  process.exit(parseInt(process.env.CLAUDE_STUB_EXIT, 10));
}

if (process.env.CLAUDE_STUB_INVALID) {
  process.stdout.write(
    JSON.stringify({
      result: 'invalid output',
      structured_output: { bad: 'data' },
      duration_ms: 100,
      total_cost_usd: 0.001,
      session_id: 'stub-invalid',
    }) + '\n',
  );
  process.exit(0);
}

const canonical = {
  title: 'Session middleware null-pointers when cookie domain mismatch occurs',
  symptom:
    'Requests intermittently returned 500 with TypeError Cannot read properties of undefined reading id when users hit /api/me.',
  root_cause:
    'The session loader returned undefined when the cookie domain mismatched the request host and the auth middleware proceeded to dereference req.session.user.id without a null check.',
  fix: 'auth.js now treats req.session === undefined as unauthenticated and short-circuits to 401. session.js was also updated to log a warning when the cookie domain check fails.',
  impact:
    'All endpoints behind requireAuth. User-visible: brief 500s on /api/me, /api/orders, /api/notifications. No data loss.',
  files: ['file1.js'],
  tags: ['rca', 'bugfix'],
  references: [],
  confidence: 'high',
};

const output = process.env.CLAUDE_STUB_OUTPUT
  ? JSON.parse(readFileSync(process.env.CLAUDE_STUB_OUTPUT, 'utf8'))
  : canonical;

process.stdout.write(
  JSON.stringify({
    result: 'RCA generated',
    structured_output: output,
    duration_ms: 500,
    total_cost_usd: 0.01,
    session_id: 'stub-session-001',
  }) + '\n',
);
