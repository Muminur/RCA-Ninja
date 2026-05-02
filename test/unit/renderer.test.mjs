import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import matter from 'gray-matter';
import { renderRca } from '../../src/renderer.mjs';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const __dirname_fixtures = join(__dirname, '..', 'fixtures');
const fixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'canonical-rca.json'), 'utf8'),
);

function makeContext() {
  return {
    short_hash: 'a3f2c1d',
    branch: 'main',
    timestamp_utc: '2026-04-25T14:22:00Z',
  };
}

describe('renderer', () => {
  it('renders frontmatter with title first, date second', () => {
    const md = renderRca(fixture, makeContext());
    const lines = md.split('\n');
    assert.strictEqual(lines[0], '---');
    assert.ok(lines[1].startsWith('title:'));
    assert.ok(lines[2].startsWith('date:'));
  });

  it('section order is Symptom → Root Cause → Fix → Impact → References', () => {
    const md = renderRca(fixture, makeContext());
    const sections = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    assert.deepStrictEqual(sections, ['Symptom', 'Root Cause', 'Fix', 'Impact', 'References']);
  });

  it('escapes --- in body to prevent frontmatter breakage', () => {
    const data = {
      ...fixture,
      symptom: 'Before the --- break something happened that was quite problematic.',
    };
    const md = renderRca(data, makeContext());
    const body = md.split('---').slice(2).join('---');
    assert.ok(!body.includes('\n---\n'));
  });

  it('normalizes line endings to LF', () => {
    const md = renderRca(fixture, makeContext());
    assert.ok(!md.includes('\r\n'));
    assert.ok(!md.includes('\r'));
  });

  it('trims trailing whitespace from lines', () => {
    const md = renderRca(fixture, makeContext());
    for (const line of md.split('\n')) {
      assert.strictEqual(line, line.trimEnd());
    }
  });

  it('round-trips through gray-matter parse', () => {
    const md = renderRca(fixture, makeContext());
    const parsed = matter(md);
    assert.strictEqual(parsed.data.title, fixture.title);
    assert.strictEqual(parsed.data.confidence, fixture.confidence);
    assert.ok(parsed.data.tags.includes('rca'));
    assert.ok(parsed.data.files.includes('src/middleware/auth.js'));
  });

  it('throws on section exceeding 4KB', () => {
    const big = { ...fixture, symptom: 'x'.repeat(4097) };
    assert.throws(
      () => renderRca(big, makeContext()),
      (err) => err.code === 'SCHEMA_VALIDATION',
    );
  });

  it('includes generated_by and schema in frontmatter', () => {
    const md = renderRca(fixture, makeContext());
    const parsed = matter(md);
    assert.ok(parsed.data.generated_by.startsWith('claude-rca/'));
    assert.strictEqual(parsed.data.schema, 'claude-rca.rca.v1');
  });

  it('fuzz: 50 random valid-per-schema inputs all render and re-parse to matching frontmatter', () => {
    const matterLib = require('gray-matter');
    const confidences = ['low', 'medium', 'high'];
    for (let i = 0; i < 50; i++) {
      const rca = {
        title: `Fuzz RCA title number ${i} for testing only abcdefgh`,
        symptom: `Symptom description number ${i}`,
        root_cause: `Root cause number ${i}`,
        fix: `Fix applied for case ${i}`,
        impact: `Impact description ${i}`,
        references: [`src/file${i}.js`],
        files: [`src/file${i}.js`],
        tags: ['rca', 'bugfix'],
        confidence: confidences[i % 3],
      };
      const ctx = {
        short_hash: 'abc' + String(i).padStart(4, '0'),
        branch: 'main',
        timestamp_utc: `2026-0${(i % 9) + 1}-01T00:00:00Z`,
      };
      const md = renderRca(rca, ctx);
      assert.ok(typeof md === 'string', `fuzz[${i}]: renderRca must return string`);
      assert.ok(md.startsWith('---\n'), `fuzz[${i}]: must start with YAML frontmatter`);
      const parsed = matterLib(md);
      assert.strictEqual(parsed.data.title, rca.title, `fuzz[${i}]: title must round-trip`);
      assert.strictEqual(
        parsed.data.confidence,
        rca.confidence,
        `fuzz[${i}]: confidence must round-trip`,
      );
    }
  });

  it('snapshot: renderRca(canonical-fixture) matches test/fixtures/canonical-rca.md', () => {
    const { readFileSync: rfs } = require('node:fs');
    const rca = JSON.parse(rfs(join(__dirname_fixtures, 'canonical-rca.json'), 'utf8'));
    const ctx = { short_hash: 'a3f2c1d', branch: 'main', timestamp_utc: '2026-04-25T12:00:00Z' };
    const md = renderRca(rca, ctx);
    const snapshot = rfs(join(__dirname_fixtures, 'canonical-rca.md'), 'utf8');
    assert.strictEqual(md, snapshot, 'Rendered RCA must match snapshot file');
  });

  it('includes bug_introduced_by in frontmatter when context provides it', () => {
    const ctx = {
      short_hash: 'a3f2c1d',
      branch: 'main',
      timestamp_utc: '2026-04-25T14:22:00Z',
      bug_introduced_by: {
        commit: 'ca9a812',
        author: 'Jane Dev',
        date: '2026-01-15T10:00:00+00:00',
      },
    };
    const md = renderRca(fixture, ctx);
    const parsed = matter(md);
    assert.strictEqual(
      parsed.data.bug_introduced_by,
      'ca9a812 by Jane Dev on 2026-01-15',
      'bug_introduced_by should be in frontmatter in correct format',
    );
  });

  it('omits bug_introduced_by from frontmatter when context does not provide it', () => {
    const ctx = {
      short_hash: 'a3f2c1d',
      branch: 'main',
      timestamp_utc: '2026-04-25T14:22:00Z',
      bug_introduced_by: null,
    };
    const md = renderRca(fixture, ctx);
    assert.ok(!md.includes('bug_introduced_by'), 'should not include bug_introduced_by when null');
  });

  // --- code_changes ---

  it('outputs ## Code Changes section when code_changes is non-empty', () => {
    const rca = {
      ...fixture,
      code_changes: [{ file: 'src/auth.js', before: 'return null;', after: 'return 401;' }],
    };
    const md = renderRca(rca, makeContext());
    assert.ok(md.includes('## Code Changes'), 'should include ## Code Changes heading');
  });

  it('skips ## Code Changes when code_changes is empty array', () => {
    const rca = { ...fixture, code_changes: [] };
    const md = renderRca(rca, makeContext());
    assert.ok(!md.includes('## Code Changes'), 'should omit ## Code Changes for empty array');
  });

  it('skips ## Code Changes when code_changes is undefined', () => {
    const rca = { ...fixture };
    delete rca.code_changes;
    const md = renderRca(rca, makeContext());
    assert.ok(!md.includes('## Code Changes'), 'should omit ## Code Changes when undefined');
  });

  it('includes Before/After labels with fenced code blocks', () => {
    const rca = {
      ...fixture,
      code_changes: [
        {
          file: 'src/foo.py',
          before: 'x = None',
          after: 'x = 0',
        },
      ],
    };
    const md = renderRca(rca, makeContext());
    assert.ok(md.includes('**Before**'), 'should include Before label');
    assert.ok(md.includes('**After**'), 'should include After label');
    assert.ok(md.includes('```'), 'should include fenced code blocks');
    assert.ok(md.includes('x = None'), 'should include before code');
    assert.ok(md.includes('x = 0'), 'should include after code');
  });

  it('infers language tag from file extension', () => {
    const cases = [
      { file: 'src/auth.js', expectedLang: 'javascript' },
      { file: 'src/util.mjs', expectedLang: 'javascript' },
      { file: 'app/main.py', expectedLang: 'python' },
      { file: 'cmd/server.go', expectedLang: 'go' },
      { file: 'index.ts', expectedLang: 'typescript' },
      { file: 'Makefile', expectedLang: '' },
    ];
    for (const { file, expectedLang } of cases) {
      const rca = {
        ...fixture,
        code_changes: [{ file, before: 'old', after: 'new' }],
      };
      const md = renderRca(rca, makeContext());
      assert.ok(
        md.includes('```' + expectedLang),
        `extension of "${file}" should yield lang "${expectedLang}" (got: ${md.slice(md.indexOf('```'), md.indexOf('```') + 20)})`,
      );
    }
  });

  it('uses explicit language field when provided in code_changes entry', () => {
    const rca = {
      ...fixture,
      code_changes: [{ file: 'Makefile', before: 'old', after: 'new', language: 'makefile' }],
    };
    const md = renderRca(rca, makeContext());
    assert.ok(md.includes('```makefile'), 'explicit language should override extension inference');
  });

  it('Code Changes section appears after ## Fix and before ## Impact', () => {
    const rca = {
      ...fixture,
      code_changes: [{ file: 'src/a.ts', before: 'a', after: 'b' }],
    };
    const md = renderRca(rca, makeContext());
    const fixIdx = md.indexOf('## Fix');
    const codeIdx = md.indexOf('## Code Changes');
    const impactIdx = md.indexOf('## Impact');
    assert.ok(fixIdx < codeIdx, '## Code Changes should appear after ## Fix');
    assert.ok(codeIdx < impactIdx, '## Code Changes should appear before ## Impact');
  });

  it('renders description in code_changes entry when provided', () => {
    const rca = {
      ...fixture,
      code_changes: [
        {
          file: 'src/lib.js',
          before: 'x',
          after: 'y',
          description: 'Guard the nullable path',
        },
      ],
    };
    const md = renderRca(rca, makeContext());
    assert.ok(md.includes('Guard the nullable path'), 'entry description should appear in output');
  });

  // --- description and components in frontmatter ---

  it('includes description in frontmatter when non-empty', () => {
    const rca = { ...fixture, description: 'A useful one-line summary.' };
    const md = renderRca(rca, makeContext());
    const parsed = matter(md);
    assert.strictEqual(parsed.data.description, 'A useful one-line summary.');
  });

  it('omits description from frontmatter when empty string', () => {
    const rca = { ...fixture, description: '' };
    const md = renderRca(rca, makeContext());
    assert.ok(!md.includes('description:'), 'empty description should not appear in frontmatter');
  });

  it('omits description from frontmatter when undefined', () => {
    const rca = { ...fixture };
    delete rca.description;
    const md = renderRca(rca, makeContext());
    assert.ok(!md.includes('description:'), 'missing description should not appear in frontmatter');
  });

  it('description with colon round-trips through gray-matter', () => {
    const rca = { ...fixture, description: 'Null pointer: session was missing id field' };
    const md = renderRca(rca, makeContext());
    const parsed = matter(md);
    assert.strictEqual(
      parsed.data.description,
      'Null pointer: session was missing id field',
      'description containing colon must round-trip correctly',
    );
  });

  it('includes components in frontmatter when non-empty', () => {
    const rca = { ...fixture, components: ['auth-service', 'session.middleware'] };
    const md = renderRca(rca, makeContext());
    const parsed = matter(md);
    assert.deepStrictEqual(parsed.data.components, ['auth-service', 'session.middleware']);
  });

  it('omits components from frontmatter when empty array', () => {
    const rca = { ...fixture, components: [] };
    const md = renderRca(rca, makeContext());
    assert.ok(!md.includes('components:'), 'empty components should not appear in frontmatter');
  });

  it('omits components from frontmatter when undefined', () => {
    const rca = { ...fixture };
    delete rca.components;
    const md = renderRca(rca, makeContext());
    assert.ok(!md.includes('components:'), 'missing components should not appear in frontmatter');
  });
});
