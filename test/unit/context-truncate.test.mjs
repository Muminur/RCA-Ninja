import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  truncateDiff,
  filterDiff,
  DEFAULT_SKIP_FILES,
  applyPerFileCap,
  dropImportOnlyHunks,
} from '../../src/context.mjs';

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

// ---------------------------------------------------------------------------
// Helper: generate a large diff section for a given file with specified byte size
// ---------------------------------------------------------------------------

function makeLargeFileDiff(filename, targetKB) {
  // Create multiple hunks that together approach the target size
  const hunks = [];
  let currentSize = 0;
  let hunkIdx = 0;
  const headerStr =
    `diff --git a/${filename} b/${filename}\n` + `--- a/${filename}\n` + `+++ b/${filename}\n`;
  currentSize += Buffer.byteLength(headerStr);

  while (currentSize < targetKB * 1024) {
    const lineCount = 20;
    const hunkHeader = `@@ -${hunkIdx * 20 + 1},${lineCount} +${hunkIdx * 20 + 1},${lineCount} @@ chunk${hunkIdx}\n`;
    let hunkBody = '';
    for (let i = 0; i < lineCount; i++) {
      hunkBody += `+${'x'.repeat(60)} line ${hunkIdx}-${i}\n`;
    }
    const hunkStr = hunkHeader + hunkBody;
    hunks.push(hunkStr);
    currentSize += Buffer.byteLength(hunkStr);
    hunkIdx++;
  }

  return headerStr + hunks.join('');
}

// ---------------------------------------------------------------------------
// applyPerFileCap
// ---------------------------------------------------------------------------

describe('applyPerFileCap', () => {
  it('truncates a file >30KB at hunk boundary and populates files_capped', () => {
    // Create a single file diff that exceeds 30KB
    const bigDiff = makeLargeFileDiff('src/big-module.js', 35);
    assert.ok(Buffer.byteLength(bigDiff) > 30 * 1024, 'precondition: diff exceeds 30KB');

    const { diff, files_capped } = applyPerFileCap(bigDiff, 30 * 1024);

    assert.ok(Buffer.byteLength(diff) < Buffer.byteLength(bigDiff), 'output should be smaller');
    assert.ok(diff.includes('diff --git a/src/big-module.js'), 'file header should remain');
    assert.deepStrictEqual(files_capped, ['src/big-module.js']);
  });

  it('keeps two 20KB files intact when both are under 30KB cap', () => {
    const file1 = makeLargeFileDiff('src/a.js', 20);
    const file2 = makeLargeFileDiff('src/b.js', 20);
    const combined = file1 + file2;

    const { diff, files_capped } = applyPerFileCap(combined, 30 * 1024);

    assert.ok(diff.includes('src/a.js'), 'file a should be present');
    assert.ok(diff.includes('src/b.js'), 'file b should be present');
    assert.deepStrictEqual(files_capped, [], 'no files should be capped');
  });

  it('cap is configurable by parameter', () => {
    // Create a file that is ~5KB — should be capped at 2KB
    const diff = makeLargeFileDiff('src/small.js', 5);

    const { files_capped: cappedAt2k } = applyPerFileCap(diff, 2 * 1024);
    assert.deepStrictEqual(cappedAt2k, ['src/small.js'], 'should be capped at 2KB');

    const { files_capped: cappedAt10k } = applyPerFileCap(diff, 10 * 1024);
    assert.deepStrictEqual(cappedAt10k, [], 'should not be capped at 10KB');
  });

  it('returns empty diff and empty files_capped for empty input', () => {
    const { diff, files_capped } = applyPerFileCap('', 30 * 1024);
    assert.strictEqual(diff, '');
    assert.deepStrictEqual(files_capped, []);
  });
});

// ---------------------------------------------------------------------------
// Expanded skip patterns
// ---------------------------------------------------------------------------

