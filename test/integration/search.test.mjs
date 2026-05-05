import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { search, recent, show } from '../../src/search.mjs';
import { rebuildManifest } from '../../src/manifest.mjs';

function isRgAvailable() {
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const RG_AVAILABLE = isRgAvailable();
const skipIfNoRg = RG_AVAILABLE
  ? {}
  : { skip: 'rg not on PATH — install ripgrep to run search tests' };

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
      `---\ntitle: "Test RCA ${i}"\ntags: [rca, bugfix, ${tag}]\nref: abc${String(i).padStart(4, '0')}\ndate: ${yyyy}-${mm}-01\nconfidence: medium\nfiles: ["src/foo.js", "src/bar${i}.js"]\n---\n\n## Symptom\n\nFoo bar baz ${i} search-target\n\n## Root Cause\n\nSomething broke ${i}\n`,
    );
  }
}

function createFixturesWithFiles(dir) {
  // Create RCAs with specific file associations
  const subdir = join(dir, '2026', '04');
  mkdirSync(subdir, { recursive: true });

  writeFileSync(
    join(subdir, 'RCA-2026-04-25-aaa0001-foo-rca.md'),
    '---\ntitle: "Foo RCA"\nref: aaa0001\ndate: 2026-04-25\nconfidence: high\ntags: [auth]\nfiles: ["src/foo.js", "src/utils.js"]\n---\n\n## Symptom\nFoo file broke\n',
  );
  writeFileSync(
    join(subdir, 'RCA-2026-04-24-bbb0002-bar-rca.md'),
    '---\ntitle: "Bar RCA"\nref: bbb0002\ndate: 2026-04-24\nconfidence: medium\ntags: [frontend]\nfiles: ["src/bar.js"]\n---\n\n## Symptom\nBar file broke\n',
  );
  writeFileSync(
    join(subdir, 'RCA-2026-04-23-ccc0003-baz-rca.md'),
    '---\ntitle: "Baz RCA"\nref: ccc0003\ndate: 2026-04-23\nconfidence: low\ntags: [backend]\nfiles: ["src/baz.js", "src/foo.js"]\n---\n\n## Symptom\nBaz file broke\n',
  );
}

describe('search', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'claude-rca-search-'));
    createFixtures(tmp, 50);
  });

  it('finds hits for a query', skipIfNoRg, async () => {
    const results = await search({ outputDir: tmp, query: 'search-target' });
    assert.ok(results.length > 0);
    assert.ok(results[0].path);
    assert.ok(results[0].line);
    assert.ok(results[0].text.includes('search-target'));
  });

  it('returns empty for no matches', skipIfNoRg, async () => {
    const results = await search({ outputDir: tmp, query: 'zzz-nonexistent-zzz' });
    assert.strictEqual(results.length, 0);
  });

  it('filters by tag', skipIfNoRg, async () => {
    const results = await search({ outputDir: tmp, query: 'Symptom', tag: 'auth' });
    assert.ok(results.length > 0);
  });

  it('returns JSON format', skipIfNoRg, async () => {
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

describe('search --files flag', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'claude-rca-search-files-'));
    createFixturesWithFiles(tmp);
  });

  it('--files returns RCAs whose files array contains the path (substring match)', async () => {
    await rebuildManifest(tmp);
    const results = await search({ outputDir: tmp, files: 'src/foo.js' });
    assert.ok(results.length > 0, 'should return at least one result');
    // Both aaa0001 and ccc0003 have src/foo.js
    const paths = results.map((r) => r.path);
    const hasAaa = paths.some((p) => p.includes('aaa0001'));
    const hasCcc = paths.some((p) => p.includes('ccc0003'));
    assert.ok(hasAaa, 'aaa0001 RCA should be in results (has src/foo.js)');
    assert.ok(hasCcc, 'ccc0003 RCA should be in results (has src/foo.js)');
    // bbb0002 does NOT have src/foo.js
    assert.ok(!paths.some((p) => p.includes('bbb0002')), 'bbb0002 should not be in results');
  });

  it('--files with no match returns empty array', async () => {
    await rebuildManifest(tmp);
    const results = await search({ outputDir: tmp, files: 'src/does-not-exist.js' });
    assert.strictEqual(results.length, 0, 'should return empty for non-matching file');
  });

  it('--files with partial substring match works', async () => {
    await rebuildManifest(tmp);
    // "bar" is a substring of "src/bar.js"
    const results = await search({ outputDir: tmp, files: 'bar' });
    assert.ok(results.length > 0, 'should match files containing "bar"');
    const paths = results.map((r) => r.path);
    assert.ok(
      paths.some((p) => p.includes('bbb0002')),
      'bbb0002 has src/bar.js',
    );
  });

  it('--files returns empty when manifest does not exist and no rg query', async () => {
    // No rebuildManifest called — manifest missing
    const results = await search({ outputDir: tmp, files: 'src/foo.js' });
    // Without manifest, files filter cannot work — returns empty
    assert.strictEqual(results.length, 0, 'no manifest → no results for --files');
  });
});

