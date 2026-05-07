import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { truncateDiff, filterDiff, DEFAULT_SKIP_FILES } from '../../src/context.mjs';

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

// ---------------------------------------------------------------------------
// Helpers for filterDiff tests
// ---------------------------------------------------------------------------

function makeBinarySection(filename) {
  return (
    `diff --git a/${filename} b/${filename}\n` +
    `index 0000000..1111111 100644\n` +
    `Binary files a/${filename} and b/${filename} differ\n`
  );
}

function makeTextSection(filename, lines = 3) {
  return makeFileDiff(filename, [makeHunk('section', lines)]);
}

// ---------------------------------------------------------------------------
// filterDiff
// ---------------------------------------------------------------------------

describe('filterDiff', () => {
  it('removes binary file sections', () => {
    const binary = makeBinarySection('assets/logo.png');
    const text = makeTextSection('src/index.js');
    const diff = binary + text;

    const { content, filesSkipped } = filterDiff(diff, { skipFiles: [], skipBinary: true });

    assert.ok(!content.includes('logo.png'), 'binary section should be removed');
    assert.ok(content.includes('src/index.js'), 'text section should be kept');
    assert.ok(filesSkipped.includes('assets/logo.png'), 'skipped list should contain binary file');
  });

  it('does not remove binary file sections when skipBinary is false', () => {
    const binary = makeBinarySection('assets/logo.png');
    const diff = binary + makeTextSection('src/index.js');

    const { content, filesSkipped } = filterDiff(diff, { skipFiles: [], skipBinary: false });

    assert.ok(content.includes('logo.png'), 'binary section should be kept when skipBinary=false');
    assert.strictEqual(filesSkipped.length, 0);
  });

  it('removes package-lock.json sections', () => {
    const lockSection = makeTextSection('package-lock.json', 50);
    const srcSection = makeTextSection('src/app.mjs', 3);
    const diff = lockSection + srcSection;

    const { content, filesSkipped } = filterDiff(diff, {
      skipFiles: ['package-lock.json'],
      skipBinary: false,
    });

    assert.ok(!content.includes('package-lock.json'), 'lock file section should be removed');
    assert.ok(content.includes('src/app.mjs'), 'src section should be kept');
    assert.ok(filesSkipped.includes('package-lock.json'));
  });

  it('removes yarn.lock sections', () => {
    const diff = makeTextSection('yarn.lock', 20) + makeTextSection('src/util.mjs', 3);

    const { content, filesSkipped } = filterDiff(diff, {
      skipFiles: ['yarn.lock'],
      skipBinary: false,
    });

    assert.ok(!content.includes('yarn.lock'), 'yarn.lock section should be removed');
    assert.ok(filesSkipped.includes('yarn.lock'));
  });

  it('removes *.min.js files (glob with *)', () => {
    // * only matches within a single path segment (no /), so use a root-level .min.js file
    const diff = makeTextSection('bundle.min.js', 5) + makeTextSection('src/main.js', 3);

    const { content, filesSkipped } = filterDiff(diff, {
      skipFiles: ['*.min.js'],
      skipBinary: false,
    });

    assert.ok(!content.includes('bundle.min.js'), '*.min.js should be removed');
    assert.ok(content.includes('src/main.js'), 'src/main.js should be kept');
    assert.ok(filesSkipped.some((f) => f.endsWith('bundle.min.js')));
  });

  it('removes dist/** files (glob with **)', () => {
    const diff =
      makeTextSection('dist/output/chunk.js', 5) + makeTextSection('src/component.js', 3);

    const { content, filesSkipped } = filterDiff(diff, {
      skipFiles: ['dist/**'],
      skipBinary: false,
    });

    assert.ok(!content.includes('dist/output/chunk.js'), 'dist/** should be removed');
    assert.ok(content.includes('src/component.js'), 'src file should be kept');
    assert.ok(filesSkipped.includes('dist/output/chunk.js'));
  });

  it('keeps src/ files untouched', () => {
    const diff = makeTextSection('src/core/engine.mjs', 4);

    const { content, filesSkipped } = filterDiff(diff, {
      skipFiles: DEFAULT_SKIP_FILES,
      skipBinary: true,
    });

    assert.ok(content.includes('src/core/engine.mjs'), 'src file should be kept');
    assert.strictEqual(filesSkipped.length, 0);
  });

  it('returns filesSkipped list with removed filenames', () => {
    const diff =
      makeBinarySection('img/photo.jpg') +
      makeTextSection('package-lock.json', 10) +
      makeTextSection('src/index.mjs', 2);

    const { filesSkipped } = filterDiff(diff, {
      skipFiles: ['package-lock.json'],
      skipBinary: true,
    });

    assert.ok(filesSkipped.includes('img/photo.jpg'), 'binary file should be in skipped list');
    assert.ok(filesSkipped.includes('package-lock.json'), 'lock file should be in skipped list');
    assert.strictEqual(filesSkipped.length, 2);
  });

  it('returns unchanged diff when nothing matches skip list', () => {
    const diff = makeTextSection('src/foo.mjs', 3) + makeTextSection('src/bar.mjs', 2);

    const { content, filesSkipped } = filterDiff(diff, {
      skipFiles: ['package-lock.json'],
      skipBinary: true,
    });

    assert.strictEqual(content, diff);
    assert.strictEqual(filesSkipped.length, 0);
  });

  it('handles diff with only skipped files (returns empty string)', () => {
    const diff = makeTextSection('package-lock.json', 10);

    const { content, filesSkipped } = filterDiff(diff, {
      skipFiles: ['package-lock.json'],
      skipBinary: false,
    });

    assert.strictEqual(content, '');
    assert.strictEqual(filesSkipped.length, 1);
  });

  it('uses DEFAULT_SKIP_FILES when no options provided', () => {
    const diff = makeTextSection('package-lock.json', 10) + makeTextSection('src/main.mjs', 3);

    const { content, filesSkipped } = filterDiff(diff);

    assert.ok(!content.includes('package-lock.json'));
    assert.ok(content.includes('src/main.mjs'));
    assert.ok(filesSkipped.includes('package-lock.json'));
  });
});

