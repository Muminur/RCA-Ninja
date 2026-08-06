import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createProgram } from '../../src/cli.mjs';

// ---------------------------------------------------------------------------
// capture helper — intercepts stdout/stderr and mocked process.exit
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helper: write a _manifest.jsonl so computeTrends has data to read
// ---------------------------------------------------------------------------

function writeManifest(dir, entries) {
  const headerLines = ['# Auto-generated test manifest', `# Count: ${entries.length}`];
  const jsonLines = entries.map((e) => JSON.stringify(e));
  const content = [...headerLines, ...jsonLines].join('\n') + '\n';
  writeFileSync(join(dir, '_manifest.jsonl'), content, 'utf8');
}

function makeEntry(overrides = {}) {
  return {
    id: 'RCA-2026-01-01-aaa0000',
    title: 'Test RCA',
    date: '2026-01-01',
    tags: [],
    files: [],
    components: [],
    description: '',
    confidence: 'high',
    path: 'RCA-2026-01-01-aaa0000-test.md',
    ref: 'aaa0000',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper: build a tmp workspace with .claude-rca.json pointing at rcaDir
// ---------------------------------------------------------------------------

function makeWorkspace(rcaDir) {
  const tmp = mkdtempSync(join(tmpdir(), 'claude-rca-cli-sub-'));
  writeFileSync(join(tmp, '.claude-rca.json'), JSON.stringify({ version: 1, output_dir: rcaDir }));
  return tmp;
}

// ---------------------------------------------------------------------------
// `trends` command — text output
// ---------------------------------------------------------------------------

describe('trends CLI command', () => {
  it('prints total RCA count', async () => {
    const rcaDir = mkdtempSync(join(tmpdir(), 'claude-rca-trends-cli-'));
    writeManifest(rcaDir, [
      makeEntry({ id: 'RCA-1', ref: 'aaa0001' }),
      makeEntry({ id: 'RCA-2', ref: 'aaa0002' }),
    ]);
    const tmp = makeWorkspace(rcaDir);

    const { stdout, exitCode } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'trends']),
    );
    assert.strictEqual(exitCode, null);
    assert.ok(stdout.includes('Total RCAs: 2'), `expected "Total RCAs: 2", got: ${stdout}`);
  });

  it('prints recurrent files when file appears 2+ times', async () => {
    const rcaDir = mkdtempSync(join(tmpdir(), 'claude-rca-trends-cli-recur-'));
    writeManifest(rcaDir, [
      makeEntry({ id: 'RCA-1', ref: 'aaa0001', files: ['src/auth.mjs', 'src/index.mjs'] }),
      makeEntry({ id: 'RCA-2', ref: 'aaa0002', files: ['src/auth.mjs'] }),
    ]);
    const tmp = makeWorkspace(rcaDir);

    const { stdout } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'trends']),
    );
    assert.ok(
      stdout.includes('Recurrent files'),
      `expected recurrent files section, got: ${stdout}`,
    );
    assert.ok(stdout.includes('src/auth.mjs'), `expected auth.mjs, got: ${stdout}`);
  });

  it('prints top tags when tags exist', async () => {
    const rcaDir = mkdtempSync(join(tmpdir(), 'claude-rca-trends-cli-tags-'));
    writeManifest(rcaDir, [
      makeEntry({ id: 'RCA-1', ref: 'aaa0001', tags: ['auth', 'backend'] }),
      makeEntry({ id: 'RCA-2', ref: 'aaa0002', tags: ['auth', 'frontend'] }),
    ]);
    const tmp = makeWorkspace(rcaDir);

    const { stdout } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'trends']),
    );
    assert.ok(stdout.includes('Top tags'), `expected top tags section, got: ${stdout}`);
    assert.ok(stdout.includes('auth'), `expected auth tag, got: ${stdout}`);
  });

  it('prints most-affected files when file_counts is non-empty', async () => {
    const rcaDir = mkdtempSync(join(tmpdir(), 'claude-rca-trends-cli-fcounts-'));
    writeManifest(rcaDir, [makeEntry({ id: 'RCA-1', ref: 'aaa0001', files: ['src/db.mjs'] })]);
    const tmp = makeWorkspace(rcaDir);

    const { stdout } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'trends']),
    );
    assert.ok(
      stdout.includes('Most-affected files'),
      `expected most-affected files section, got: ${stdout}`,
    );
    assert.ok(stdout.includes('src/db.mjs'), `expected db.mjs, got: ${stdout}`);
  });

  it('--json outputs valid JSON with expected shape', async () => {
    const rcaDir = mkdtempSync(join(tmpdir(), 'claude-rca-trends-cli-json-'));
    writeManifest(rcaDir, [
      makeEntry({ id: 'RCA-1', ref: 'aaa0001', tags: ['bug'], files: ['src/foo.mjs'] }),
    ]);
    const tmp = makeWorkspace(rcaDir);

    const { stdout, exitCode } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'trends', '--json']),
    );
    assert.strictEqual(exitCode, null);
    const parsed = JSON.parse(stdout);
    assert.strictEqual(typeof parsed.total, 'number');
    assert.ok('tag_counts' in parsed);
    assert.ok('file_counts' in parsed);
    assert.ok('recurrent_files' in parsed);
    assert.strictEqual(parsed.total, 1);
  });

  it('handles empty manifest without crashing', async () => {
    const rcaDir = mkdtempSync(join(tmpdir(), 'claude-rca-trends-cli-empty-'));
    writeManifest(rcaDir, []);
    const tmp = makeWorkspace(rcaDir);

    const { stdout, exitCode } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'trends']),
    );
    assert.strictEqual(exitCode, null);
    assert.ok(stdout.includes('Total RCAs: 0'), `expected "Total RCAs: 0", got: ${stdout}`);
  });

  it('skips recurrent files / top tags sections when empty', async () => {
    const rcaDir = mkdtempSync(join(tmpdir(), 'claude-rca-trends-cli-nosec-'));
    writeManifest(rcaDir, [makeEntry({ id: 'RCA-1', ref: 'aaa0001', tags: [], files: [] })]);
    const tmp = makeWorkspace(rcaDir);

    const { stdout, exitCode } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'trends']),
    );
    assert.strictEqual(exitCode, null);
    assert.ok(!stdout.includes('Recurrent files'), 'should not print Recurrent files when none');
    assert.ok(!stdout.includes('Top tags'), 'should not print Top tags when none');
    assert.ok(!stdout.includes('Most-affected files'), 'should not print Most-affected when none');
  });
});