describe('expanded DEFAULT_SKIP_FILES', () => {
  it('excludes foo.snap', () => {
    const diff = makeTextSection('foo.snap', 3) + makeTextSection('src/real.js', 3);
    const { content, filesSkipped } = filterDiff(diff);
    assert.ok(!content.includes('foo.snap'), 'snap file should be excluded');
    assert.ok(filesSkipped.includes('foo.snap'));
  });

  it('excludes __snapshots__/foo.test.js.snap', () => {
    const diff =
      makeTextSection('__snapshots__/foo.test.js.snap', 3) + makeTextSection('src/real.js', 3);
    const { content, filesSkipped } = filterDiff(diff);
    assert.ok(!content.includes('__snapshots__'), 'snapshot dir should be excluded');
    assert.ok(filesSkipped.includes('__snapshots__/foo.test.js.snap'));
  });

  it('excludes bar.generated.ts', () => {
    const diff = makeTextSection('bar.generated.ts', 3) + makeTextSection('src/real.js', 3);
    const { content, filesSkipped } = filterDiff(diff);
    assert.ok(!content.includes('bar.generated.ts'), 'generated file should be excluded');
    assert.ok(filesSkipped.includes('bar.generated.ts'));
  });

  it('excludes vendor/lib.go', () => {
    const diff = makeTextSection('vendor/lib.go', 3) + makeTextSection('src/real.js', 3);
    const { content, filesSkipped } = filterDiff(diff);
    assert.ok(!content.includes('vendor/lib.go'), 'vendor file should be excluded');
    assert.ok(filesSkipped.includes('vendor/lib.go'));
  });

  it('excludes third_party/code.py', () => {
    const diff = makeTextSection('third_party/code.py', 3) + makeTextSection('src/real.js', 3);
    const { content, filesSkipped } = filterDiff(diff);
    assert.ok(!content.includes('third_party/code.py'), 'third_party file should be excluded');
    assert.ok(filesSkipped.includes('third_party/code.py'));
  });
});

// ---------------------------------------------------------------------------
// Helpers for import/whitespace diff hunks
// ---------------------------------------------------------------------------

function makeImportHunk(language) {
  const imports = {
    js: `+import { foo } from './foo.mjs';\n+import bar from 'bar';\n`,
    python: `+from os import path\n+import sys\n`,
    go: `+import (\n+  "fmt"\n+  "os"\n+)\n`,
    rust: `+use std::collections::HashMap;\n+use std::io;\n`,
    java: `+import java.util.List;\n+import java.util.Map;\n`,
    csharp: `+using System;\n+using System.Collections.Generic;\n`,
    require: `+const fs = require('fs');\n+const path = require('path');\n`,
  };
  const body = imports[language] || imports.js;
  return `@@ -1,2 +1,4 @@ imports\n ${language} header\n` + body;
}

function makeLogicHunk() {
  return (
    `@@ -10,3 +12,5 @@ logic\n` +
    ` existing line\n` +
    `+function doStuff() { return 42; }\n` +
    `+const result = doStuff();\n` +
    ` another line\n`
  );
}

function makeWhitespaceOnlyHunk() {
  return `@@ -5,2 +5,4 @@ whitespace\n existing\n+\n+\n another\n`;
}

function makeMixedImportLogicHunk() {
  return (
    `@@ -1,2 +1,5 @@ mixed\n` +
    ` existing\n` +
    `+import { helper } from './helper.mjs';\n` +
    `+function compute() { return helper(); }\n` +
    ` footer\n`
  );
}

// ---------------------------------------------------------------------------
// dropImportOnlyHunks
// ---------------------------------------------------------------------------

