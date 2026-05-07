import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findRelatedRcas,
  readPriorRcas,
  readPriorRcasFromManifest,
  readPriorRcasFromDisk,
  detectRecurrences,
} from '../../src/dedup.mjs';

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

// ---------------------------------------------------------------------------
// Helpers for readPriorRcas and detectRecurrences tests
// ---------------------------------------------------------------------------

function createPriorRcaCorpus({ withRootCause = true, longRootCause = false } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'claude-rca-prior-'));
  mkdirSync(join(tmp, '2026', '04'), { recursive: true });

  const rootCauseBody = longRootCause
    ? 'x'.repeat(600)
    : 'The session loader returned undefined when the cookie domain mismatched.';

  const rca1 = withRootCause
    ? `---\ntitle: "Auth session fix"\ndate: "2026-04-20"\nref: abc1234\nfiles:\n  - src/auth.js\n  - src/session.js\ntags: [rca]\n---\n\n## Symptom\nBroken auth\n\n## Root Cause\n\n${rootCauseBody}\n\n## Fix\nAdded null check.\n`
    : `---\ntitle: "Auth session fix"\ndate: "2026-04-20"\nref: abc1234\nfiles:\n  - src/auth.js\n  - src/session.js\ntags: [rca]\n---\n\n## Symptom\nBroken auth\n\n## Fix\nAdded null check.\n`;

  writeFileSync(join(tmp, '2026', '04', 'RCA-auth.md'), rca1);

  const rca2 = `---\ntitle: "Session null pointer"\ndate: "2026-04-15"\nref: def5678\nfiles:\n  - src/session.js\n  - src/middleware.js\ntags: [rca]\n---\n\n## Symptom\nCrash on login\n\n## Root Cause\n\nMiddleware dereferences session before null check.\n\n## Fix\nAdded guard.\n`;
  writeFileSync(join(tmp, '2026', '04', 'RCA-session.md'), rca2);

  const rca3 = `---\ntitle: "DB timeout"\ndate: "2026-04-10"\nref: ghi9012\nfiles:\n  - src/db.js\ntags: [rca]\n---\n\n## Symptom\nSlow queries\n\n## Root Cause\n\nMissing index on user_id column.\n\n## Fix\nAdded index.\n`;
  writeFileSync(join(tmp, '2026', '04', 'RCA-db.md'), rca3);

  // Extra RCAs to test limit=3 default (4th and 5th with session.js overlap)
  const rca4 = `---\ntitle: "Session leak"\ndate: "2026-04-05"\nref: jkl3456\nfiles:\n  - src/session.js\ntags: [rca]\n---\n\n## Symptom\nMemory leak\n\n## Root Cause\n\nSessions not destroyed on logout.\n\n## Fix\nCall destroy().\n`;
  writeFileSync(join(tmp, '2026', '04', 'RCA-leak.md'), rca4);

  return tmp;
}

function createManifestCorpus(entries = []) {
  const tmp = mkdtempSync(join(tmpdir(), 'claude-rca-manifest-'));
  const lines = [
    '# Auto-generated by claude-rca. Do not edit manually.',
    `# Updated: 2026-04-25T00:00:00.000Z`,
    `# Count: ${entries.length}`,
    ...entries.map((e) => JSON.stringify(e)),
  ];
  writeFileSync(join(tmp, '_manifest.jsonl'), lines.join('\n') + '\n');
  return tmp;
}

// ---------------------------------------------------------------------------
// readPriorRcas
// ---------------------------------------------------------------------------

