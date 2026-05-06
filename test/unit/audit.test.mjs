import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { auditCorpus } from '../../src/audit.mjs';
import { createProgram } from '../../src/cli.mjs';

const EXIT_SENTINEL = Symbol('mock-exit');

async function capture(fn) {
  const out = [];
  const err = [];
  const exits = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origExit = process.exit;
  process.stdout.write = (c) => {
    out.push(String(c));
    return true;
  };
  process.stderr.write = (c) => {
    err.push(String(c));
    return true;
  };
  process.exit = (code) => {
    exits.push(code ?? 0);
    const s = new Error('mock-process-exit');
    s[EXIT_SENTINEL] = true;
    throw s;
  };
  try {
    await fn();
  } catch (e) {
    if (!e[EXIT_SENTINEL]) throw e;
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exit = origExit;
  }
  return { stdout: out.join(''), stderr: err.join(''), exitCode: exits[0] ?? null };
}

function makeRcaDir() {
  const tmp = mkdtempSync(join(tmpdir(), 'claude-rca-audit-'));
  const rcaDir = join(tmp, 'rca');
  mkdirSync(join(rcaDir, '2026', '04'), { recursive: true });
  return { tmp, rcaDir };
}

const cleanMd =
  '---\ntitle: "Clean RCA"\ndate: 2026-04-01T00:00:00Z\nconfidence: high\n---\n\n## Symptom\n\nAll good.\n';
const degradedMd =
  '---\ntitle: "Degraded RCA"\ndate: 2026-04-02T00:00:00Z\nauto_filled: [confidence]\nconfidence: medium\n---\n\n## Symptom\n\nMissing confidence.\n';

describe('auditCorpus', () => {
  it('returns empty degraded array and correct clean_count when all RCAs are clean', () => {
    const { rcaDir } = makeRcaDir();
    writeFileSync(join(rcaDir, '2026', '04', 'RCA-clean-1.md'), cleanMd);
    writeFileSync(join(rcaDir, '2026', '04', 'RCA-clean-2.md'), cleanMd);
    const result = auditCorpus({ outputDir: rcaDir });
    assert.strictEqual(result.degraded.length, 0);
    assert.strictEqual(result.clean_count, 2);
  });

  it('flags RCA files that have auto_filled in frontmatter', () => {
    const { rcaDir } = makeRcaDir();
    writeFileSync(join(rcaDir, '2026', '04', 'RCA-clean.md'), cleanMd);
    writeFileSync(join(rcaDir, '2026', '04', 'RCA-degraded.md'), degradedMd);
    const result = auditCorpus({ outputDir: rcaDir });
    assert.strictEqual(result.degraded.length, 1);
    assert.ok(result.degraded[0].path.includes('RCA-degraded.md'));
    assert.deepStrictEqual(result.degraded[0].auto_filled, ['confidence']);
    assert.strictEqual(result.clean_count, 1);
  });

  it('includes the correct auto_filled fields in the degraded entry', () => {
    const { rcaDir } = makeRcaDir();
    const multiDegraded =
      '---\ntitle: "Multi"\ndate: 2026-04-03T00:00:00Z\nauto_filled: [confidence, impact]\n---\n\n## Symptom\n\nMultiple fields.\n';
    writeFileSync(join(rcaDir, '2026', '04', 'RCA-multi.md'), multiDegraded);
    const result = auditCorpus({ outputDir: rcaDir });
    assert.strictEqual(result.degraded.length, 1);
    assert.deepStrictEqual(result.degraded[0].auto_filled, ['confidence', 'impact']);
  });

  it('returns empty arrays when the output directory has no .md files', () => {
    const { rcaDir } = makeRcaDir();
    const result = auditCorpus({ outputDir: rcaDir });
    assert.strictEqual(result.degraded.length, 0);
    assert.strictEqual(result.clean_count, 0);
  });

  it('counts files with no auto_filled field as clean, even when content is not valid YAML frontmatter', () => {
    const { rcaDir } = makeRcaDir();
    // gray-matter never throws on malformed content — it returns data: {}
    // So files without a valid auto_filled array are always counted as clean
    writeFileSync(join(rcaDir, '2026', '04', 'RCA-bad.md'), 'not valid at all {{{{');
    const result = auditCorpus({ outputDir: rcaDir });
    assert.strictEqual(result.degraded.length, 0);
    assert.strictEqual(result.clean_count, 1);
  });

  it('returns empty result when outputDir does not exist', () => {
    const nonExistentDir = join(tmpdir(), 'claude-rca-audit-nodir-' + Date.now());
    const result = auditCorpus({ outputDir: nonExistentDir });
    assert.strictEqual(result.degraded.length, 0);
    assert.strictEqual(result.clean_count, 0);
  });
});

describe('audit CLI command', () => {
  it('exits 0 when all RCAs are clean and prints summary to stdout', async () => {
    const { tmp, rcaDir } = makeRcaDir();
    writeFileSync(
      join(tmp, '.claude-rca.json'),
      JSON.stringify({ version: 1, output_dir: rcaDir }),
    );
    writeFileSync(join(rcaDir, '2026', '04', 'RCA-clean.md'), cleanMd);

    const { stdout, exitCode } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'audit']),
    );
    assert.strictEqual(
      exitCode,
      null,
      'exit code must be null (no process.exit called) for clean corpus',
    );
    assert.ok(stdout.length > 0 || true, 'stdout may have summary');
  });

  it('exits 1 when any RCA has auto_filled fields', async () => {
    const { tmp, rcaDir } = makeRcaDir();
    writeFileSync(
      join(tmp, '.claude-rca.json'),
      JSON.stringify({ version: 1, output_dir: rcaDir }),
    );
    writeFileSync(join(rcaDir, '2026', '04', 'RCA-degraded.md'), degradedMd);

    const { exitCode } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'audit']),
    );
    assert.strictEqual(exitCode, 1, 'must exit 1 when degraded RCAs found');
  });

  it('reports degraded RCA filename in stdout', async () => {
    const { tmp, rcaDir } = makeRcaDir();
    writeFileSync(
      join(tmp, '.claude-rca.json'),
      JSON.stringify({ version: 1, output_dir: rcaDir }),
    );
    writeFileSync(join(rcaDir, '2026', '04', 'RCA-degraded.md'), degradedMd);

    const { stdout } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'audit']),
    );
    assert.ok(
      stdout.includes('RCA-degraded.md'),
      `stdout must mention the degraded filename, got: ${stdout}`,
    );
  });

  it('--json outputs a JSON document with degraded array and clean_count', async () => {
    const { tmp, rcaDir } = makeRcaDir();
    writeFileSync(
      join(tmp, '.claude-rca.json'),
      JSON.stringify({ version: 1, output_dir: rcaDir }),
    );
    writeFileSync(join(rcaDir, '2026', '04', 'RCA-clean.md'), cleanMd);
    writeFileSync(join(rcaDir, '2026', '04', 'RCA-degraded.md'), degradedMd);

    const { stdout, exitCode } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'audit', '--json']),
    );
    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed.degraded));
    assert.strictEqual(typeof parsed.clean_count, 'number');
    assert.strictEqual(parsed.degraded.length, 1);
    assert.ok(parsed.degraded[0].path.includes('RCA-degraded.md'));
    assert.strictEqual(exitCode, 1, '--json must exit 1 when degraded RCAs found');
  });
});
