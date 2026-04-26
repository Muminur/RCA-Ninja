import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../../src/slug.mjs';

describe('slugify', () => {
  it('converts PRD test vector: session middleware', () => {
    assert.strictEqual(
      slugify('Session middleware null-pointers when cookie domain mismatch occurs'),
      'session-middleware-null-pointers-cookie',
    );
  });

  it('converts PRD test vector: 503 stripe', () => {
    assert.strictEqual(
      slugify('503 from Stripe webhook on idempotency replay'),
      '503-stripe-webhook-idempotency-replay',
    );
  });

  it('converts PRD test vector: question marks', () => {
    assert.strictEqual(slugify('???'), 'untitled');
  });

  it('converts PRD test vector: race condition', () => {
    assert.strictEqual(
      slugify('Race condition in pagination cache'),
      'race-condition-pagination-cache',
    );
  });

  it('is idempotent', () => {
    const input = 'Some Bug Title Here Now';
    const once = slugify(input);
    const twice = slugify(once);
    assert.strictEqual(once, twice);
  });

  it('returns untitled for empty input', () => {
    assert.strictEqual(slugify(''), 'untitled');
  });

  it('returns untitled for only punctuation', () => {
    assert.strictEqual(slugify('!@#$%^&*()'), 'untitled');
  });

  it('returns untitled for only stop-words', () => {
    assert.strictEqual(slugify('the and or but of in on to for a an'), 'untitled');
  });

  it('strips unicode to ascii', () => {
    const result = slugify('café résumé naïve');
    assert.ok(/^[a-z0-9-]+$/.test(result));
  });

  it('path traversal: ../../../etc/passwd becomes safe', () => {
    const result = slugify('../../../etc/passwd');
    assert.ok(/^[a-z0-9-]+$/.test(result));
    assert.ok(!result.includes('..'));
    assert.ok(!result.includes('/'));
  });

  it('path traversal: ..%2F encoded', () => {
    const result = slugify('..%2F..%2Fetc%2Fpasswd');
    assert.ok(/^[a-z0-9-]+$/.test(result));
  });

  it('null bytes are stripped', () => {
    const result = slugify('hello\x00world');
    assert.ok(/^[a-z0-9-]+$/.test(result));
    assert.ok(!result.includes('\x00'));
  });

  it('respects max_slug_words option', () => {
    const result = slugify('one two three four five six seven', 3);
    const words = result.split('-');
    assert.ok(words.length <= 3);
  });

  it('output always matches security regex', () => {
    const nasty = [
      '../../../etc/passwd',
      'hello world\x00evil',
      '   leading spaces   ',
      '---dashes---',
      'UPPERCASE and MiXeD',
      '日本語テスト',
      'a'.repeat(200),
    ];
    for (const input of nasty) {
      const result = slugify(input);
      assert.ok(/^[a-z0-9-]+$/.test(result), `Failed for input: ${input}, got: ${result}`);
    }
  });
});