describe('readPriorRcas', () => {
  it('returns empty for no related RCAs', () => {
    const dir = createPriorRcaCorpus();
    const results = readPriorRcas({ outputDir: dir, filesChanged: ['src/payments.js'] });
    assert.strictEqual(results.length, 0);
  });

  it('returns root_cause text from related RCA files', () => {
    const dir = createPriorRcaCorpus();
    const results = readPriorRcas({
      outputDir: dir,
      filesChanged: ['src/auth.js', 'src/session.js'],
    });
    assert.ok(results.length >= 1, 'should return at least one result');
    const first = results[0];
    assert.ok(
      typeof first.root_cause === 'string' && first.root_cause.length > 0,
      'root_cause should be a non-empty string',
    );
    assert.ok(
      first.root_cause.includes('session loader') || first.root_cause.includes('dereferences'),
      `root_cause should contain expected text, got: ${first.root_cause}`,
    );
  });

  it('truncates root_cause to 500 chars', () => {
    const dir = createPriorRcaCorpus({ longRootCause: true });
    const results = readPriorRcas({
      outputDir: dir,
      filesChanged: ['src/auth.js', 'src/session.js'],
    });
    assert.ok(results.length >= 1, 'should return at least one result');
    assert.ok(
      results[0].root_cause.length <= 500,
      `root_cause should be truncated to 500 chars, got ${results[0].root_cause.length}`,
    );
  });

  it('limits results to the limit param (default 3)', () => {
    const dir = createPriorRcaCorpus();
    // src/session.js overlaps with rca1, rca2, rca4 (3 files) — all have >50% overlap with ['src/session.js']
    // With filesChanged=['src/session.js'], overlap_score = 1/1 = 1.0 for all three with session.js
    const resultsDefault = readPriorRcas({ outputDir: dir, filesChanged: ['src/session.js'] });
    assert.ok(
      resultsDefault.length <= 3,
      `default limit should be 3, got ${resultsDefault.length}`,
    );

    const resultsLimit1 = readPriorRcas({
      outputDir: dir,
      filesChanged: ['src/session.js'],
      limit: 1,
    });
    assert.strictEqual(resultsLimit1.length, 1, 'limit:1 should return exactly 1 result');
  });

  it('returns title, root_cause, date, files per entry', () => {
    const dir = createPriorRcaCorpus();
    const results = readPriorRcas({
      outputDir: dir,
      filesChanged: ['src/auth.js', 'src/session.js'],
    });
    assert.ok(results.length >= 1);
    const entry = results[0];
    assert.ok(typeof entry.title === 'string', 'title should be a string');
    assert.ok(typeof entry.root_cause === 'string', 'root_cause should be a string');
    assert.ok(typeof entry.date === 'string', 'date should be a string');
    assert.ok(Array.isArray(entry.files), 'files should be an array');
  });
});

// ---------------------------------------------------------------------------
// detectRecurrences
// ---------------------------------------------------------------------------

describe('detectRecurrences', () => {
  it('returns empty when manifest is empty', () => {
    const dir = createManifestCorpus([]);
    const results = detectRecurrences({ outputDir: dir, filesChanged: ['src/auth.js'] });
    assert.strictEqual(results.length, 0);
  });

  it('returns entries sharing files with filesChanged', () => {
    const dir = createManifestCorpus([
      {
        id: 'RCA-2026-04-20-abc1234',
        title: 'Auth fix',
        date: '2026-04-20',
        files: ['src/auth.js', 'src/session.js'],
      },
      {
        id: 'RCA-2026-04-15-def5678',
        title: 'DB timeout',
        date: '2026-04-15',
        files: ['src/db.js'],
      },
    ]);
    const results = detectRecurrences({ outputDir: dir, filesChanged: ['src/auth.js'] });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].id, 'RCA-2026-04-20-abc1234');
  });

  it('does not return entries with no overlapping files', () => {
    const dir = createManifestCorpus([
      {
        id: 'RCA-2026-04-15-def5678',
        title: 'DB timeout',
        date: '2026-04-15',
        files: ['src/db.js'],
      },
    ]);
    const results = detectRecurrences({ outputDir: dir, filesChanged: ['src/auth.js'] });
    assert.strictEqual(results.length, 0);
  });

  it('returns max 5 entries', () => {
    const entries = Array.from({ length: 8 }, (_, i) => ({
      id: `RCA-2026-0${(i % 9) + 1}-01-abc${i}`,
      title: `Bug ${i}`,
      date: `2026-0${(i % 9) + 1}-01`,
      files: ['src/auth.js'],
    }));
    const dir = createManifestCorpus(entries);
    const results = detectRecurrences({ outputDir: dir, filesChanged: ['src/auth.js'] });
    assert.ok(results.length <= 5, `should return max 5 entries, got ${results.length}`);
  });

  it('sorts by date descending', () => {
    const dir = createManifestCorpus([
      { id: 'RCA-2026-04-01-aaa', title: 'Old', date: '2026-04-01', files: ['src/auth.js'] },
      { id: 'RCA-2026-04-20-bbb', title: 'New', date: '2026-04-20', files: ['src/auth.js'] },
      { id: 'RCA-2026-04-10-ccc', title: 'Mid', date: '2026-04-10', files: ['src/auth.js'] },
    ]);
    const results = detectRecurrences({ outputDir: dir, filesChanged: ['src/auth.js'] });
    assert.strictEqual(results[0].date, '2026-04-20', 'first result should be most recent');
    assert.strictEqual(results[1].date, '2026-04-10');
    assert.strictEqual(results[2].date, '2026-04-01');
  });

  it('returns id, title, date per entry', () => {
    const dir = createManifestCorpus([
      {
        id: 'RCA-2026-04-20-abc1234',
        title: 'Auth fix',
        date: '2026-04-20',
        files: ['src/auth.js'],
      },
    ]);
    const results = detectRecurrences({ outputDir: dir, filesChanged: ['src/auth.js'] });
    assert.strictEqual(results.length, 1);
    const entry = results[0];
    assert.strictEqual(entry.id, 'RCA-2026-04-20-abc1234');
    assert.strictEqual(entry.title, 'Auth fix');
    assert.strictEqual(entry.date, '2026-04-20');
    // Should NOT include extra keys like files
    assert.strictEqual(Object.keys(entry).length, 3, 'entry should have exactly id, title, date');
  });
});

