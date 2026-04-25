import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('smoke', () => {
  it('proves the test runner works', () => {
    assert.strictEqual(1 + 1, 2);
  });

  it('can import node builtins', async () => {
    const { join } = await import('node:path');
    assert.strictEqual(typeof join, 'function');
  });
});
