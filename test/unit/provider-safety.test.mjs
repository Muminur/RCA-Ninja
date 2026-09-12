import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RcaError } from '../../src/errors.mjs';
import {
  isFailClosedProviderError,
  throwIfFailClosedProviderError,
} from '../../src/provider-safety.mjs';

describe('provider safety error classification', () => {
  it('recognizes every static error that must stop analyst and amend flows', () => {
    for (const code of [
      'SECRET_SCAN_FAILED',
      'SECRET_SCANNER_UNAVAILABLE',
      'PROVIDER_ISOLATION_UNAVAILABLE',
    ]) {
      assert.strictEqual(isFailClosedProviderError(new RcaError(code)), true, code);
    }
  });

  it('does not turn unrelated failures into provider safety errors', () => {
    assert.strictEqual(isFailClosedProviderError(new RcaError('DISK_ERROR')), false);
    assert.strictEqual(isFailClosedProviderError(new Error('ordinary failure')), false);
    assert.strictEqual(isFailClosedProviderError(null), false);
  });

  it('rethrows a new static error instead of preserving mutable provider diagnostics', () => {
    const error = new RcaError('PROVIDER_ISOLATION_UNAVAILABLE');
    error.message = 'private mutable provider diagnostic';

    assert.throws(
      () => throwIfFailClosedProviderError(error),
      (thrown) => {
        assert.strictEqual(thrown.code, 'PROVIDER_ISOLATION_UNAVAILABLE');
        assert.strictEqual(
          thrown.message,
          'No approved isolated provider broker is available; provider execution was refused.',
        );
        assert.doesNotMatch(thrown.message, /private mutable provider diagnostic/i);
        return true;
      },
    );
    assert.strictEqual(throwIfFailClosedProviderError(new Error('ordinary failure')), false);
  });
});
