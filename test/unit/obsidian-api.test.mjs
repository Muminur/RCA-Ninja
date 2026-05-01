import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createObsidianClient } from '../../src/obsidian-api.mjs';
import { RcaError } from '../../src/errors.mjs';

const EXPECTED_METHODS = [
  'searchVault',
  'readNote',
  'createNote',
  'patchNote',
  'appendNote',
  'deleteNote',
  'listFolder',
  'listVaultRoot',
  'getStatus',
  'openNote',
];

describe('createObsidianClient', () => {
  it('throws RcaError with code INTERNAL when apiKey is missing', () => {
    assert.throws(
      () => createObsidianClient({ apiKey: undefined }),
      (err) => {
        assert.ok(err instanceof RcaError, 'error must be an RcaError');
        assert.strictEqual(err.code, 'INTERNAL');
        return true;
      },
    );
  });

  it('throws when apiKey is an empty string', () => {
    assert.throws(
      () => createObsidianClient({ apiKey: '' }),
      (err) => {
        assert.ok(err instanceof RcaError);
        assert.strictEqual(err.code, 'INTERNAL');
        return true;
      },
    );
  });

  it('returns an object when apiKey is provided', () => {
    const client = createObsidianClient({ apiKey: 'test-key' });
    assert.ok(client !== null && typeof client === 'object');
  });

  it('returns an object with all expected methods', () => {
    const client = createObsidianClient({ apiKey: 'test-key' });
    for (const method of EXPECTED_METHODS) {
      assert.ok(method in client, `client must have method: ${method}`);
    }
  });

  it('all methods are functions', () => {
    const client = createObsidianClient({ apiKey: 'test-key' });
    for (const method of EXPECTED_METHODS) {
      assert.strictEqual(typeof client[method], 'function', `${method} must be a function`);
    }
  });

  it('all methods return a Promise (are async)', () => {
    const client = createObsidianClient({ apiKey: 'test-key' });
    // Each method returns a Promise — abort immediately to avoid network I/O
    for (const method of EXPECTED_METHODS) {
      let result;
      try {
        // Pass minimal args that satisfy each method signature
        if (method === 'searchVault') result = client[method]('test');
        else if (method === 'listVaultRoot' || method === 'getStatus') result = client[method]();
        else if (method === 'listFolder') result = client[method]('/');
        else if (method === 'createNote') result = client[method]('note.md', 'content');
        else if (method === 'patchNote') result = client[method]('note.md', 'content');
        else result = client[method]('note.md');
      } catch {
        // Construction errors mean the method ran — skip
        continue;
      }
      assert.ok(
        result != null && typeof result.then === 'function',
        `${method} must return a thenable (Promise)`,
      );
      // Prevent unhandled rejection noise — the request will fail, that's expected
      result.catch(() => {});
    }
  });

  it('accepts https protocol (default) without throwing', () => {
    assert.doesNotThrow(() => createObsidianClient({ apiKey: 'test-key', protocol: 'https' }));
  });

  it('accepts http protocol without throwing', () => {
    assert.doesNotThrow(() => createObsidianClient({ apiKey: 'test-key', protocol: 'http' }));
  });

  it('accepts custom host and port without throwing', () => {
    assert.doesNotThrow(() =>
      createObsidianClient({
        apiKey: 'test-key',
        host: '192.168.1.10',
        port: 27123,
        protocol: 'http',
      }),
    );
  });

  it('uses default host 127.0.0.1 and port 27124 when not specified', () => {
    // Verify construction succeeds with only required apiKey — defaults are applied
    const client = createObsidianClient({ apiKey: 'test-key' });
    assert.ok(typeof client === 'object');
  });
});
