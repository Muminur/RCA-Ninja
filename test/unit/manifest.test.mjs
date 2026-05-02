import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { rebuildManifest } from '../../src/manifest.mjs';

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
});