// ---------------------------------------------------------------------------
// `amend` command
// ---------------------------------------------------------------------------

describe('amend CLI command', () => {
  it('exits 1 when --hint is missing', async () => {
    const rcaDir = mkdtempSync(join(tmpdir(), 'claude-rca-amend-cli-nohint-'));
    const tmp = makeWorkspace(rcaDir);

    const { stderr, exitCode } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'amend', 'some-id']),
    );
    assert.strictEqual(exitCode, 1, 'must exit 1 when --hint is missing');
    assert.ok(
      stderr.includes('--hint') && stderr.includes('required'),
      `stderr should mention --hint is required, got: ${stderr}`,
    );
  });

  it('exits with RcaError exit code when id is not found', async () => {
    const rcaDir = mkdtempSync(join(tmpdir(), 'claude-rca-amend-cli-notfound-'));
    mkdirSync(rcaDir, { recursive: true });
    const tmp = makeWorkspace(rcaDir);

    const { exitCode } = await capture(() =>
      createProgram().parseAsync([
        'node',
        'rca',
        '--cwd',
        tmp,
        'amend',
        'nonexistent-id',
        '--hint',
        'please fix this',
      ]),
    );
    // amendRca throws RcaError NOT_FOUND which has a non-zero exitCode
    assert.ok(
      exitCode !== null && exitCode > 0,
      `expected non-zero exit for not-found id, got: ${exitCode}`,
    );
  });

  it('prints error message to stderr when id is not found', async () => {
    const rcaDir = mkdtempSync(join(tmpdir(), 'claude-rca-amend-cli-stderr-'));
    mkdirSync(rcaDir, { recursive: true });
    const tmp = makeWorkspace(rcaDir);

    const { stderr } = await capture(() =>
      createProgram().parseAsync([
        'node',
        'rca',
        '--cwd',
        tmp,
        'amend',
        'nonexistent-id',
        '--hint',
        'correction hint',
      ]),
    );
    assert.ok(stderr.length > 0, 'stderr should have an error message');
  });
});

// ---------------------------------------------------------------------------
// `recent` command
// ---------------------------------------------------------------------------