// ---------------------------------------------------------------------------
// Helpers for readPriorRcasFromManifest tests
// ---------------------------------------------------------------------------

/**
 * Creates a manifest-only corpus — no .md files on disk.
 * Entries with root_cause_snippet will be served from manifest.
 * Entries without snippet (or with path pointing to missing file) test fallback.
 */
function createManifestOnlyCorpus(entries) {
  const tmp = mkdtempSync(join(tmpdir(), 'claude-rca-manifest-only-'));
  const lines = [
    '# Auto-generated by claude-rca. Do not edit manually.',
    `# Updated: 2026-04-25T00:00:00.000Z`,
    `# Count: ${entries.length}`,
    ...entries.map((e) => JSON.stringify(e)),
  ];
  writeFileSync(join(tmp, '_manifest.jsonl'), lines.join('\n') + '\n');
  return tmp;
}

/**
 * Creates a manifest corpus where some entries DO have matching .md files on disk.
 * Used for the "falls back to file read when snippet absent" test.
 */
function createManifestWithFiles(entries) {
  const tmp = mkdtempSync(join(tmpdir(), 'claude-rca-manifest-files-'));
  mkdirSync(join(tmp, '2026', '04'), { recursive: true });

  for (const entry of entries) {
    if (entry._fileContent) {
      writeFileSync(join(tmp, entry.path), entry._fileContent);
    }
  }

  // Strip _fileContent before writing manifest
  const manifestEntries = entries.map(({ _fileContent: _, ...e }) => e);
  const lines = [
    '# Auto-generated by claude-rca. Do not edit manually.',
    `# Updated: 2026-04-25T00:00:00.000Z`,
    `# Count: ${manifestEntries.length}`,
    ...manifestEntries.map((e) => JSON.stringify(e)),
  ];
  writeFileSync(join(tmp, '_manifest.jsonl'), lines.join('\n') + '\n');
  return tmp;
}

// ---------------------------------------------------------------------------
// readPriorRcasFromManifest
// ---------------------------------------------------------------------------