// ---------------------------------------------------------------------------
// matchesGlob (tested indirectly via filterDiff)
// ---------------------------------------------------------------------------

describe('matchesGlob (via filterDiff)', () => {
  it('matches exact filename: package-lock.json', () => {
    const diff = makeTextSection('package-lock.json', 5);
    const { filesSkipped } = filterDiff(diff, {
      skipFiles: ['package-lock.json'],
      skipBinary: false,
    });
    assert.ok(filesSkipped.includes('package-lock.json'));
  });

  it('matches * glob: *.min.js at top level', () => {
    const diff = makeTextSection('app.min.js', 5);
    const { filesSkipped } = filterDiff(diff, {
      skipFiles: ['*.min.js'],
      skipBinary: false,
    });
    assert.ok(filesSkipped.includes('app.min.js'));
  });

  it('matches **/ prefix: dist/** matches nested path', () => {
    const diff = makeTextSection('dist/assets/vendor.js', 5);
    const { filesSkipped } = filterDiff(diff, {
      skipFiles: ['dist/**'],
      skipBinary: false,
    });
    assert.ok(filesSkipped.includes('dist/assets/vendor.js'));
  });

  it('does not match src/foo.js against *.min.js', () => {
    const diff = makeTextSection('src/foo.js', 5);
    const { filesSkipped } = filterDiff(diff, {
      skipFiles: ['*.min.js'],
      skipBinary: false,
    });
    assert.strictEqual(filesSkipped.length, 0);
  });

  it('* does not cross directory separator', () => {
    // *.min.js should NOT match dist/bundle.min.js because * cannot cross /
    const diff = makeTextSection('dist/bundle.min.js', 5);
    const { filesSkipped } = filterDiff(diff, {
      skipFiles: ['*.min.js'],
      skipBinary: false,
    });
    // *.min.js only matches root-level foo.min.js, NOT dist/bundle.min.js
    assert.strictEqual(filesSkipped.length, 0, '* should not cross /');
  });
});