describe('recent CLI command', () => {
  it('exits 0 and outputs nothing when dir is empty', async () => {
    const rcaDir = mkdtempSync(join(tmpdir(), 'claude-rca-recent-cli-empty-'));
    const tmp = makeWorkspace(rcaDir);

    const { stdout, exitCode } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'recent']),
    );
    assert.strictEqual(exitCode, null);
    assert.strictEqual(stdout, '');
  });

  it('--json outputs empty array when no RCAs', async () => {
    const rcaDir = mkdtempSync(join(tmpdir(), 'claude-rca-recent-cli-json-'));
    const tmp = makeWorkspace(rcaDir);

    const { stdout, exitCode } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'recent', '--json']),
    );
    assert.strictEqual(exitCode, null);
    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed));
    assert.strictEqual(parsed.length, 0);
  });

  it('lists RCA files in text mode', async () => {
    const rcaDir = mkdtempSync(join(tmpdir(), 'claude-rca-recent-cli-list-'));
    writeFileSync(join(rcaDir, 'RCA-2026-01-01-abc1234-test.md'), '# test\n');
    const tmp = makeWorkspace(rcaDir);

    const { stdout, exitCode } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'recent']),
    );
    assert.strictEqual(exitCode, null);
    assert.ok(
      stdout.includes('RCA-2026-01-01-abc1234-test.md'),
      `expected file in output, got: ${stdout}`,
    );
  });
});

// ---------------------------------------------------------------------------
// `show` command
// ---------------------------------------------------------------------------

describe('show CLI command', () => {
  it('outputs file content when given an absolute path', async () => {
    const rcaDir = mkdtempSync(join(tmpdir(), 'claude-rca-show-cli-'));
    const filePath = join(rcaDir, 'RCA-2026-01-01-abc1234-test.md');
    writeFileSync(filePath, '# test content\n');
    const tmp = makeWorkspace(rcaDir);

    const { stdout, exitCode } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'show', filePath]),
    );
    assert.strictEqual(exitCode, null);
    assert.ok(stdout.includes('test content'), `expected content, got: ${stdout}`);
  });

  it('exits non-zero when id is not found', async () => {
    const rcaDir = mkdtempSync(join(tmpdir(), 'claude-rca-show-cli-notfound-'));
    mkdirSync(rcaDir, { recursive: true });
    const tmp = makeWorkspace(rcaDir);

    const { exitCode } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'show', 'no-such-id']),
    );
    assert.ok(exitCode !== null && exitCode > 0, `expected non-zero exit, got: ${exitCode}`);
  });
});

// ---------------------------------------------------------------------------
// `config` command
// ---------------------------------------------------------------------------

describe('config CLI command', () => {
  it('--get output_dir returns the configured output dir', async () => {
    const rcaDir = mkdtempSync(join(tmpdir(), 'claude-rca-config-cli-get-'));
    const tmp = makeWorkspace(rcaDir);

    const { stdout, exitCode } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'config', '--get', 'output_dir']),
    );
    assert.strictEqual(exitCode, null);
    assert.ok(stdout.trim().length > 0, 'should output the output_dir value');
  });

  it('no flags outputs full config as JSON', async () => {
    const rcaDir = mkdtempSync(join(tmpdir(), 'claude-rca-config-cli-list-'));
    const tmp = makeWorkspace(rcaDir);

    const { stdout, exitCode } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'config']),
    );
    assert.strictEqual(exitCode, null);
    const parsed = JSON.parse(stdout);
    assert.ok('output_dir' in parsed, 'config JSON should have output_dir key');
  });

  it('--set key=value writes config and reports success on stderr', async () => {
    const rcaDir = mkdtempSync(join(tmpdir(), 'claude-rca-config-cli-set-'));
    const tmp = makeWorkspace(rcaDir);

    const { stderr, exitCode } = await capture(() =>
      createProgram().parseAsync([
        'node',
        'rca',
        '--cwd',
        tmp,
        'config',
        '--set',
        'output_dir=./new-rca',
      ]),
    );
    assert.strictEqual(exitCode, null);
    assert.ok(stderr.includes('set output_dir'), `expected confirmation, got: ${stderr}`);
  });

  it('--set without = exits 1 with usage error', async () => {
    const rcaDir = mkdtempSync(join(tmpdir(), 'claude-rca-config-cli-setnoeq-'));
    const tmp = makeWorkspace(rcaDir);

    const { stderr, exitCode } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'config', '--set', 'output_dir']),
    );
    assert.strictEqual(exitCode, 1);
    assert.ok(stderr.includes('Usage'), `expected usage error, got: ${stderr}`);
  });

  it('refuses legacy provider execution controls as config-set keys', async () => {
    const rcaDir = mkdtempSync(join(tmpdir(), 'claude-rca-config-cli-fixed-provider-'));
    const tmp = makeWorkspace(rcaDir);
    const configPath = join(tmp, '.claude-rca.json');
    const before = readFileSync(configPath, 'utf8');

    for (const setting of [
      'claude.binary=attacker-controlled',
      'claude.permission_mode=bypassPermissions',
      'claude.allowed_tools=Bash',
      'codex.binary=attacker-controlled',
      'codex.sandbox=danger-full-access',
    ]) {
      const { stderr, exitCode } = await capture(() =>
        createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'config', '--set', setting]),
      );
      assert.strictEqual(exitCode, 50, `${setting} must be rejected`);
      assert.match(stderr, /unknown config key/i);
      assert.strictEqual(readFileSync(configPath, 'utf8'), before);
    }
  });
});

