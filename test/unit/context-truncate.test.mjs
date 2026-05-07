import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { truncateDiff } from '../../src/context.mjs';

function makeHunk(label, lineCount = 5) {
  const header = `@@ -1,${lineCount} +1,${lineCount} @@ ${label}\n`;
  const body = Array.from({ length: lineCount }, (_, i) => ` line ${i + 1}\n`).join('');
  return header + body;
}

function makeFileDiff(filename, hunks) {
  return (
    `diff --git a/${filename} b/${filename}\n` +
    `--- a/${filename}\n` +
    `+++ b/${filename}\n` +
    hunks.join('')
  );
}

describe('truncateDiff', () => {
  it('returns diff unchanged when within byte limit', () => {
    const diff = makeFileDiff('src/foo.js', [makeHunk('func', 3)]);
    const result = truncateDiff(diff, diff.length + 100);
    assert.strictEqual(result.content, diff);
    assert.strictEqual(result.truncated, false);
  });

  it('truncates at hunk boundary, not mid-hunk', () => {
    // Two hunks; limit forces only the first to fit
    const hunk1 = makeHunk('first', 5);
    const hunk2 = makeHunk('second', 5);
    const diff = makeFileDiff('src/foo.js', [hunk1, hunk2]);
    const limitBytes = Buffer.byteLength(makeFileDiff('src/foo.js', [hunk1])) + 10;

    const result = truncateDiff(diff, limitBytes);

    assert.strictEqual(result.truncated, true, 'should be marked as truncated');
    assert.ok(!result.content.includes('second'), 'second hunk should be excluded');
    assert.ok(result.content.includes('first'), 'first hunk should be present');
    // Must not end mid-hunk line
    const lastChar = result.content.slice(-1);
    assert.ok(lastChar === '\n' || result.content.length === 0, 'should end at newline');
  });

  it('returns empty string when even the first hunk exceeds limit', () => {
    const diff = makeFileDiff('src/foo.js', [makeHunk('big', 100)]);
    const result = truncateDiff(diff, 10);
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(result.content, '');
  });

  it('handles diff with no @@ hunks (just file header)', () => {
    const diff = 'diff --git a/foo b/foo\nnew file mode 100644\n';
    const result = truncateDiff(diff, 5);
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(result.content, '');
  });

  it('includes complete hunks from multiple files up to limit', () => {
    const file1 = makeFileDiff('a.js', [makeHunk('aFunc', 3)]);
    const file2 = makeFileDiff('b.js', [makeHunk('bFunc', 3)]);
    const diff = file1 + file2;
    // Limit to slightly more than file1 to include it but not file2
    const limitBytes = Buffer.byteLength(file1) + 20;

    const result = truncateDiff(diff, limitBytes);

    assert.strictEqual(result.truncated, true);
    assert.ok(result.content.includes('a.js'), 'a.js hunk should be present');
    assert.ok(!result.content.includes('b.js'), 'b.js hunk should be excluded');
  });

  it('returns full diff unchanged when limit is exactly diff size', () => {
    const diff = makeFileDiff('src/foo.js', [makeHunk('exact', 4)]);
    const limitBytes = Buffer.byteLength(diff);
    const result = truncateDiff(diff, limitBytes);
    assert.strictEqual(result.content, diff);
    assert.strictEqual(result.truncated, false);
  });
});
