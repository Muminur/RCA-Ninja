import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
import { tmpdir } from 'node:os';
import {
  detectVault,
  syncToVault,
  appendDailyNote,
  buildObsidianUri,
  resolveTargetFolder,
  formatDailyNoteName,
  localDateParts,
} from '../../src/obsidian.mjs';

// The daily note is named for the user's LOCAL calendar date. Deriving it here
// with toISOString() would just mirror the bug this pins against.
function localToday() {
  const { YYYY, MM, DD } = localDateParts();
  return `${YYYY}-${MM}-${DD}`;
}

function createVault(tmp) {
  const vault = join(tmp, 'my-vault');
  mkdirSync(join(vault, '.obsidian'), { recursive: true });
  return vault;
}

function createRca(tmp) {
  const rca = join(tmp, 'RCA-2026-04-25-a3f2c1d-test-bug.md');
  writeFileSync(rca, '---\ntitle: "Test Bug"\n---\n\n## Symptom\n\nStuff broke.\n');
  return rca;
}

describe('obsidian', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'claude-rca-obs-'));
  });

  it('detects a valid vault', () => {
    const vault = createVault(tmp);
    const result = detectVault(vault);
    assert.strictEqual(result, vault);
  });

  it('rejects invalid vault (no .obsidian/)', () => {
    mkdirSync(join(tmp, 'not-a-vault'));
    assert.throws(
      () => detectVault(join(tmp, 'not-a-vault')),
      (err) => err.code === 'INVALID_VAULT',
    );
  });

  it('throws NO_VAULT when path is empty', () => {
    assert.throws(
      () => detectVault(''),
      (err) => err.code === 'NO_VAULT',
    );
  });

  it('syncs RCA to vault target folder', async () => {
    const vault = createVault(tmp);
    const rca = createRca(tmp);
    const dest = await syncToVault({ rcaPath: rca, vaultPath: vault });
    assert.ok(existsSync(dest));
    assert.ok(dest.includes('RCA Inbox'));
    assert.strictEqual(readFileSync(dest, 'utf8'), readFileSync(rca, 'utf8'));
  });

  it('daily note name uses the local calendar date, not the UTC date', () => {
    // Pick an instant whose local date differs from its UTC date in this timezone.
    const candidates = [
      new Date(2026, 6, 10, 0, 1, 0), // local 2026-07-10 00:01
      new Date(2026, 6, 10, 23, 59, 0), // local 2026-07-10 23:59
    ];
    const differing = candidates.find((d) => d.toISOString().slice(0, 10) !== '2026-07-10');
    if (!differing) return; // only in UTC itself, where the bug is unobservable

    assert.strictEqual(formatDailyNoteName('YYYY-MM-DD', differing), '2026-07-10');
    assert.notStrictEqual(
      formatDailyNoteName('YYYY-MM-DD', differing),
      differing.toISOString().slice(0, 10),
      'must not equal the UTC date for this instant',
    );
  });

  it('appends to daily note if it exists', () => {
    const vault = createVault(tmp);
    const dailyDir = join(vault, 'Daily Notes');
    mkdirSync(dailyDir, { recursive: true });
    const today = localToday();
    const dailyPath = join(dailyDir, `${today}.md`);
    writeFileSync(dailyPath, '# Today\n\n- Did some stuff\n');

    appendDailyNote({
      vaultPath: vault,
      dailyNotesFolder: 'Daily Notes',
      dailyNoteFormat: 'YYYY-MM-DD',
      rcaBasename: 'RCA-2026-04-25-a3f2c1d-test-bug.md',
      title: 'Test bug broke things',
    });

    const content = readFileSync(dailyPath, 'utf8');
    assert.ok(content.includes('[[RCA-2026-04-25-a3f2c1d-test-bug]]'));
  });

  it('does NOT create daily note if absent', () => {
    const vault = createVault(tmp);
    const dailyDir = join(vault, 'Daily Notes');
    mkdirSync(dailyDir, { recursive: true });

    const result = appendDailyNote({
      vaultPath: vault,
      dailyNotesFolder: 'Daily Notes',
      dailyNoteFormat: 'YYYY-MM-DD',
      rcaBasename: 'test.md',
      title: 'test',
    });
    assert.strictEqual(result, null);
  });

  it('is idempotent — does not duplicate bullet', () => {
    const vault = createVault(tmp);
    const dailyDir = join(vault, 'Daily Notes');
    mkdirSync(dailyDir, { recursive: true });
    const today = localToday();
    const dailyPath = join(dailyDir, `${today}.md`);
    writeFileSync(dailyPath, '# Today\n');

    const args = {
      vaultPath: vault,
      dailyNotesFolder: 'Daily Notes',
      dailyNoteFormat: 'YYYY-MM-DD',
      rcaBasename: 'RCA-test.md',
      title: 'test',
    };
    appendDailyNote(args);
    appendDailyNote(args);

    const content = readFileSync(dailyPath, 'utf8');
    const matches = content.match(/\[\[RCA-test\]\]/g);
    assert.strictEqual(matches.length, 1);
  });

  it('builds obsidian URI', () => {
    const uri = buildObsidianUri({
      vaultPath: '/Users/dev/my-vault',
      targetFolder: 'RCA Inbox',
      rcaBasename: 'RCA-2026-04-25-a3f2c1d-test.md',
    });
    assert.ok(uri.startsWith('obsidian://open?'));
    assert.ok(uri.includes('vault=my-vault'));
    assert.ok(uri.includes('file='));
  });

  it('proxy guard: syncToVault never writes to .obsidian/ path', async () => {
    const vault = createVault(tmp);
    const rca = createRca(tmp);
    const dest = await syncToVault({ rcaPath: rca, vaultPath: vault });
    const normalDest = dest.replace(/\\/g, '/');
    assert.ok(
      !normalDest.includes('/.obsidian/'),
      `syncToVault must not write into .obsidian/ — got: ${dest}`,
    );
    assert.ok(normalDest.includes('/RCA Inbox/'), `dest must be in RCA Inbox, got: ${dest}`);
  });

  it('proxy guard: obsidian.mjs source never calls atomicWrite or appendFileSync with a .obsidian path', () => {
    const { readFileSync: rfs } = require('node:fs');
    const src = rfs(join(ROOT, 'src', 'obsidian.mjs'), 'utf8');
    assert.ok(
      !/atomicWrite\s*\([^)]*\.obsidian/.test(src),
      'obsidian.mjs must not call atomicWrite with a .obsidian path',
    );
    assert.ok(
      !/appendFileSync\s*\([^,]*\.obsidian/.test(src),
      'obsidian.mjs must not call appendFileSync with a .obsidian path',
    );
  });

  it('resolveTargetFolder uses config value when explicitly set (non-empty, not "RCA Inbox")', () => {
    const result = resolveTargetFolder({
      configTargetFolder: 'Projects/my-app',
      repoName: 'my-app',
    });
    assert.strictEqual(result, 'Projects/my-app');
  });

  it('resolveTargetFolder auto-detects from repo name when config is empty string', () => {
    const result = resolveTargetFolder({ configTargetFolder: '', repoName: 'cool-project' });
    assert.strictEqual(result, 'RCA/cool-project');
  });

  it('resolveTargetFolder auto-detects when config is old default "RCA Inbox"', () => {
    const result = resolveTargetFolder({
      configTargetFolder: 'RCA Inbox',
      repoName: 'cool-project',
    });
    assert.strictEqual(result, 'RCA/cool-project');
  });

  it('resolveTargetFolder falls back to RCA/unknown when no repo name and empty config', () => {
    const result = resolveTargetFolder({ configTargetFolder: '', repoName: '' });
    assert.strictEqual(result, 'RCA/unknown');
  });
});
