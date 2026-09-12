import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRca } from '../../src/util/frontmatter.mjs';

function doc(refLine) {
  return `---\ntitle: "Something broke"\ndate: 2026-09-12T00:00:00Z\n${refLine}\nbranch: main\n---\n\n## Root Cause\n\nBecause.\n`;
}

describe('parseRca', () => {
  it('keeps an all-digit short hash as a string', () => {
    assert.strictEqual(parseRca(doc('ref: 1234567')).data.ref, '1234567');
  });

  it('keeps a leading-zero short hash as a string (YAML would read it as octal)', () => {
    // js-yaml resolves `0012345` to 5349.
    assert.strictEqual(parseRca(doc('ref: 0012345')).data.ref, '0012345');
  });

  it('keeps an exponent-shaped short hash as a string (YAML would read it as Infinity)', () => {
    assert.strictEqual(parseRca(doc('ref: 123e456')).data.ref, '123e456');
  });

  it('keeps a 0x-prefixed short hash as a string (YAML would read it as hex)', () => {
    assert.strictEqual(parseRca(doc('ref: 0x12345')).data.ref, '0x12345');
  });

  it('keeps 1e5 as a string', () => {
    assert.strictEqual(parseRca(doc('ref: 1e5')).data.ref, '1e5');
  });

  it('strips the quotes off an already-quoted ref', () => {
    assert.strictEqual(parseRca(doc('ref: "abc1234"')).data.ref, 'abc1234');
    assert.strictEqual(parseRca(doc("ref: 'abc1234'")).data.ref, 'abc1234');
  });

  it('leaves a plain alphanumeric ref alone', () => {
    assert.strictEqual(parseRca(doc('ref: abc1234')).data.ref, 'abc1234');
  });

  it('returns the other frontmatter keys and the body unchanged', () => {
    const parsed = parseRca(doc('ref: 123e456'));
    assert.strictEqual(parsed.data.title, 'Something broke');
    assert.strictEqual(parsed.data.branch, 'main');
    assert.ok(parsed.content.includes('## Root Cause'));
  });

  it('does not invent a ref when the frontmatter has none', () => {
    const parsed = parseRca('---\ntitle: "x"\n---\n\nbody\n');
    assert.strictEqual(parsed.data.ref, undefined);
  });

  it('ignores an indented ref: inside a nested block', () => {
    const parsed = parseRca(
      '---\ntitle: "x"\nprior_bugs:\n  - id: RCA-2026-01-01-abc1234\n    ref: 999\nref: 0012345\n---\n\nbody\n',
    );
    assert.strictEqual(parsed.data.ref, '0012345');
  });

  it('survives a document with no frontmatter at all', () => {
    const parsed = parseRca('just a body\n');
    assert.deepStrictEqual(parsed.data, {});
    assert.ok(parsed.content.includes('just a body'));
  });
});
