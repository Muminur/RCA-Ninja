import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('atomicWrite', () => {
  let atomicWrite;
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'claude-rca-fs-'));
  });

  it('can import fs utilities', async () => {
    const mod = await import('../../src/util/fs.mjs');
    atomicWrite = mod.atomicWrite;
    assert.strictEqual(typeof atomicWrite, 'function');
  });

  it('writes content to the destination file', async () => {
    const dest = join(tmp, 'test.txt');
    await atomicWrite(dest, 'hello world');
    assert.strictEqual(readFileSync(dest, 'utf8'), 'hello world');
  });

  it('creates parent directories', async () => {
    const dest = join(tmp, 'sub', 'dir', 'test.txt');
    await atomicWrite(dest, 'nested');
    assert.strictEqual(readFileSync(dest, 'utf8'), 'nested');
  });

  it('leaves no tmp files on success', async () => {
    const dest = join(tmp, 'clean.txt');
    await atomicWrite(dest, 'data');
    const files = readdirSync(tmp);
    assert.ok(!files.some((f) => f.includes('.tmp-')));
  });

  it('cleans up tmp file on failure', async () => {
    const badDest = join(tmp, '\x00invalid');
    try {
      await atomicWrite(badDest, 'data');
    } catch {
      // expected
    }
    const files = readdirSync(tmp);
    assert.ok(!files.some((f) => f.includes('.tmp-')));
  });

  it('EXDEV fallback: source contains copyFileSync+unlinkSync branch', async () => {
    const src = readFileSync(new URL('../../src/util/fs.mjs', import.meta.url), 'utf8');
    assert.ok(src.includes("err.code === 'EXDEV'"), 'EXDEV guard must be present');
    assert.ok(src.includes('copyFileSync(tmpPath, dest)'), 'EXDEV fallback must copy the file');
    assert.ok(src.includes('unlinkSync(tmpPath)'), 'EXDEV fallback must unlink the tmp file');
  });
});

describe('acquireLock / releaseLock', () => {
  let acquireLock, releaseLock;
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'claude-rca-lock-'));
  });

  it('can import lock utilities', async () => {
    const mod = await import('../../src/util/fs.mjs');
    acquireLock = mod.acquireLock;
    releaseLock = mod.releaseLock;
    assert.ok(acquireLock);
    assert.ok(releaseLock);
  });

  it('acquires and releases a lock', () => {
    const lockPath = join(tmp, '.lock');
    acquireLock(lockPath);
    assert.ok(existsSync(lockPath));
    releaseLock(lockPath);
    assert.ok(!existsSync(lockPath));
  });

  it('fails to acquire an existing lock', () => {
    const lockPath = join(tmp, '.lock');
    acquireLock(lockPath);
    assert.throws(() => acquireLock(lockPath));
    releaseLock(lockPath);
  });
});