// ---------------------------------------------------------------------------
// `audit` command
// ---------------------------------------------------------------------------

describe('audit CLI command', () => {
  it('reports all clean when dir is empty (text mode)', async () => {
    const rcaDir = mkdtempSync(join(tmpdir(), 'claude-rca-audit-cli-empty-'));
    const tmp = makeWorkspace(rcaDir);

    const { stdout, exitCode } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'audit']),
    );
    assert.strictEqual(exitCode, null);
    assert.ok(
      stdout.includes('clean') || stdout.includes('All'),
      `expected clean status, got: ${stdout}`,
    );
  });

  it('--json outputs valid JSON with degraded array and clean_count', async () => {
    const rcaDir = mkdtempSync(join(tmpdir(), 'claude-rca-audit-cli-json-'));
    const tmp = makeWorkspace(rcaDir);

    const { stdout, exitCode } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'audit', '--json']),
    );
    assert.strictEqual(exitCode, null);
    const parsed = JSON.parse(stdout);
    assert.ok('degraded' in parsed, 'JSON should have degraded field');
    assert.ok('clean_count' in parsed, 'JSON should have clean_count field');
    assert.strictEqual(parsed.degraded.length, 0);
  });

  it('exits 1 and prints DEGRADED line when auto_filled field present (text mode)', async () => {
    const rcaDir = mkdtempSync(join(tmpdir(), 'claude-rca-audit-cli-degraded-'));
    writeFileSync(
      join(rcaDir, 'RCA-2026-01-01-abc1234-test.md'),
      '---\nauto_filled:\n  - severity\ntitle: Test\n---\n\n# content\n',
    );
    const tmp = makeWorkspace(rcaDir);

    const { stdout, exitCode } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'audit']),
    );
    assert.ok(exitCode !== null && exitCode > 0, `expected non-zero exit, got: ${exitCode}`);
    assert.ok(stdout.includes('DEGRADED'), `expected DEGRADED in output, got: ${stdout}`);
  });

  it('--json exits 1 when degraded RCAs exist', async () => {
    const rcaDir = mkdtempSync(join(tmpdir(), 'claude-rca-audit-cli-json-deg-'));
    writeFileSync(
      join(rcaDir, 'RCA-2026-01-01-abc1234-test.md'),
      '---\nauto_filled:\n  - severity\ntitle: Test\n---\n\n# content\n',
    );
    const tmp = makeWorkspace(rcaDir);

    const { stdout, exitCode } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'audit', '--json']),
    );
    assert.ok(
      exitCode !== null && exitCode > 0,
      `expected non-zero exit for degraded, got: ${exitCode}`,
    );
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.degraded.length, 1);
  });
});

// ---------------------------------------------------------------------------
// `rebuild` command
// ---------------------------------------------------------------------------

const validRcaMd =
  '---\ntitle: "Test RCA Title Here"\nsymptom: "Something broke in production badly"\nroot_cause: "A bug was introduced in the code"\nfix: "Fixed by reverting the bad change"\nimpact: "Minor production impact"\nfiles: ["src/test.mjs"]\ntags: ["test", "bugfix"]\nconfidence: high\n---\n\n## Symptom\n\nSomething broke.\n';

const invalidRcaMd =
  '---\ntitle: "Incomplete RCA"\n---\n\n## Symptom\n\nMissing required fields.\n';

