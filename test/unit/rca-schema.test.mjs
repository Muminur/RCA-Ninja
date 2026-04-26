import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRca } from '../../src/schema.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'canonical-rca.json'), 'utf8'),
);

function validRca(overrides = {}) {
  return { ...fixture, ...overrides };
}

describe('RCA schema', () => {
  it('accepts the canonical fixture', () => {
    const result = validateRca(validRca());
    assert.strictEqual(result.valid, true);
  });

  it('rejects missing title', () => {
    const { title: _, ...rest } = validRca();
    const result = validateRca(rest);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('title')));
  });

  it('rejects missing symptom', () => {
    const { symptom: _, ...rest } = validRca();
    const result = validateRca(rest);
    assert.strictEqual(result.valid, false);
  });

  it('rejects missing root_cause', () => {
    const { root_cause: _, ...rest } = validRca();
    const result = validateRca(rest);
    assert.strictEqual(result.valid, false);
  });

  it('rejects missing fix', () => {
    const { fix: _, ...rest } = validRca();
    const result = validateRca(rest);
    assert.strictEqual(result.valid, false);
  });

  it('rejects missing tags', () => {
    const { tags: _, ...rest } = validRca();
    const result = validateRca(rest);
    assert.strictEqual(result.valid, false);
  });

  it('rejects missing confidence', () => {
    const { confidence: _, ...rest } = validRca();
    const result = validateRca(rest);
    assert.strictEqual(result.valid, false);
  });

  it('rejects uppercase tags', () => {
    const result = validateRca(validRca({ tags: ['rca', 'BugFix'] }));
    assert.strictEqual(result.valid, false);
  });

  it('rejects leading-hyphen tags', () => {
    const result = validateRca(validRca({ tags: ['rca', '-bad'] }));
    assert.strictEqual(result.valid, false);
  });

  it('rejects tag length > 31', () => {
    const result = validateRca(validRca({ tags: ['rca', 'a'.repeat(32)] }));
    assert.strictEqual(result.valid, false);
  });

  it('rejects invalid confidence', () => {
    const result = validateRca(validRca({ confidence: 'maybe' }));
    assert.strictEqual(result.valid, false);
  });

  it('rejects title too short', () => {
    const result = validateRca(validRca({ title: 'Short' }));
    assert.strictEqual(result.valid, false);
  });

  it('rejects title too long', () => {
    const result = validateRca(validRca({ title: 'x'.repeat(81) }));
    assert.strictEqual(result.valid, false);
  });
});