describe('dropImportOnlyHunks', () => {
  it('drops import-only hunk when file has other substantive hunks', () => {
    const importHunk = makeImportHunk('js');
    const logicHunk = makeLogicHunk();
    const diff = makeFileDiff('src/app.mjs', [importHunk, logicHunk]);

    const { diff: result, hunks_dropped } = dropImportOnlyHunks(diff);

    assert.strictEqual(hunks_dropped, 1, 'one import-only hunk should be dropped');
    assert.ok(!result.includes("from './foo.mjs'"), 'import hunk content should be gone');
    assert.ok(result.includes('doStuff'), 'logic hunk should remain');
  });

  it('preserves import-only hunk when file has only that hunk', () => {
    const importHunk = makeImportHunk('js');
    const diff = makeFileDiff('src/app.mjs', [importHunk]);

    const { diff: result, hunks_dropped } = dropImportOnlyHunks(diff);

    assert.strictEqual(hunks_dropped, 0, 'no hunks should be dropped for single-hunk file');
    assert.ok(result.includes("from './foo.mjs'"), 'import hunk should be preserved');
  });

  it('drops whitespace-only hunk when other hunks exist', () => {
    const wsHunk = makeWhitespaceOnlyHunk();
    const logicHunk = makeLogicHunk();
    const diff = makeFileDiff('src/app.mjs', [wsHunk, logicHunk]);

    const { diff: result, hunks_dropped } = dropImportOnlyHunks(diff);

    assert.strictEqual(hunks_dropped, 1, 'whitespace-only hunk should be dropped');
    assert.ok(result.includes('doStuff'), 'logic hunk should remain');
  });

  it('keeps mixed import + logic hunk', () => {
    const mixedHunk = makeMixedImportLogicHunk();
    const logicHunk = makeLogicHunk();
    const diff = makeFileDiff('src/app.mjs', [mixedHunk, logicHunk]);

    const { diff: result, hunks_dropped } = dropImportOnlyHunks(diff);

    assert.strictEqual(hunks_dropped, 0, 'mixed hunk should not be dropped');
    assert.ok(result.includes('helper'), 'mixed hunk content should remain');
    assert.ok(result.includes('doStuff'), 'logic hunk should remain');
  });

  it('detects Python from/import statements', () => {
    const pyImportHunk = makeImportHunk('python');
    const logicHunk = makeLogicHunk();
    const diff = makeFileDiff('src/main.py', [pyImportHunk, logicHunk]);

    const { hunks_dropped } = dropImportOnlyHunks(diff);
    assert.strictEqual(hunks_dropped, 1, 'Python import hunk should be detected and dropped');
  });

  it('detects Go import() blocks', () => {
    const goImportHunk = makeImportHunk('go');
    const logicHunk = makeLogicHunk();
    const diff = makeFileDiff('src/main.go', [goImportHunk, logicHunk]);

    const { hunks_dropped } = dropImportOnlyHunks(diff);
    assert.strictEqual(hunks_dropped, 1, 'Go import hunk should be detected and dropped');
  });

  it('detects Rust use statements', () => {
    const rustImportHunk = makeImportHunk('rust');
    const logicHunk = makeLogicHunk();
    const diff = makeFileDiff('src/main.rs', [rustImportHunk, logicHunk]);

    const { hunks_dropped } = dropImportOnlyHunks(diff);
    assert.strictEqual(hunks_dropped, 1, 'Rust use hunk should be detected and dropped');
  });

  it('detects Java import statements', () => {
    const javaImportHunk = makeImportHunk('java');
    const logicHunk = makeLogicHunk();
    const diff = makeFileDiff('src/Main.java', [javaImportHunk, logicHunk]);

    const { hunks_dropped } = dropImportOnlyHunks(diff);
    assert.strictEqual(hunks_dropped, 1, 'Java import hunk should be detected and dropped');
  });

  it('detects C# using statements', () => {
    const csImportHunk = makeImportHunk('csharp');
    const logicHunk = makeLogicHunk();
    const diff = makeFileDiff('src/Program.cs', [csImportHunk, logicHunk]);

    const { hunks_dropped } = dropImportOnlyHunks(diff);
    assert.strictEqual(hunks_dropped, 1, 'C# using hunk should be detected and dropped');
  });

  it('returns empty diff and zero hunks_dropped for empty input', () => {
    const { diff, hunks_dropped } = dropImportOnlyHunks('');
    assert.strictEqual(diff, '');
    assert.strictEqual(hunks_dropped, 0);
  });
});
