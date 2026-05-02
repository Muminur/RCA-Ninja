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

  it('generates _manifest.yaml from RCA files with frontmatter', async () => {
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
      assert.ok(existsSync(manifestPath), '_manifest.yaml should exist');
      const raw = readFileSync(manifestPath, 'utf8');
      assert.ok(raw.includes('title:'), 'manifest should contain title field');
      assert.ok(raw.includes('ref:'), 'manifest should contain ref field');
      assert.ok(raw.includes('abc1234'), 'manifest should contain the ref value');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty manifest for empty directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-empty-'));
    try {
      const manifestPath = await rebuildManifest(dir);
      assert.ok(existsSync(manifestPath), '_manifest.yaml should exist even when empty');
      const raw = readFileSync(manifestPath, 'utf8');
      // An empty manifest should be an empty YAML list
      assert.ok(raw.includes('Count: 0'), 'empty dir produces manifest with count 0');
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
      assert.ok(raw.includes('abc1234'), 'valid file should be in manifest');
      assert.ok(!raw.includes('def5678'), 'file missing title should be skipped');
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
      assert.ok(raw.includes('abc1234'), 'valid file should be in manifest');
      assert.ok(!raw.includes('No Ref RCA'), 'file missing ref should be skipped');
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
      const newestPos = raw.indexOf('ccc3333');
      const middlePos = raw.indexOf('bbb2222');
      const oldestPos = raw.indexOf('aaa1111');
      assert.ok(
        newestPos < middlePos && middlePos < oldestPos,
        'entries should be sorted newest-first',
      );
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
      assert.ok(raw.includes('components:'), 'manifest should include components field');
      assert.ok(raw.includes('auth-service'), 'manifest should include component values');
      assert.ok(raw.includes('description:'), 'manifest should include description field');
      assert.ok(raw.includes('A detailed description'), 'manifest should include description text');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips files starting with _ (like _manifest.yaml itself)', async () => {
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
      writeRca(dir, '_manifest.yaml', {
        title: '"Should be skipped"',
        date: '2026-04-20T00:00:00Z',
        ref: 'skipped1',
        confidence: 'high',
        tags: [],
        files: [],
      });

      const manifestPath = await rebuildManifest(dir);
      const raw = readFileSync(manifestPath, 'utf8');
      assert.ok(raw.includes('abc9999'), 'real RCA should be in manifest');
      assert.ok(!raw.includes('skipped1'), '_-prefixed file should be skipped');
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
      assert.ok(raw.includes('sub1234'), 'files in subdirectories should be included');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the path to _manifest.yaml', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-rca-path-'));
    try {
      const manifestPath = await rebuildManifest(dir);
      assert.ok(
        manifestPath.endsWith('_manifest.yaml'),
        'returned path should end with _manifest.yaml',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
