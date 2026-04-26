import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/util/exec.mjs';

describe('exec', () => {
  it('runs a command and returns stdout', async () => {
    const result = await run('node', ['--version']);
    assert.ok(result.stdout.startsWith('v'));
  });

  it('rejects on non-zero exit', async () => {
    await assert.rejects(
      () => run('node', ['-e', 'process.exit(1)']),
      (err) => {
        assert.ok(err.exitCode === 1 || err.code === 1);
        return true;
      },
    );
  });

  it('uses shell: false', async () => {
    const result = await run('node', ['-e', 'console.log("ok")']);
    assert.strictEqual(result.stdout.trim(), 'ok');
  });

  it('respects timeout', async () => {
    await assert.rejects(
      () => run('node', ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 500 }),
      (err) => {
        assert.ok(err.message.includes('timed out') || err.killed || err.signal);
        return true;
      },
    );
  });
});
