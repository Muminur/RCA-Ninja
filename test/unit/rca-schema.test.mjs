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

  // --- code_changes ---

  it('accepts RCA with valid code_changes array', () => {
    const result = validateRca(
      validRca({
        code_changes: [
          {
            file: 'src/foo.js',
            before: 'const x = null;',
            after: 'const x = 0;',
            description: 'Guard against null',
            language: 'javascript',
          },
        ],
      }),
    );
    assert.strictEqual(result.valid, true);
  });

  it('accepts RCA without code_changes (backward compat)', () => {
    const { code_changes: _, ...rest } = validRca({ code_changes: [] });
    const result = validateRca(rest);
    assert.strictEqual(result.valid, true);
  });

  it('rejects code_changes entry missing file field', () => {
    const result = validateRca(
      validRca({
        code_changes: [{ before: 'old', after: 'new' }],
      }),
    );
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('file') || e.includes('required')));
  });

  // --- description ---

  it('accepts RCA with description field', () => {
    const result = validateRca(
      validRca({ description: 'A one-line summary of what this RCA covers.' }),
    );
    assert.strictEqual(result.valid, true);
  });

  it('accepts RCA without description (backward compat)', () => {
    const { description: _, ...rest } = validRca({ description: '' });
    const result = validateRca(rest);
    assert.strictEqual(result.valid, true);
  });

  it('rejects description exceeding 200 characters', () => {
    const result = validateRca(validRca({ description: 'x'.repeat(201) }));
    assert.strictEqual(result.valid, false);
  });

  // --- components ---

  it('accepts RCA with components array', () => {
    const result = validateRca(
      validRca({ components: ['auth-service', 'session.middleware', 'api.v2'] }),
    );
    assert.strictEqual(result.valid, true);
  });

  it('accepts RCA without components (backward compat)', () => {
    const { components: _, ...rest } = validRca({ components: [] });
    const result = validateRca(rest);
    assert.strictEqual(result.valid, true);
  });

  it('rejects components entry not matching pattern', () => {
    const result = validateRca(validRca({ components: ['-bad-start'] }));
    assert.strictEqual(result.valid, false);
  });

  it('rejects more than 10 components', () => {
    const result = validateRca(
      validRca({ components: Array.from({ length: 11 }, (_, i) => `comp${i}`) }),
    );
    assert.strictEqual(result.valid, false);
  });
});