describe('--files + query combined mode', () => {
  it('post-filters rg results by manifest files when both query and files given', async function () {
    if (!RG_AVAILABLE) {
      this.skip();
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-search-combo-'));
    try {
      createFixturesWithFiles(dir);
      await rebuildManifest(dir);

      // "Foo file" only appears in foo-rca body; foo-rca has src/foo.js in its files array
      const results = await search({ outputDir: dir, query: 'Foo file', files: 'src/foo.js' });
      assert.strictEqual(results.length, 1, `Expected 1 result, got ${results.length}`);
      assert.ok(results[0].path.includes('foo-rca'), `Expected foo-rca, got ${results[0].path}`);
    } finally {
      const { rmSync } = await import('node:fs');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty when query matches but no rca has the given files substring', async function () {
    if (!RG_AVAILABLE) {
      this.skip();
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-search-combo-empty-'));
    try {
      createFixturesWithFiles(dir);
      await rebuildManifest(dir);

      const results = await search({ outputDir: dir, query: 'broke', files: 'src/nonexistent.js' });
      assert.strictEqual(
        results.length,
        0,
        'No results when files filter matches nothing in manifest',
      );
    } finally {
      const { rmSync } = await import('node:fs');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes through all rg results when manifest is absent', async function () {
    if (!RG_AVAILABLE) {
      this.skip();
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-search-combo-nomanifest-'));
    try {
      createFixturesWithFiles(dir);
      // deliberately do NOT call rebuildManifest — no manifest file

      const results = await search({ outputDir: dir, query: 'broke', files: 'src/foo.js' });
      // Without manifest, files filter is skipped — rg returns all matches for 'broke'
      assert.ok(results.length > 0, 'Should return rg results when manifest absent');
    } finally {
      const { rmSync } = await import('node:fs');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('search --tag uses manifest (no rg for tag-only queries)', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'claude-rca-tag-manifest-'));
    createFixturesWithFiles(tmp);
  });

  it('--tag with no query uses manifest for filtering and returns manifest entries', async () => {
    await rebuildManifest(tmp);
    const results = await search({ outputDir: tmp, tag: 'auth' });
    assert.ok(results.length > 0, 'should return results for auth tag');
    // All returned results should have auth in their path or data
    const paths = results.map((r) => r.path);
    // aaa0001 has auth tag
    assert.ok(
      paths.some((p) => p.includes('aaa0001')),
      'aaa0001 (auth) should be included',
    );
    // bbb0002 has frontend tag, not auth
    assert.ok(
      !paths.some((p) => p.includes('bbb0002')),
      'bbb0002 (frontend) should not be included',
    );
  });

  it('--tag with no match returns empty', async () => {
    await rebuildManifest(tmp);
    const results = await search({ outputDir: tmp, tag: 'zzz-no-such-tag' });
    assert.strictEqual(results.length, 0, 'nonexistent tag should return empty');
  });

  it('--since with no query uses manifest for filtering by date', async () => {
    await rebuildManifest(tmp);
    // aaa0001: 2026-04-25, bbb0002: 2026-04-24, ccc0003: 2026-04-23
    const results = await search({ outputDir: tmp, since: '2026-04-25' });
    assert.ok(results.length > 0, 'since filter should return results');
    const paths = results.map((r) => r.path);
    // only aaa0001 on 2026-04-25 should pass
    assert.ok(
      paths.some((p) => p.includes('aaa0001')),
      'aaa0001 should be included (on since date)',
    );
    assert.ok(
      !paths.some((p) => p.includes('bbb0002')),
      'bbb0002 should be excluded (before since)',
    );
    assert.ok(
      !paths.some((p) => p.includes('ccc0003')),
      'ccc0003 should be excluded (before since)',
    );
  });

  it('--tag without query works even when rg is not on PATH', async () => {
    await rebuildManifest(tmp);
    const origPath = process.env.PATH;
    process.env.PATH = '';
    try {
      // Manifest-only mode must not invoke rg — blanking PATH would cause rg to fail
      const results = await search({ outputDir: tmp, tag: 'auth' });
      assert.ok(results.length > 0, 'tag-only search should succeed without rg');
      const paths = results.map((r) => r.path);
      assert.ok(
        paths.some((p) => p.includes('aaa0001')),
        'aaa0001 (auth tag) should be in results',
      );
    } finally {
      process.env.PATH = origPath;
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
