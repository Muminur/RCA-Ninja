import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokens,
  estimatePayload,
  TOKEN_WARN_THRESHOLD,
  TOKEN_HARD_LIMIT,
} from '../../src/token-estimate.mjs';

describe('estimateTokens', () => {
  test('empty string returns 0', () => {
    assert.strictEqual(estimateTokens(''), 0);
  });

  test('4 chars returns 1 token', () => {
    assert.strictEqual(estimateTokens('abcd'), 1);
  });

  test('5 chars returns 2 tokens (ceiling)', () => {
    assert.strictEqual(estimateTokens('abcde'), 2);
  });

  test('4000 chars returns 1000 tokens', () => {
    assert.strictEqual(estimateTokens('a'.repeat(4000)), 1000);
  });

  test('null/undefined returns 0', () => {
    assert.strictEqual(estimateTokens(null), 0);
    assert.strictEqual(estimateTokens(undefined), 0);
  });
});

describe('estimatePayload', () => {
  test('sums all 5 fields correctly', () => {
    const result = estimatePayload({
      systemPrompt: 'a'.repeat(400),
      schema: 'b'.repeat(800),
      contextJson: 'c'.repeat(1200),
      diff: 'd'.repeat(2000),
      priorRcas: 'e'.repeat(400),
    });
    assert.strictEqual(result.total, 1200);
    assert.deepStrictEqual(result.breakdown, {
      system: 100,
      schema: 200,
      context: 300,
      diff: 500,
      prior: 100,
    });
  });

  test('breakdown keys are system, schema, context, diff, prior', () => {
    const result = estimatePayload({
      systemPrompt: '',
      schema: '',
      contextJson: '',
      diff: '',
      priorRcas: '',
    });
    assert.deepStrictEqual(Object.keys(result.breakdown).sort(), [
      'context',
      'diff',
      'prior',
      'schema',
      'system',
    ]);
  });

  test('handles missing fields gracefully', () => {
    const result = estimatePayload({});
    assert.strictEqual(result.total, 0);
  });
});

describe('constants', () => {
  test('TOKEN_WARN_THRESHOLD is 80000', () => {
    assert.strictEqual(TOKEN_WARN_THRESHOLD, 80_000);
  });

  test('TOKEN_HARD_LIMIT is 180000', () => {
    assert.strictEqual(TOKEN_HARD_LIMIT, 180_000);
  });
});
