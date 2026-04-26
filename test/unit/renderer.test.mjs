import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { renderRca } from '../../src/renderer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
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
});
