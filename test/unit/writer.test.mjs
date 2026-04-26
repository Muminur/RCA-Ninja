import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('writer', () => {
  let writeRca, computeRcaPath;
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'claude-rca-writer-'));
  });

  it('can import writer module', async () => {
    const mod = await import('../../src/writer.mjs');
    writeRca = mod.writeRca;
    computeRcaPath = mod.computeRcaPath;
    assert.ok(writeRca);
    assert.ok(computeRcaPath);
  });

  it('places file at expected path', async () => {
    const result = await writeRca({
      outputDir: tmp,
      content: '# Test RCA\n',
      date: '2026-04-25',
      shortHash: 'a3f2c1d',
      title: 'Session null pointer in auth',
    });
    assert.ok(result.path.includes('2026'));
    assert.ok(result.path.includes('04'));
    assert.ok(result.path.includes('a3f2c1d'));
    assert.ok(result.path.includes('session-null-pointer-auth'));
    assert.strictEqual(readFileSync(result.path, 'utf8'), '# Test RCA\n');
  });

  it('handles collision with -2 suffix', async () => {
    const first = await writeRca({
      outputDir: tmp,
      content: '# First\n',
      date: '2026-04-25',
      shortHash: 'a3f2c1d',
      title: 'Duplicate title test',
    });
    const second = await writeRca({
      outputDir: tmp,
      content: '# Second\n',
      date: '2026-04-25',
      shortHash: 'a3f2c1d',
      title: 'Duplicate title test',
    });
    assert.ok(first.path !== second.path);
    assert.ok(second.path.includes('-2'));
  });

  it('handles triple collision with -3 suffix', async () => {
    await writeRca({
      outputDir: tmp,
      content: '# First\n',
      date: '2026-04-25',
      shortHash: 'abc1234',
      title: 'Triple test',
    });
    await writeRca({
      outputDir: tmp,
      content: '# Second\n',
      date: '2026-04-25',
      shortHash: 'abc1234',
      title: 'Triple test',
    });
    const third = await writeRca({
      outputDir: tmp,
      content: '# Third\n',
      date: '2026-04-25',
      shortHash: 'abc1234',
      title: 'Triple test',
    });
    assert.ok(third.path.includes('-3'));
  });

  it('path traversal in title produces safe path under output_dir', async () => {
    const result = await writeRca({
      outputDir: tmp,
      content: '# Safe\n',
      date: '2026-04-25',
      shortHash: 'abc1234',
      title: '../../../etc/passwd',
    });
    assert.ok(result.path.startsWith(tmp));
    assert.ok(!result.path.includes('..'));
  });

  it('computeRcaPath produces path under output_dir', () => {
    const p = computeRcaPath({
      outputDir: tmp,
      date: '2026-04-25',
      shortHash: 'a3f2c1d',
      title: 'Test title',
    });
    assert.ok(p.startsWith(tmp));
    assert.ok(p.endsWith('.md'));
  });
});
