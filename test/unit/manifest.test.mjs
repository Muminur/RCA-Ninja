import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { rebuildManifest, loadManifest, generateLlmsTxt } from '../../src/manifest.mjs';

function writeRca(dir, filename, frontmatter, body = 'body text') {
  const fmLines = Object.entries(frontmatter).map(([k, v]) => {
    if (Array.isArray(v)) {
      if (v.length === 0) return `${k}: []`;
      return `${k}: [${v.join(', ')}]`;
    }
    return `${k}: ${v}`;
  });
  const content = `---\n${fmLines.join('\n')}\n---\n\n${body}\n`;
  writeFileSync(join(dir, filename), content, 'utf8');
}

describe('rebuildManifest', () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claude-rca-manifest-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generates _manifest.jsonl format (each non-comment line is valid JSON)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-mgen-'));
    try {
      writeRca(dir, 'RCA-2026-04-25-abc1234-foo.md', {
        title: '"Foo bug"',
        date: '2026-04-25T10:00:00Z',
        ref: 'abc1234',
        confidence: 'high',
        tags: ['auth', 'backend'],
        files: ['src/foo.js'],
      });

      const manifestPath = await rebuildManifest(dir);
      assert.ok(existsSync(manifestPath), '_manifest.jsonl should exist');
      assert.ok(manifestPath.endsWith('_manifest.jsonl'), 'should be .jsonl extension');

      const raw = readFileSync(manifestPath, 'utf8');
      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      const dataLines = lines.filter((l) => !l.startsWith('#'));

      assert.ok(dataLines.length > 0, 'should have at least one data line');
      for (const line of dataLines) {
        assert.doesNotThrow(() => JSON.parse(line), `Line should be valid JSON: ${line}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rebuildManifest output is parseable line-by-line with JSON.parse', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-jsonl-parse-'));
    try {
      writeRca(dir, 'RCA-2026-04-25-abc1234-foo.md', {
        title: '"Foo bug"',
        date: '2026-04-25T10:00:00Z',
        ref: 'abc1234',
        confidence: 'high',
        tags: ['auth', 'backend'],
        files: ['src/foo.js'],
      });
      writeRca(dir, 'RCA-2026-04-24-def5678-bar.md', {
        title: '"Bar bug"',
        date: '2026-04-24T10:00:00Z',
        ref: 'def5678',
        confidence: 'medium',
        tags: ['frontend'],
        files: ['src/bar.js'],
      });

      const manifestPath = await rebuildManifest(dir);
      const raw = readFileSync(manifestPath, 'utf8');
      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      const dataLines = lines.filter((l) => !l.startsWith('#'));

      // Both RCAs should parse as JSON objects
      assert.strictEqual(dataLines.length, 2, 'should have exactly 2 JSON data lines');
      const entries = dataLines.map((l) => JSON.parse(l));
      const refs = entries.map((e) => e.ref);
      assert.ok(refs.includes('abc1234'), 'abc1234 should be in parsed entries');
      assert.ok(refs.includes('def5678'), 'def5678 should be in parsed entries');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('comment lines start with # (JSONL readers skip them)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-comments-'));
    try {
      const manifestPath = await rebuildManifest(dir);
      const raw = readFileSync(manifestPath, 'utf8');
      const commentLines = raw.split('\n').filter((l) => l.trim().length > 0 && l.startsWith('#'));
      assert.ok(commentLines.length > 0, 'should have comment lines starting with #');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty manifest (no JSON data lines) for empty directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-empty-'));
    try {
      const manifestPath = await rebuildManifest(dir);
      assert.ok(existsSync(manifestPath), '_manifest.jsonl should exist even when empty');
      assert.ok(manifestPath.endsWith('_manifest.jsonl'), 'path should end with _manifest.jsonl');
      const raw = readFileSync(manifestPath, 'utf8');
      const dataLines = raw.split('\n').filter((l) => l.trim().length > 0 && !l.startsWith('#'));
      assert.strictEqual(dataLines.length, 0, 'empty dir produces no JSON data lines');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips files without valid frontmatter (missing title)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-skip-'));
    try {
      // Valid file
      writeRca(dir, 'RCA-2026-04-25-abc1234-good.md', {
        title: '"Good RCA"',
        date: '2026-04-25T10:00:00Z',
        ref: 'abc1234',
        confidence: 'high',
        tags: [],
        files: [],
      });
      // Missing title
      writeRca(dir, 'RCA-2026-04-24-def5678-bad.md', {
        date: '2026-04-24T10:00:00Z',
        ref: 'def5678',
        confidence: 'high',
        tags: [],
        files: [],
      });

      const manifestPath = await rebuildManifest(dir);
      const raw = readFileSync(manifestPath, 'utf8');
      const dataLines = raw.split('\n').filter((l) => !l.startsWith('#') && l.trim().length > 0);
      const entries = dataLines.map((l) => JSON.parse(l));
      const refs = entries.map((e) => e.ref);
      assert.ok(refs.includes('abc1234'), 'valid file should be in manifest');
      assert.ok(!refs.includes('def5678'), 'file missing title should be skipped');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips files without valid frontmatter (missing ref)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-skipref-'));
    try {
      // Valid file
      writeRca(dir, 'RCA-2026-04-25-abc1234-good.md', {
        title: '"Good RCA"',
        date: '2026-04-25T10:00:00Z',
        ref: 'abc1234',
        confidence: 'high',
        tags: [],
        files: [],
      });
      // Missing ref
      writeRca(dir, 'RCA-2026-04-24-noref-bad.md', {
        title: '"No Ref RCA"',
        date: '2026-04-24T10:00:00Z',
        confidence: 'high',
        tags: [],
        files: [],
      });

      const manifestPath = await rebuildManifest(dir);
      const raw = readFileSync(manifestPath, 'utf8');
      const dataLines = raw.split('\n').filter((l) => !l.startsWith('#') && l.trim().length > 0);
      const entries = dataLines.map((l) => JSON.parse(l));
      const refs = entries.map((e) => e.ref);
      assert.ok(refs.includes('abc1234'), 'valid file should be in manifest');
      assert.ok(!refs.some((r) => r === undefined), 'no undefined refs expected');
      // Verify "No Ref RCA" not in manifest
      const titles = entries.map((e) => e.title);
      assert.ok(!titles.includes('No Ref RCA'), 'file missing ref should be skipped');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sorts entries by date descending', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-sort-'));
    try {
      writeRca(dir, 'RCA-2026-01-10-aaa1111-oldest.md', {
        title: '"Oldest Bug"',
        date: '2026-01-10T00:00:00Z',
        ref: 'aaa1111',
        confidence: 'low',
        tags: [],
        files: [],
      });
      writeRca(dir, 'RCA-2026-03-15-bbb2222-middle.md', {
        title: '"Middle Bug"',
        date: '2026-03-15T00:00:00Z',
        ref: 'bbb2222',
        confidence: 'medium',
        tags: [],
        files: [],
      });
      writeRca(dir, 'RCA-2026-05-01-ccc3333-newest.md', {
        title: '"Newest Bug"',
        date: '2026-05-01T00:00:00Z',
        ref: 'ccc3333',
        confidence: 'high',
        tags: [],
        files: [],
      });

      const manifestPath = await rebuildManifest(dir);
      const raw = readFileSync(manifestPath, 'utf8');
      const dataLines = raw.split('\n').filter((l) => !l.startsWith('#') && l.trim().length > 0);
      const entries = dataLines.map((l) => JSON.parse(l));
      const refs = entries.map((e) => e.ref);
      assert.strictEqual(refs[0], 'ccc3333', 'newest should be first');
      assert.strictEqual(refs[1], 'bbb2222', 'middle should be second');
      assert.strictEqual(refs[2], 'aaa1111', 'oldest should be last');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('includes components and description when present in frontmatter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-extras-'));
    try {
      const content =
        '---\n' +
        'title: "Rich RCA"\n' +
        'date: 2026-04-25T10:00:00Z\n' +
        'ref: rich1234\n' +
        'confidence: high\n' +
        'tags: [backend]\n' +
        'files: [src/foo.js]\n' +
        'components: [auth-service, session-service]\n' +
        'description: "A detailed description of this RCA"\n' +
        '---\n\n## Symptom\n\nTest body.\n';
      writeFileSync(join(dir, 'RCA-2026-04-25-rich1234-rich-rca.md'), content, 'utf8');

      const manifestPath = await rebuildManifest(dir);
      const raw = readFileSync(manifestPath, 'utf8');
      const dataLines = raw.split('\n').filter((l) => !l.startsWith('#') && l.trim().length > 0);
      assert.strictEqual(dataLines.length, 1);
      const entry = JSON.parse(dataLines[0]);
      assert.ok(Array.isArray(entry.components), 'components should be an array');
      assert.ok(entry.components.includes('auth-service'), 'should include auth-service');
      assert.ok(entry.description, 'should include description');
      assert.ok(entry.description.includes('A detailed description'), 'description text correct');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips files starting with _ (like _manifest.jsonl itself)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-underscore-'));
    try {
      // Write a valid RCA
      writeRca(dir, 'RCA-2026-04-25-abc9999-real.md', {
        title: '"Real RCA"',
        date: '2026-04-25T10:00:00Z',
        ref: 'abc9999',
        confidence: 'high',
        tags: [],
        files: [],
      });
      // Write a _ prefixed file that should be skipped
      writeFileSync(join(dir, '_manifest.jsonl'), 'should be ignored\n', 'utf8');

      const manifestPath = await rebuildManifest(dir);
      const raw = readFileSync(manifestPath, 'utf8');
      const dataLines = raw.split('\n').filter((l) => !l.startsWith('#') && l.trim().length > 0);
      const entries = dataLines.map((l) => JSON.parse(l));
      const refs = entries.map((e) => e.ref);
      assert.ok(refs.includes('abc9999'), 'real RCA should be in manifest');
      assert.strictEqual(dataLines.length, 1, 'only one entry should be in manifest');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('walks subdirectories recursively', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-recurse-'));
    try {
      const subDir = join(dir, '2026', '04');
      mkdirSync(subDir, { recursive: true });
      writeRca(subDir, 'RCA-2026-04-25-sub1234-sub.md', {
        title: '"Sub RCA"',
        date: '2026-04-25T10:00:00Z',
        ref: 'sub1234',
        confidence: 'high',
        tags: [],
        files: [],
      });

      const manifestPath = await rebuildManifest(dir);
      const raw = readFileSync(manifestPath, 'utf8');
      const dataLines = raw.split('\n').filter((l) => !l.startsWith('#') && l.trim().length > 0);
      const entries = dataLines.map((l) => JSON.parse(l));
      assert.ok(
        entries.some((e) => e.ref === 'sub1234'),
        'files in subdirectories should be included',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the path to _manifest.jsonl', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-path-'));
    try {
      const manifestPath = await rebuildManifest(dir);
      assert.ok(
        manifestPath.endsWith('_manifest.jsonl'),
        'returned path should end with _manifest.jsonl',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('each JSON entry contains required fields: id, ref, title, date, tags, files, path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-fields-'));
    try {
      writeRca(dir, 'RCA-2026-04-25-abc1234-foo.md', {
        title: '"Foo bug"',
        date: '2026-04-25T10:00:00Z',
        ref: 'abc1234',
        confidence: 'high',
        tags: ['auth'],
        files: ['src/foo.js'],
      });

      const manifestPath = await rebuildManifest(dir);
      const raw = readFileSync(manifestPath, 'utf8');
      const dataLines = raw.split('\n').filter((l) => !l.startsWith('#') && l.trim().length > 0);
      const entry = JSON.parse(dataLines[0]);

      assert.ok('id' in entry, 'entry has id');
      assert.ok('ref' in entry, 'entry has ref');
      assert.ok('title' in entry, 'entry has title');
      assert.ok('date' in entry, 'entry has date');
      assert.ok('tags' in entry, 'entry has tags');
      assert.ok('files' in entry, 'entry has files');
      assert.ok('path' in entry, 'entry has path');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles non-existent outputDir gracefully (walk catch)', async () => {
    const nonExistentDir = join(tmpdir(), 'claude-rca-manifest-nodir-' + Date.now());
    const manifestPath = await rebuildManifest(nonExistentDir);
    assert.ok(manifestPath.endsWith('_manifest.jsonl'), 'should return manifest path');
    const raw = readFileSync(manifestPath, 'utf8');
    const dataLines = raw.split('\n').filter((l) => !l.startsWith('#') && l.trim().length > 0);
    assert.strictEqual(dataLines.length, 0, 'non-existent dir should produce empty manifest');
    rmSync(nonExistentDir, { recursive: true, force: true });
  });

  it('toDateString uses raw string when date is not ISO format', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-manifest-date-'));
    try {
      writeFileSync(
        join(dir, 'RCA-2026-01-01-abc9999-test.md'),
        '---\ntitle: "Date string test"\nref: abc9999\ndate: not-a-date\nconfidence: high\ntags: []\nfiles: []\n---\n\n## Symptom\nTest\n',
        'utf8',
      );
      const manifestPath = await rebuildManifest(dir);
      const raw = readFileSync(manifestPath, 'utf8');
      const dataLines = raw.split('\n').filter((l) => !l.startsWith('#') && l.trim().length > 0);
      assert.ok(dataLines.length > 0, 'should have an entry for the RCA');
      const entry = JSON.parse(dataLines[0]);
      assert.ok(typeof entry.date === 'string', 'date should be a string');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('includes root_cause_snippet (first 200 chars of ## Root Cause section)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-manifest-rootcause-'));
    try {
      const longCause = 'A'.repeat(300);
      const content =
        '---\ntitle: "RCA with root cause"\nref: rc1234\ndate: 2026-04-25T10:00:00Z\n' +
        'confidence: high\ntags: [auth]\nfiles: [src/foo.js]\n---\n\n' +
        '## Symptom\n\nSomething broke.\n\n' +
        `## Root Cause\n\n${longCause}\n\n` +
        '## Fix\n\nFixed it.\n';
      writeFileSync(join(dir, 'RCA-2026-04-25-rc1234-root-cause.md'), content, 'utf8');

      const manifestPath = await rebuildManifest(dir);
      const raw = readFileSync(manifestPath, 'utf8');
      const dataLines = raw.split('\n').filter((l) => !l.startsWith('#') && l.trim().length > 0);
      const entry = JSON.parse(dataLines[0]);

      assert.ok('root_cause_snippet' in entry, 'entry should have root_cause_snippet');
      assert.ok(typeof entry.root_cause_snippet === 'string', 'root_cause_snippet should be a string');
      assert.ok(entry.root_cause_snippet.length <= 200, 'root_cause_snippet should be at most 200 chars');
      assert.ok(entry.root_cause_snippet.startsWith('A'), 'root_cause_snippet should start with the root cause text');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('includes fix_snippet (first 150 chars of ## Fix section)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-manifest-fix-'));
    try {
      const longFix = 'B'.repeat(300);
      const content =
        '---\ntitle: "RCA with fix"\nref: fx1234\ndate: 2026-04-25T10:00:00Z\n' +
        'confidence: high\ntags: [auth]\nfiles: [src/foo.js]\n---\n\n' +
        '## Symptom\n\nSomething broke.\n\n' +
        '## Root Cause\n\nSome cause.\n\n' +
        `## Fix\n\n${longFix}\n`;
      writeFileSync(join(dir, 'RCA-2026-04-25-fx1234-fix.md'), content, 'utf8');

      const manifestPath = await rebuildManifest(dir);
      const raw = readFileSync(manifestPath, 'utf8');
      const dataLines = raw.split('\n').filter((l) => !l.startsWith('#') && l.trim().length > 0);
      const entry = JSON.parse(dataLines[0]);

      assert.ok('fix_snippet' in entry, 'entry should have fix_snippet');
      assert.ok(typeof entry.fix_snippet === 'string', 'fix_snippet should be a string');
      assert.ok(entry.fix_snippet.length <= 150, 'fix_snippet should be at most 150 chars');
      assert.ok(entry.fix_snippet.startsWith('B'), 'fix_snippet should contain fix text');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('root_cause_snippet is empty string when ## Root Cause section is absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-manifest-norc-'));
    try {
      const content =
        '---\ntitle: "No RC"\nref: norc123\ndate: 2026-04-25T10:00:00Z\n' +
        'confidence: high\ntags: []\nfiles: []\n---\n\n## Symptom\n\nBroke.\n';
      writeFileSync(join(dir, 'RCA-2026-04-25-norc123-no-rc.md'), content, 'utf8');

      const manifestPath = await rebuildManifest(dir);
      const raw = readFileSync(manifestPath, 'utf8');
      const dataLines = raw.split('\n').filter((l) => !l.startsWith('#') && l.trim().length > 0);
      const entry = JSON.parse(dataLines[0]);

      assert.strictEqual(entry.root_cause_snippet, '', 'root_cause_snippet should be empty string when section absent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('generateLlmsTxt', () => {
  it('creates rca/llms.txt file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-llmstxt-create-'));
    try {
      const entries = [
        { id: 'RCA-2026-04-25-abc1234', title: 'Foo bug', date: '2026-04-25', path: 'RCA-2026-04-25-abc1234.md', tags: ['auth'], root_cause_snippet: 'Something broke', fix_snippet: 'Fixed it' },
      ];
      const llmsTxtPath = await generateLlmsTxt(dir, entries);
      const { existsSync: exists } = await import('node:fs');
      assert.ok(exists(llmsTxtPath), 'llms.txt should exist after generateLlmsTxt');
      assert.ok(llmsTxtPath.endsWith('llms.txt'), 'returned path should end with llms.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('llms.txt starts with # heading', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-llmstxt-heading-'));
    try {
      const entries = [
        { id: 'RCA-2026-04-25-abc1234', title: 'Foo bug', date: '2026-04-25', path: 'RCA-2026-04-25-abc1234.md', tags: [], root_cause_snippet: '', fix_snippet: '' },
      ];
      await generateLlmsTxt(dir, entries);
      const content = readFileSync(join(dir, 'llms.txt'), 'utf8');
      assert.ok(content.startsWith('# RCA Corpus —'), 'llms.txt should start with # RCA Corpus —');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('includes total RCA count', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-llmstxt-count-'));
    try {
      const entries = [
        { id: 'RCA-2026-04-25-abc1234', title: 'Foo bug', date: '2026-04-25', path: 'RCA-2026-04-25-abc1234.md', tags: [], root_cause_snippet: '', fix_snippet: '' },
        { id: 'RCA-2026-04-24-def5678', title: 'Bar bug', date: '2026-04-24', path: 'RCA-2026-04-24-def5678.md', tags: [], root_cause_snippet: '', fix_snippet: '' },
      ];
      await generateLlmsTxt(dir, entries);
      const content = readFileSync(join(dir, 'llms.txt'), 'utf8');
      assert.ok(content.includes('Total: 2 RCAs'), 'llms.txt should include total RCA count');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('includes recent RCAs section (up to 20)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-llmstxt-recent-'));
    try {
      const entries = Array.from({ length: 25 }, (_, i) => ({
        id: `RCA-2026-04-${String(25 - i).padStart(2, '0')}-ref${i}`,
        title: `Bug ${i}`,
        date: `2026-04-${String(25 - i).padStart(2, '0')}`,
        path: `RCA-ref${i}.md`,
        tags: [],
        root_cause_snippet: '',
        fix_snippet: '',
      }));
      await generateLlmsTxt(dir, entries);
      const content = readFileSync(join(dir, 'llms.txt'), 'utf8');
      assert.ok(content.includes('## Recent RCAs (latest 20)'), 'should have Recent RCAs section');
      // Count how many entry lines appear (lines starting with "- [")
      const entryLines = content.split('\n').filter((l) => l.startsWith('- ['));
      assert.ok(entryLines.length <= 20, 'should include at most 20 entries in recent section');
      assert.ok(entryLines.length > 0, 'should include at least one entry');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('each entry line starts with - [RCA-id](path): title', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-llmstxt-format-'));
    try {
      const entries = [
        { id: 'RCA-2026-04-25-abc1234', title: 'Auth bug', date: '2026-04-25', path: 'RCA-2026-04-25-abc1234.md', tags: [], root_cause_snippet: '', fix_snippet: '' },
      ];
      await generateLlmsTxt(dir, entries);
      const content = readFileSync(join(dir, 'llms.txt'), 'utf8');
      const entryLines = content.split('\n').filter((l) => l.startsWith('- ['));
      assert.ok(entryLines.length >= 1, 'should have at least one entry line');
      assert.ok(
        entryLines[0].startsWith('- [RCA-2026-04-25-abc1234](RCA-2026-04-25-abc1234.md): Auth bug'),
        `entry line format should be - [id](path): title, got: ${entryLines[0]}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('includes top tags section when tags present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-llmstxt-tags-'));
    try {
      const entries = [
        { id: 'RCA-2026-04-25-a1', title: 'Bug A', date: '2026-04-25', path: 'a1.md', tags: ['auth', 'backend'], root_cause_snippet: '', fix_snippet: '' },
        { id: 'RCA-2026-04-24-a2', title: 'Bug B', date: '2026-04-24', path: 'a2.md', tags: ['auth', 'frontend'], root_cause_snippet: '', fix_snippet: '' },
        { id: 'RCA-2026-04-23-a3', title: 'Bug C', date: '2026-04-23', path: 'a3.md', tags: ['backend'], root_cause_snippet: '', fix_snippet: '' },
      ];
      await generateLlmsTxt(dir, entries);
      const content = readFileSync(join(dir, 'llms.txt'), 'utf8');
      assert.ok(content.includes('## Top Tags'), 'should have Top Tags section');
      assert.ok(content.includes('auth'), 'should include auth tag');
      assert.ok(content.includes('backend'), 'should include backend tag');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('truncates root_cause_snippet at 120 chars in llms.txt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-llmstxt-truncate-'));
    try {
      const longSnippet = 'X'.repeat(200);
      const entries = [
        { id: 'RCA-2026-04-25-abc1234', title: 'Long snippet bug', date: '2026-04-25', path: 'long.md', tags: [], root_cause_snippet: longSnippet, fix_snippet: '' },
      ];
      await generateLlmsTxt(dir, entries);
      const content = readFileSync(join(dir, 'llms.txt'), 'utf8');
      // The snippet in the entry line should be at most 120 chars of the original
      const entryLines = content.split('\n').filter((l) => l.startsWith('- ['));
      assert.ok(entryLines.length >= 1, 'should have an entry line');
      // The snippet text in the line is what comes after ": title — "
      const line = entryLines[0];
      const snippetMatch = line.match(/ — (X+)/);
      assert.ok(snippetMatch, 'should have snippet in entry line');
      assert.ok(snippetMatch[1].length <= 120, `snippet in line should be at most 120 chars, got ${snippetMatch[1].length}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('generates valid llms.txt when no entries (empty corpus)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-llmstxt-empty-'));
    try {
      await generateLlmsTxt(dir, []);
      const content = readFileSync(join(dir, 'llms.txt'), 'utf8');
      assert.ok(content.startsWith('# RCA Corpus —'), 'should still have heading when empty');
      assert.ok(content.includes('Total: 0 RCAs'), 'should show 0 RCAs');
      // Recent section should NOT be present when no entries
      assert.ok(!content.includes('## Recent RCAs'), 'should not have recent section when no entries');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rebuildManifest also generates llms.txt alongside _manifest.jsonl', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-rebuild-llmstxt-'));
    try {
      writeRca(dir, 'RCA-2026-04-25-abc1234-foo.md', {
        title: '"Foo bug"',
        date: '2026-04-25T10:00:00Z',
        ref: 'abc1234',
        confidence: 'high',
        tags: ['auth', 'backend'],
        files: ['src/foo.js'],
      });
      await rebuildManifest(dir);
      assert.ok(existsSync(join(dir, '_manifest.jsonl')), '_manifest.jsonl should exist');
      assert.ok(existsSync(join(dir, 'llms.txt')), 'llms.txt should be generated by rebuildManifest');
      const llmsContent = readFileSync(join(dir, 'llms.txt'), 'utf8');
      assert.ok(llmsContent.startsWith('# RCA Corpus —'), 'llms.txt should have valid heading');
      assert.ok(llmsContent.includes('Total: 1 RCA'), 'llms.txt should reflect one entry');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadManifest', () => {
  it('returns empty array when manifest does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-load-manifest-'));
    const result = loadManifest(dir);
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips malformed JSON lines and returns valid entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-load-manifest-malformed-'));
    const validEntry = JSON.stringify({ id: 'RCA-1', title: 'Test', ref: 'abc0001' });
    writeFileSync(
      join(dir, '_manifest.jsonl'),
      `# header\n${validEntry}\nnot-valid-json!!!\n{ broken }\n`,
      'utf8',
    );
    const result = loadManifest(dir);
    assert.strictEqual(result.length, 1, 'only 1 valid JSON line should be parsed');
    assert.strictEqual(result[0].id, 'RCA-1');
    rmSync(dir, { recursive: true, force: true });
  });
});
