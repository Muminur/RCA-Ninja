import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', 'fixtures', 'samples');

// Lazy import so module-not-found is the first observed failure
const { extractFunctionBlocks, LANGUAGE_GRAMMARS } = await import('../../src/diff-ast.mjs');

describe('diff-ast', () => {
  // ---------- 1. JS function extraction ----------
  test('extracts JS function_declaration containing changed line', async () => {
    const content = readFileSync(join(FIXTURES, 'auth-large.js'), 'utf8');
    // Line 7 is inside `function authenticate`: "const decoded = verifyToken(token);"
    const result = await extractFunctionBlocks('auth.js', content, [7]);
    assert.equal(result.fallback, false);
    assert.equal(result.blocks.length, 1);
    assert.ok(result.blocks[0].includes('authenticate'));
  });

  // ---------- 2. JS arrow function ----------
  test('extracts JS arrow function containing changed line', async () => {
    const content = 'const f = () => {\n  return 42;\n};\n';
    const result = await extractFunctionBlocks('app.js', content, [2]);
    assert.equal(result.fallback, false);
    assert.equal(result.blocks.length, 1);
    assert.ok(result.blocks[0].includes('return 42'));
  });

  // ---------- 3. Python def extraction ----------
  test('extracts Python function_definition containing changed line', async () => {
    const content = readFileSync(join(FIXTURES, 'auth-large.py'), 'utf8');
    // Line 10 is inside `def authenticate`: "decoded = validate_token(token)"
    const result = await extractFunctionBlocks('auth.py', content, [10]);
    assert.equal(result.fallback, false);
    assert.equal(result.blocks.length, 1);
    assert.ok(result.blocks[0].includes('authenticate'));
  });

  // ---------- 4. Go func extraction ----------
  test('extracts Go function_declaration containing changed line', async () => {
    const content = readFileSync(join(FIXTURES, 'auth-large.go'), 'utf8');
    // Line 13 is inside `func Authenticate`: "token := r.Header.Get(..."
    const result = await extractFunctionBlocks('auth.go', content, [13]);
    assert.equal(result.fallback, false);
    assert.equal(result.blocks.length, 1);
    assert.ok(result.blocks[0].includes('Authenticate'));
  });

  // ---------- 5. Rust fn extraction ----------
  test('extracts Rust function_item containing changed line', async () => {
    const content = readFileSync(join(FIXTURES, 'auth-large.rs'), 'utf8');
    // Line 8 is inside `fn authenticate`: "let decoded = validate_token(token)?;"
    const result = await extractFunctionBlocks('auth.rs', content, [8]);
    assert.equal(result.fallback, false);
    assert.equal(result.blocks.length, 1);
    assert.ok(result.blocks[0].includes('authenticate'));
  });

  // ---------- 6. Java method extraction ----------
  test('extracts Java method_declaration containing changed line', async () => {
    const content = readFileSync(join(FIXTURES, 'auth-large.java'), 'utf8');
    // Line 10 is inside `authenticate` method: "String token = request.getHeader..."
    const result = await extractFunctionBlocks('AuthService.java', content, [10]);
    assert.equal(result.fallback, false);
    assert.equal(result.blocks.length, 1);
    assert.ok(result.blocks[0].includes('authenticate'));
  });

  // ---------- 7. Dedup: one function, two changed lines ----------
  test('deduplicates when two changed lines are in the same function', async () => {
    const content = 'function foo() {\n  let a = 1;\n  let b = 2;\n  return a + b;\n}\n';
    const result = await extractFunctionBlocks('dedup.js', content, [2, 3]);
    assert.equal(result.fallback, false);
    assert.equal(result.blocks.length, 1);
  });

  // ---------- 8. Two functions: one changed line in each ----------
  test('returns two blocks when changed lines span two functions', async () => {
    const content = 'function alpha() {\n  return 1;\n}\nfunction beta() {\n  return 2;\n}\n';
    const result = await extractFunctionBlocks('two.js', content, [2, 5]);
    assert.equal(result.fallback, false);
    assert.equal(result.blocks.length, 2);
  });

  // ---------- 9. Unsupported language ----------
  test('returns fallback for unsupported language (.rb)', async () => {
    const result = await extractFunctionBlocks('app.rb', 'def hello; end', [1]);
    assert.equal(result.fallback, true);
    assert.equal(result.reason, 'unsupported_language');
  });

  // ---------- 10. Malformed source ----------
  test('returns fallback for malformed source', async () => {
    const result = await extractFunctionBlocks('bad.js', '{{{{invalid', [1]);
    assert.equal(result.fallback, true);
    assert.equal(result.reason, 'parse_error');
  });

  // ---------- 11. Empty content ----------
  test('returns fallback for empty content', async () => {
    const result = await extractFunctionBlocks('empty.js', '', [1]);
    assert.equal(result.fallback, true);
    assert.equal(result.reason, 'empty_content');
  });

  // ---------- 12. Top-level code (no enclosing function) ----------
  test('returns fallback when changed line is top-level code', async () => {
    const content = 'const x = 42;\nconsole.log(x);\n';
    const result = await extractFunctionBlocks('toplevel.js', content, [1]);
    assert.equal(result.fallback, true);
    assert.equal(result.reason, 'no_enclosing_block');
  });

  // ---------- Bonus: LANGUAGE_GRAMMARS export ----------
  test('LANGUAGE_GRAMMARS covers expected extensions', () => {
    assert.equal(LANGUAGE_GRAMMARS['.js'], 'javascript');
    assert.equal(LANGUAGE_GRAMMARS['.mjs'], 'javascript');
    assert.equal(LANGUAGE_GRAMMARS['.ts'], 'typescript');
    assert.equal(LANGUAGE_GRAMMARS['.tsx'], 'typescript');
    assert.equal(LANGUAGE_GRAMMARS['.py'], 'python');
    assert.equal(LANGUAGE_GRAMMARS['.go'], 'go');
    assert.equal(LANGUAGE_GRAMMARS['.rs'], 'rust');
    assert.equal(LANGUAGE_GRAMMARS['.java'], 'java');
  });
});
