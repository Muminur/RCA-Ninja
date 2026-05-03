import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { computeTrends } from '../../src/trends.mjs';

/**
 * Write a _manifest.jsonl file directly (without rebuildManifest) so these
 * tests have zero dependency on the manifest-build logic.
 */
function writeManifest(dir, entries) {
  const headerLines = [
    '# Auto-generated test manifest',
    `# Count: ${entries.length}`,
  ];
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

describe('computeTrends', () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claude-rca-trends-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns zero counts for empty manifest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-trends-empty-'));
    try {
      writeManifest(dir, []);
      const result = await computeTrends({ outputDir: dir });
      assert.strictEqual(result.total, 0);
      assert.deepStrictEqual(result.tag_counts, {});
      assert.deepStrictEqual(result.file_counts, {});
      assert.deepStrictEqual(result.component_counts, {});
      assert.deepStrictEqual(result.recurrent_files, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts tags correctly across multiple entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-trends-tags-'));
    try {
      writeManifest(dir, [
        makeEntry({ id: 'RCA-1', tags: ['auth', 'backend'], ref: 'aaa0001' }),
        makeEntry({ id: 'RCA-2', tags: ['auth', 'frontend'], ref: 'aaa0002' }),
        makeEntry({ id: 'RCA-3', tags: ['backend'], ref: 'aaa0003' }),
      ]);
      const result = await computeTrends({ outputDir: dir });
      assert.strictEqual(result.tag_counts['auth'], 2);
      assert.strictEqual(result.tag_counts['backend'], 2);
      assert.strictEqual(result.tag_counts['frontend'], 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts files correctly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-trends-files-'));
    try {
      writeManifest(dir, [
        makeEntry({ id: 'RCA-1', files: ['src/auth.mjs', 'src/session.mjs'], ref: 'aaa0001' }),
        makeEntry({ id: 'RCA-2', files: ['src/auth.mjs'], ref: 'aaa0002' }),
        makeEntry({ id: 'RCA-3', files: ['src/other.mjs'], ref: 'aaa0003' }),
      ]);
      const result = await computeTrends({ outputDir: dir });
      assert.strictEqual(result.file_counts['src/auth.mjs'], 2);
      assert.strictEqual(result.file_counts['src/session.mjs'], 1);
      assert.strictEqual(result.file_counts['src/other.mjs'], 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts components correctly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-trends-comps-'));
    try {
      writeManifest(dir, [
        makeEntry({ id: 'RCA-1', components: ['auth-service', 'db'], ref: 'aaa0001' }),
        makeEntry({ id: 'RCA-2', components: ['auth-service'], ref: 'aaa0002' }),
        makeEntry({ id: 'RCA-3', components: ['cache'], ref: 'aaa0003' }),
      ]);
      const result = await computeTrends({ outputDir: dir });
      assert.strictEqual(result.component_counts['auth-service'], 2);
      assert.strictEqual(result.component_counts['db'], 1);
      assert.strictEqual(result.component_counts['cache'], 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recurrent_files contains only files appearing in >= 2 RCAs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-trends-recurrent-'));
    try {
      writeManifest(dir, [
        makeEntry({ id: 'RCA-1', files: ['src/auth.mjs', 'src/once.mjs'], ref: 'aaa0001' }),
        makeEntry({ id: 'RCA-2', files: ['src/auth.mjs'], ref: 'aaa0002' }),
        makeEntry({ id: 'RCA-3', files: ['src/unique.mjs'], ref: 'aaa0003' }),
      ]);
      const result = await computeTrends({ outputDir: dir });
      const recurrentFiles = result.recurrent_files.map((r) => r.file);
      assert.ok(recurrentFiles.includes('src/auth.mjs'), 'auth.mjs appears in 2 RCAs');
      assert.ok(!recurrentFiles.includes('src/once.mjs'), 'once.mjs appears in only 1 RCA');
      assert.ok(!recurrentFiles.includes('src/unique.mjs'), 'unique.mjs appears in only 1 RCA');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recurrent_files sorted by count descending', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-trends-recurrentsort-'));
    try {
      writeManifest(dir, [
        makeEntry({ id: 'RCA-1', files: ['src/a.mjs', 'src/b.mjs'], ref: 'aaa0001' }),
        makeEntry({ id: 'RCA-2', files: ['src/a.mjs', 'src/b.mjs'], ref: 'aaa0002' }),
        makeEntry({ id: 'RCA-3', files: ['src/a.mjs', 'src/c.mjs'], ref: 'aaa0003' }),
        makeEntry({ id: 'RCA-4', files: ['src/c.mjs'], ref: 'aaa0004' }),
      ]);
      const result = await computeTrends({ outputDir: dir });
      // a.mjs: 3, b.mjs: 2, c.mjs: 2
      const counts = result.recurrent_files.map((r) => r.count);
      assert.ok(counts[0] >= counts[1], 'first entry should have count >= second');
      assert.ok(counts[1] >= counts[2], 'second entry should have count >= third');
      assert.strictEqual(result.recurrent_files[0].file, 'src/a.mjs');
      assert.strictEqual(result.recurrent_files[0].count, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('total equals number of manifest entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-trends-total-'));
    try {
      writeManifest(dir, [
        makeEntry({ id: 'RCA-1', ref: 'aaa0001' }),
        makeEntry({ id: 'RCA-2', ref: 'aaa0002' }),
        makeEntry({ id: 'RCA-3', ref: 'aaa0003' }),
        makeEntry({ id: 'RCA-4', ref: 'aaa0004' }),
      ]);
      const result = await computeTrends({ outputDir: dir });
      assert.strictEqual(result.total, 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles missing outputDir gracefully (returns zeros)', async () => {
    const nonExistentDir = join(tmpdir(), 'claude-rca-trends-nonexistent-' + Date.now());
    const result = await computeTrends({ outputDir: nonExistentDir });
    assert.strictEqual(result.total, 0);
    assert.deepStrictEqual(result.tag_counts, {});
    assert.deepStrictEqual(result.file_counts, {});
    assert.deepStrictEqual(result.component_counts, {});
    assert.deepStrictEqual(result.recurrent_files, []);
  });
});