describe('readPriorRcasFromManifest', () => {
  it('uses root_cause_snippet from manifest — does not read RCA files', () => {
    // Build manifest entries whose .md files DO NOT exist on disk.
    // If function tries to read the files, it would either error or return empty.
    // Success = returns data matching the snippet without any file present.
    const dir = createManifestOnlyCorpus([
      {
        id: 'RCA-2026-04-20-abc1',
        title: 'Auth session fix',
        date: '2026-04-20',
        files: ['src/auth.js', 'src/session.js'],
        root_cause_snippet: 'Session loader returned undefined on cookie domain mismatch.',
        fix_snippet: 'Added null check.',
        path: '2026/04/RCA-auth.md', // file does NOT exist
      },
    ]);
    const results = readPriorRcasFromManifest({
      outputDir: dir,
      filesChanged: ['src/auth.js', 'src/session.js'],
    });
    assert.strictEqual(results.length, 1, 'should return 1 result');
    assert.strictEqual(results[0].title, 'Auth session fix');
    assert.strictEqual(
      results[0].root_cause,
      'Session loader returned undefined on cookie domain mismatch.',
    );
    assert.strictEqual(results[0].date, '2026-04-20');
    assert.deepEqual(results[0].files, ['src/auth.js', 'src/session.js']);
  });

  it('falls back to file read when root_cause_snippet is empty string', () => {
    const dir = createManifestWithFiles([
      {
        id: 'RCA-2026-04-20-abc1',
        title: 'Auth session fix',
        date: '2026-04-20',
        files: ['src/auth.js', 'src/session.js'],
        root_cause_snippet: '', // empty — trigger fallback
        fix_snippet: '',
        path: '2026/04/RCA-auth.md',
        _fileContent:
          '---\ntitle: "Auth session fix"\ndate: "2026-04-20"\nref: abc1\nfiles:\n  - src/auth.js\n  - src/session.js\n---\n\n## Root Cause\n\nThe middleware dereferenced session before null check.\n\n## Fix\nAdded guard.\n',
      },
    ]);
    const results = readPriorRcasFromManifest({
      outputDir: dir,
      filesChanged: ['src/auth.js', 'src/session.js'],
    });
    assert.strictEqual(results.length, 1);
    assert.ok(
      results[0].root_cause.includes('middleware') ||
        results[0].root_cause.includes('dereferenced') ||
        results[0].root_cause.includes('null check'),
      `expected root_cause from file fallback, got: ${results[0].root_cause}`,
    );
  });

  it('respects the limit parameter', () => {
    const entries = [
      {
        id: 'RCA-2026-04-20-a1',
        title: 'Bug A',
        date: '2026-04-20',
        files: ['src/auth.js'],
        root_cause_snippet: 'Cause A',
        fix_snippet: 'Fix A',
        path: '2026/04/RCA-a.md',
      },
      {
        id: 'RCA-2026-04-19-b2',
        title: 'Bug B',
        date: '2026-04-19',
        files: ['src/auth.js'],
        root_cause_snippet: 'Cause B',
        fix_snippet: 'Fix B',
        path: '2026/04/RCA-b.md',
      },
      {
        id: 'RCA-2026-04-18-c3',
        title: 'Bug C',
        date: '2026-04-18',
        files: ['src/auth.js'],
        root_cause_snippet: 'Cause C',
        fix_snippet: 'Fix C',
        path: '2026/04/RCA-c.md',
      },
      {
        id: 'RCA-2026-04-17-d4',
        title: 'Bug D',
        date: '2026-04-17',
        files: ['src/auth.js'],
        root_cause_snippet: 'Cause D',
        fix_snippet: 'Fix D',
        path: '2026/04/RCA-d.md',
      },
    ];
    const dir = createManifestOnlyCorpus(entries);

    const resultsDefault = readPriorRcasFromManifest({
      outputDir: dir,
      filesChanged: ['src/auth.js'],
    });
    assert.ok(resultsDefault.length <= 3, `default limit should be ≤3, got ${resultsDefault.length}`);

    const resultsLimit1 = readPriorRcasFromManifest({
      outputDir: dir,
      filesChanged: ['src/auth.js'],
      limit: 1,
    });
    assert.strictEqual(resultsLimit1.length, 1, 'limit:1 should return exactly 1 result');

    const resultsLimit2 = readPriorRcasFromManifest({
      outputDir: dir,
      filesChanged: ['src/auth.js'],
      limit: 2,
    });
    assert.strictEqual(resultsLimit2.length, 2, 'limit:2 should return exactly 2 results');
  });

  it('filters by file overlap > 50%', () => {
    const dir = createManifestOnlyCorpus([
      {
        id: 'RCA-2026-04-20-a1',
        title: 'High overlap',
        date: '2026-04-20',
        files: ['src/auth.js', 'src/session.js', 'src/helper.js'],
        root_cause_snippet: 'High overlap cause',
        fix_snippet: 'Fix',
        path: '2026/04/RCA-a.md',
      },
      {
        id: 'RCA-2026-04-19-b2',
        title: 'Low overlap',
        date: '2026-04-19',
        files: ['src/db.js', 'src/cache.js', 'src/other.js'],
        root_cause_snippet: 'Low overlap cause',
        fix_snippet: 'Fix',
        path: '2026/04/RCA-b.md',
      },
    ]);
    // filesChanged has 2 items: ['src/auth.js', 'src/session.js']
    // entry A shares 2/2 = 1.0 → included
    // entry B shares 0/2 = 0.0 → excluded
    const results = readPriorRcasFromManifest({
      outputDir: dir,
      filesChanged: ['src/auth.js', 'src/session.js'],
    });
    assert.strictEqual(results.length, 1, 'should only include entry with >50% overlap');
    assert.strictEqual(results[0].title, 'High overlap');
  });

  it('returns empty array when manifest is empty', () => {
    // Fresh tmpdir with no files at all — loadManifest returns [] → fallback to disk
    // Disk also has no .md files → disk function returns [] too
    const tmp = mkdtempSync(join(tmpdir(), 'claude-rca-empty-'));
    const results = readPriorRcasFromManifest({
      outputDir: tmp,
      filesChanged: ['src/auth.js'],
    });
    assert.strictEqual(results.length, 0, 'empty manifest should return empty array');
  });

  it('returns empty array when filesChanged is empty', () => {
    const dir = createManifestOnlyCorpus([
      {
        id: 'RCA-2026-04-20-a1',
        title: 'Auth fix',
        date: '2026-04-20',
        files: ['src/auth.js'],
        root_cause_snippet: 'Some cause',
        fix_snippet: 'Fix',
        path: '2026/04/RCA-a.md',
      },
    ]);
    const results = readPriorRcasFromManifest({
      outputDir: dir,
      filesChanged: [],
    });
    assert.strictEqual(results.length, 0, 'empty filesChanged should return empty array');
  });

  it('sorts by overlap score descending', () => {
    // Entry A shares 2/2 files = 1.0 score
    // Entry B shares 1/2 files = 0.5 (not >0.5, should be excluded)
    // Entry C shares 2/2 files = 1.0, older date — should tie-break after A
    const dir = createManifestOnlyCorpus([
      {
        id: 'RCA-2026-04-15-c3',
        title: 'Full overlap older',
        date: '2026-04-15',
        files: ['src/auth.js', 'src/session.js'],
        root_cause_snippet: 'Cause C older',
        fix_snippet: 'Fix',
        path: '2026/04/RCA-c.md',
      },
      {
        id: 'RCA-2026-04-20-a1',
        title: 'Full overlap newer',
        date: '2026-04-20',
        files: ['src/auth.js', 'src/session.js'],
        root_cause_snippet: 'Cause A newer',
        fix_snippet: 'Fix',
        path: '2026/04/RCA-a.md',
      },
    ]);
    const results = readPriorRcasFromManifest({
      outputDir: dir,
      filesChanged: ['src/auth.js', 'src/session.js'],
    });
    assert.ok(results.length >= 2, 'should return at least 2 results');
    // Both have score 1.0, tie-break by date descending
    assert.strictEqual(results[0].date, '2026-04-20', 'newer date should sort first on tie');
    assert.strictEqual(results[1].date, '2026-04-15');
  });
});

// ---------------------------------------------------------------------------
// readPriorRcasFromDisk (the renamed original function)
// ---------------------------------------------------------------------------

describe('readPriorRcasFromDisk', () => {
  it('is exported and returns disk-based results like original readPriorRcas', () => {
    const dir = createPriorRcaCorpus();
    const results = readPriorRcasFromDisk({
      outputDir: dir,
      filesChanged: ['src/auth.js', 'src/session.js'],
    });
    assert.ok(results.length >= 1, 'should return at least one result');
    assert.ok(typeof results[0].root_cause === 'string');
    assert.ok(results[0].root_cause.length > 0);
  });
});
