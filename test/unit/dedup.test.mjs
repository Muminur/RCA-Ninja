import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findRelatedRcas } from '../../src/dedup.mjs';

function createCorpus() {
  const tmp = mkdtempSync(join(tmpdir(), 'claude-rca-dedup-'));
  mkdirSync(join(tmp, '2026', '04'), { recursive: true });

  writeFileSync(
    join(tmp, '2026', '04', 'RCA-related1.md'),
    '---\ntitle: "Auth session fix"\nfiles:\n  - src/auth.js\n  - src/session.js\ntags: [rca]\n---\n\n## Symptom\nBroken\n',
  );
  writeFileSync(
    join(tmp, '2026', '04', 'RCA-related2.md'),
    '---\ntitle: "Session null pointer"\nfiles:\n  - src/session.js\n  - src/middleware.js\ntags: [rca]\n---\n\n## Symptom\nCrash\n',
  );
  writeFileSync(
    join(tmp, '2026', '04', 'RCA-unrelated.md'),
    '---\ntitle: "Database timeout"\nfiles:\n  - src/db.js\ntags: [rca]\n---\n\n## Symptom\nSlow\n',
  );

  return tmp;
}

describe('findRelatedRcas', () => {
  it('finds RCAs with overlapping files', () => {
    const dir = createCorpus();
    const results = findRelatedRcas({
      outputDir: dir,
      filesChanged: ['src/auth.js', 'src/session.js'],
    });
    assert.ok(results.length >= 1, 'should find at least 1 related RCA');
    assert.ok(results[0].overlap_score > 0.5);
  });

  it('returns empty for no overlap', () => {
    const dir = createCorpus();
    const results = findRelatedRcas({
      outputDir: dir,
      filesChanged: ['src/payments.js'],
    });
    assert.strictEqual(results.length, 0);
  });

  it('sorts by overlap score descending', () => {
    const dir = createCorpus();
    const results = findRelatedRcas({
      outputDir: dir,
      filesChanged: ['src/auth.js', 'src/session.js'],
    });
    if (results.length > 1) {
      assert.ok(results[0].overlap_score >= results[1].overlap_score);
    }
  });

  it('returns empty for missing output dir', () => {
    const results = findRelatedRcas({
      outputDir: '/nonexistent',
      filesChanged: ['a.js'],
    });
    assert.strictEqual(results.length, 0);
  });

  it('returns empty for empty filesChanged', () => {
    const dir = createCorpus();
    const results = findRelatedRcas({ outputDir: dir, filesChanged: [] });
    assert.strictEqual(results.length, 0);
  });

  it('includes shared_files in results', () => {
    const dir = createCorpus();
    const results = findRelatedRcas({
      outputDir: dir,
      filesChanged: ['src/auth.js', 'src/session.js'],
    });
    const match = results.find((r) => r.shared_files.includes('src/auth.js'));
    assert.ok(match, 'should include shared_files array');
  });
});
