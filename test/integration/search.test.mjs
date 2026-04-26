import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { search, recent, show } from '../../src/search.mjs';

function createFixtures(dir, count) {
  for (let i = 0; i < count; i++) {
    const yyyy = '2026';
    const mm = String((i % 12) + 1).padStart(2, '0');
    const subdir = join(dir, yyyy, mm);
    mkdirSync(subdir, { recursive: true });
    const name = `RCA-${yyyy}-${mm}-01-abc${String(i).padStart(4, '0')}-test-rca.md`;
    const tag = i % 3 === 0 ? 'auth' : 'frontend';
    writeFileSync(
      join(subdir, name),
      `---\ntitle: "Test RCA ${i}"\ntags: [rca, bugfix, ${tag}]\n---\n\n## Symptom\n\nFoo bar baz ${i} search-target\n\n## Root Cause\n\nSomething broke ${i}\n`,
    );
  }
}

describe('search', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'claude-rca-search-'));
    createFixtures(tmp, 50);
  });

  it('finds hits for a query', async () => {
    const results = await search({ outputDir: tmp, query: 'search-target' });
    assert.ok(results.length > 0);
    assert.ok(results[0].path);
    assert.ok(results[0].line);
    assert.ok(results[0].text.includes('search-target'));
  });

  it('returns empty for no matches', async () => {
    const results = await search({ outputDir: tmp, query: 'zzz-nonexistent-zzz' });
    assert.strictEqual(results.length, 0);
  });

  it('filters by tag', async () => {
    const results = await search({ outputDir: tmp, query: 'Symptom', tag: 'auth' });
    assert.ok(results.length > 0);
  });

  it('returns JSON format', async () => {
    const results = await search({ outputDir: tmp, query: 'search-target', json: true });
    assert.ok(Array.isArray(results));
    if (results.length > 0) {
      assert.ok('path' in results[0]);
      assert.ok('line' in results[0]);
      assert.ok('text' in results[0]);
      assert.ok('mtime' in results[0]);
    }
  });
});

describe('recent', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'claude-rca-recent-'));
    createFixtures(tmp, 20);
  });

  it('returns N newest RCAs', () => {
    const results = recent({ outputDir: tmp, count: 5 });
    assert.strictEqual(results.length, 5);
  });

  it('defaults to 10', () => {
    const results = recent({ outputDir: tmp });
    assert.strictEqual(results.length, 10);
  });

  it('returns json format', () => {
    const results = recent({ outputDir: tmp, count: 3, json: true });
    assert.strictEqual(results.length, 3);
    assert.ok(results[0].path);
    assert.ok(results[0].basename);
    assert.ok(results[0].mtime);
  });
});

describe('show', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'claude-rca-show-'));
    createFixtures(tmp, 5);
  });

  it('resolves by basename', () => {
    const results = recent({ outputDir: tmp, count: 1 });
    const content = show({ outputDir: tmp, id: results[0].basename });
    assert.ok(content.includes('## Symptom'));
  });

  it('resolves by short hash substring', () => {
    const content = show({ outputDir: tmp, id: 'abc0000' });
    assert.ok(content.includes('Test RCA 0'));
  });

  it('throws NOT_FOUND for unknown id', () => {
    assert.throws(
      () => show({ outputDir: tmp, id: 'totally-bogus-id' }),
      (err) => err.code === 'NOT_FOUND',
    );
  });
});