describe('rebuild CLI command', () => {
  it('reports "No RCA directory found" when outputDir does not exist', async () => {
    const nonExistentRca = join(tmpdir(), 'claude-rca-rebuild-nodir-' + Date.now());
    const tmp = makeWorkspace(nonExistentRca);

    const { stderr, exitCode } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'rebuild']),
    );
    assert.strictEqual(exitCode, null, 'should not exit with error code');
    assert.ok(
      stderr.includes('No RCA directory found'),
      `expected "No RCA directory found", got: ${stderr}`,
    );
  });

  it('reports Valid: 0, Invalid: 0, Fixed: 0 for empty dir', async () => {
    const rcaDir = mkdtempSync(join(tmpdir(), 'claude-rca-rebuild-empty-'));
    const tmp = makeWorkspace(rcaDir);

    const { stderr, exitCode } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'rebuild']),
    );
    assert.strictEqual(exitCode, null);
    assert.ok(stderr.includes('Valid: 0'), `expected Valid: 0, got: ${stderr}`);
    assert.ok(stderr.includes('Invalid: 0'), `expected Invalid: 0, got: ${stderr}`);
  });

  it('reports Valid: 1 for a valid RCA file', async () => {
    const rcaDir = mkdtempSync(join(tmpdir(), 'claude-rca-rebuild-valid-'));
    writeFileSync(join(rcaDir, 'RCA-2026-01-01-abc1234-test.md'), validRcaMd);
    const tmp = makeWorkspace(rcaDir);

    const { stderr, exitCode } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'rebuild']),
    );
    assert.strictEqual(exitCode, null);
    assert.ok(stderr.includes('Valid: 1'), `expected Valid: 1, got: ${stderr}`);
    assert.ok(stderr.includes('Invalid: 0'), `expected Invalid: 0, got: ${stderr}`);
  });

  it('exits 1 and reports Invalid: 1 for an invalid RCA file (text mode)', async () => {
    const rcaDir = mkdtempSync(join(tmpdir(), 'claude-rca-rebuild-invalid-'));
    writeFileSync(join(rcaDir, 'RCA-2026-01-01-abc1234-bad.md'), invalidRcaMd);
    const tmp = makeWorkspace(rcaDir);

    const { stderr, exitCode } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'rebuild']),
    );
    assert.ok(exitCode !== null && exitCode > 0, `expected non-zero exit, got: ${exitCode}`);
    assert.ok(stderr.includes('Invalid: 1'), `expected Invalid: 1, got: ${stderr}`);
    assert.ok(stderr.includes('✖'), `expected error marker in output, got: ${stderr}`);
  });

  it('--json outputs JSON with valid/invalid/fixed arrays', async () => {
    const rcaDir = mkdtempSync(join(tmpdir(), 'claude-rca-rebuild-json-'));
    writeFileSync(join(rcaDir, 'RCA-2026-01-01-abc1234-valid.md'), validRcaMd);
    writeFileSync(join(rcaDir, 'RCA-2026-01-01-def5678-invalid.md'), invalidRcaMd);
    const tmp = makeWorkspace(rcaDir);

    const { stdout, exitCode } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'rebuild', '--json']),
    );
    assert.ok(exitCode !== null && exitCode > 0, 'should exit 1 for invalid RCAs');
    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed.valid), 'should have valid array');
    assert.ok(Array.isArray(parsed.invalid), 'should have invalid array');
    assert.ok(Array.isArray(parsed.fixed), 'should have fixed array');
    assert.strictEqual(parsed.valid.length, 1);
    assert.strictEqual(parsed.invalid.length, 1);
  });

  it('--fix patches missing fields and reports Fixed: 1', async () => {
    const rcaDir = mkdtempSync(join(tmpdir(), 'claude-rca-rebuild-fix-'));
    // Fixable RCA: has title, symptom, root_cause, fix — missing impact, files, tags, confidence
    writeFileSync(
      join(rcaDir, 'RCA-2026-01-01-abc1234-fixable.md'),
      '---\ntitle: "Fixable RCA title"\nsymptom: "Something broke in production badly"\nroot_cause: "A bug was introduced in the code"\nfix: "Fixed by reverting the bad change"\n---\n\n## Symptom\n\nBroke.\n',
    );
    const tmp = makeWorkspace(rcaDir);

    const { stderr, exitCode } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'rebuild', '--fix']),
    );
    assert.strictEqual(exitCode, null, `expected exit 0 after fix, got: ${exitCode}`);
    assert.ok(stderr.includes('Fixed: 1'), `expected Fixed: 1, got: ${stderr}`);
  });
});

// ---------------------------------------------------------------------------
// `init` command with --no-hooks
// ---------------------------------------------------------------------------

describe('init CLI command (no-hooks)', () => {
  it('creates .claude-rca.json and prints confirmation to stderr', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'claude-rca-init-cli-'));

    const { stderr, exitCode } = await capture(() =>
      createProgram().parseAsync(['node', 'rca', '--cwd', tmp, 'init', '--no-hooks']),
    );
    assert.strictEqual(exitCode, null);
    assert.ok(stderr.includes('✓'), `expected success marker in stderr, got: ${stderr}`);
  });
});
