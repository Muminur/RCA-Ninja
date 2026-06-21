#!/usr/bin/env node

// Faithful stub of `codex exec` for tests and the autoresearch harness.
//
// Models the REAL codex CLI contract verified against codex-cli 0.141.0:
//   codex exec [-s read-only] [--skip-git-repo-check] \
//     --output-schema <schemaFile> -o <outFile> "<prompt>"
//
// Real codex writes the agent's FINAL message to the file given by
// `-o/--output-last-message` (only on success) and streams a human/JSONL event
// log to stdout. This stub reproduces that shape: it writes the RCA (or analyst
// verdict) JSON to the `-o` file and prints a short event log to stdout.
//
// Env knobs mirror claude-stub.mjs so the same test matrix applies to codex:
//   CODEX_STUB_LOG     append the parsed argv (JSON) to this path
//   CODEX_STUB_EXIT    exit with this code without producing output
//   CODEX_STUB_INVALID emit a JSON object that fails RCA schema validation
//   CODEX_STUB_ANALYST force analyst-verdict output
//   CODEX_STUB_OUTPUT  path to a JSON file whose contents become the RCA body

import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);

const logPath = process.env.CODEX_STUB_LOG || join(tmpdir(), 'codex-stub.log');
writeFileSync(logPath, JSON.stringify({ argv: args, cwd: process.cwd() }) + '\n', { flag: 'a' });

// Resolve the --output-last-message / -o target the adapter passed.
function flagValue(names) {
  for (const name of names) {
    const i = args.indexOf(name);
    if (i !== -1 && i + 1 < args.length) return args[i + 1];
  }
  return null;
}
const outFile = flagValue(['-o', '--output-last-message']);
const schemaFile = flagValue(['--output-schema']);

function emit(obj) {
  const body = JSON.stringify(obj);
  // codex writes the final message to the -o file when present; otherwise stdout.
  if (outFile) {
    writeFileSync(outFile, body);
  } else {
    process.stdout.write(body + '\n');
  }
  // Event log to stdout (codex streams a header + events; tests parse the -o file).
  process.stdout.write('OpenAI Codex (stub)\n');
  process.stdout.write(`workdir: ${process.cwd()}\n`);
  if (schemaFile) process.stdout.write(`output-schema: ${schemaFile}\n`);
  process.stdout.write('tokens used: 1234\n');
}

function proceed() {
  if (process.env.CODEX_STUB_EXIT) {
    process.exit(parseInt(process.env.CODEX_STUB_EXIT, 10));
  }

  if (process.env.CODEX_STUB_INVALID) {
    emit({ bad: 'data' });
    process.exit(0);
  }

  // Analyst mode is determined by the --output-schema shape (a `verdict`
  // property), mirroring how real codex behaves. We must NOT sniff the prompt
  // text for "rca-analyst": the codex adapter sends the diff via stdin, and a
  // diff can legitimately mention analyst code without being an analyst run.
  let isAnalyst = Boolean(process.env.CODEX_STUB_ANALYST);
  if (!isAnalyst && schemaFile) {
    try {
      const sch = JSON.parse(readFileSync(schemaFile, 'utf8'));
      if (sch && sch.properties && sch.properties.verdict) isAnalyst = true;
    } catch {
      /* ignore unreadable schema */
    }
  }
  if (isAnalyst) {
    emit({ verdict: 'PUBLISH', findings: 'All quality criteria met.' });
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

  const output = process.env.CODEX_STUB_OUTPUT
    ? JSON.parse(readFileSync(process.env.CODEX_STUB_OUTPUT, 'utf8'))
    : canonical;

  emit(output);
  process.exit(0);
}

// Real codex consumes the prompt from stdin. Drain it to EOF before emitting so
// a large piped prompt cannot block the parent writer, then proceed.
if (process.stdin.isTTY) {
  proceed();
} else {
  let started = false;
  const go = () => {
    if (!started) {
      started = true;
      proceed();
    }
  };
  process.stdin.on('data', () => {});
  process.stdin.on('end', go);
  process.stdin.on('error', go);
  process.stdin.resume();
}
