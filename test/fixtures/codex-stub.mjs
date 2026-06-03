#!/usr/bin/env node

import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);
const logPath = process.env.CODEX_STUB_LOG || join(tmpdir(), 'codex-stub.log');
writeFileSync(logPath, JSON.stringify({ argv: args, cwd: process.cwd() }) + '\n', { flag: 'a' });

if (process.env.CODEX_STUB_EXIT) {
  process.exit(parseInt(process.env.CODEX_STUB_EXIT, 10));
}

if (process.env.CODEX_STUB_INVALID) {
  process.stdout.write('not-json\n');
  process.exit(0);
}

const canonical = {
  title: 'Fallback RCA generated when Claude is unavailable',
  symptom: 'RCA generation failed before writing a report when the Claude binary was missing.',
  root_cause:
    'The generator treated Claude process startup failure as terminal and had no Codex fallback.',
  fix: 'The generator now tries Claude first and automatically invokes Codex when Claude fails.',
  impact: 'Users with Codex installed can generate RCAs even if Claude is not installed.',
  files: ['file1.js'],
  tags: ['rca', 'bugfix'],
  references: [],
  confidence: 'high',
};

const output = process.env.CODEX_STUB_OUTPUT
  ? JSON.parse(readFileSync(process.env.CODEX_STUB_OUTPUT, 'utf8'))
  : canonical;

process.stdout.write(JSON.stringify(output) + '\n');
