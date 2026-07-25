import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const BIN = join(ROOT, 'bin', 'claude-rca');
const STUB = join(ROOT, 'test', 'fixtures', 'claude-stub.mjs');

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

/**
 * `generate --since` wrote RCAs and rebuilt the manifest but never synced to
 * the vault, so a backfill left Obsidian silently missing every RCA it made.
 */
function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'claude-rca-since-sync-'));
  const repo = join(tmp, 'repo');
  const vault = join(tmp, 'vault');
  mkdirSync(repo, { recursive: true });
  // syncToVault refuses a directory without this marker.
  mkdirSync(join(vault, '.obsidian'), { recursive: true });

  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@test.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  writeFileSync(join(repo, 'seed.js'), 'let a = 1;\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'chore: seed'], repo);
  const base = git(['rev-parse', 'HEAD'], repo);

  writeFileSync(join(repo, 'seed.js'), 'let a = 2;\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'fix: correct the off-by-one'], repo);

  writeFileSync(
    join(repo, '.claude-rca.json'),
    JSON.stringify({
      version: 1,
      output_dir: './rca',
      claude: { binary: `node ${STUB}` },
      obsidian: { enabled: true, vault_path: vault },
    }),
  );

  return { repo, vault, base };
}

describe('generate --since syncs like generate --from', () => {
  it('copies backfilled RCAs into the Obsidian vault', () => {
    const { repo, vault, base } = setup();

    execFileSync('node', [BIN, 'generate', '--since', base], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env },
      timeout: 60000,
    });

    const rcaDir = join(repo, 'rca');
    assert.ok(existsSync(rcaDir), 'backfill must write the RCA corpus');

    const vaultRcaRoot = join(vault, 'RCA');
    assert.ok(
      existsSync(vaultRcaRoot),
      'backfill must create the vault RCA folder — this is the regression',
    );

    const synced = [];
    for (const folder of readdirSync(vaultRcaRoot)) {
      const sub = join(vaultRcaRoot, folder);
      for (const f of readdirSync(sub)) if (f.endsWith('.md')) synced.push(f);
    }
    assert.ok(synced.length >= 1, `expected at least one synced RCA, found ${synced.length}`);
  });

  it('honours --no-obsidian in batch mode', () => {
    const { repo, vault, base } = setup();

    execFileSync('node', [BIN, 'generate', '--since', base, '--no-obsidian'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env },
      timeout: 60000,
    });

    assert.ok(
      !existsSync(join(vault, 'RCA')),
      '--no-obsidian must suppress vault sync in batch mode too',
    );
  });
});
