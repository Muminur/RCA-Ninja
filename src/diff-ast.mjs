/**
 * AST-based function extraction using web-tree-sitter.
 *
 * Given a file path, its content, and a list of changed line numbers,
 * extracts the enclosing function/method blocks for each changed line.
 */

import { Parser, Language } from 'web-tree-sitter';
import { createRequire } from 'node:module';
import { dirname, join, extname } from 'node:path';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Public: extension → grammar-name mapping
// ---------------------------------------------------------------------------

export const LANGUAGE_GRAMMARS = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
};

// ---------------------------------------------------------------------------
// Private: per-language block node types we consider "function boundaries"
// ---------------------------------------------------------------------------

const BLOCK_TYPES = {
  javascript: [
    'function_declaration',
    'arrow_function',
    'method_definition',
    'function_expression',
    'generator_function_declaration',
  ],
  typescript: [
    'function_declaration',
    'arrow_function',
    'method_definition',
    'function_expression',
    'generator_function_declaration',
  ],
  python: ['function_definition'],
  go: ['function_declaration', 'method_declaration'],
  rust: ['function_item'],
  java: ['method_declaration', 'constructor_declaration'],
};

// ---------------------------------------------------------------------------
// Private: WASM package name mapping (npm package → wasm file stem)
// ---------------------------------------------------------------------------

const WASM_PACKAGES = {
  javascript: { pkg: 'tree-sitter-javascript', wasm: 'tree-sitter-javascript.wasm' },
  typescript: { pkg: 'tree-sitter-typescript', wasm: 'tree-sitter-typescript.wasm' },
  tsx: { pkg: 'tree-sitter-typescript', wasm: 'tree-sitter-tsx.wasm' },
  python: { pkg: 'tree-sitter-python', wasm: 'tree-sitter-python.wasm' },
  go: { pkg: 'tree-sitter-go', wasm: 'tree-sitter-go.wasm' },
  rust: { pkg: 'tree-sitter-rust', wasm: 'tree-sitter-rust.wasm' },
  java: { pkg: 'tree-sitter-java', wasm: 'tree-sitter-java.wasm' },
};

// ---------------------------------------------------------------------------
// Private: singleton init + grammar cache
// ---------------------------------------------------------------------------

let initPromise = null;
const grammarCache = new Map();

async function ensureInit() {
  if (!initPromise) {
    initPromise = Parser.init();
  }
  return initPromise;
}

/**
 * Load (and cache) a Language for the given grammar key.
 *
 * @param {string} grammarKey - e.g. 'javascript', 'typescript', 'tsx'
 * @returns {Promise<Language>}
 */
async function loadGrammar(grammarKey) {
  if (grammarCache.has(grammarKey)) {
    return grammarCache.get(grammarKey);
  }

  const entry = WASM_PACKAGES[grammarKey];
  /* c8 ignore next 3 -- defensive; caller validates before reaching here */
  if (!entry) {
    return null;
  }

  const pkgDir = dirname(require.resolve(`${entry.pkg}/package.json`));
  const wasmPath = join(pkgDir, entry.wasm);

  const lang = await Language.load(wasmPath);
  grammarCache.set(grammarKey, lang);
  return lang;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Build a fallback return. */
function fallback(reason) {
  return { blocks: null, language: null, fallback: true, reason };
}

/**
 * Resolve the grammar key for a file extension.
 * Returns the grammar key string or null if unsupported.
 *
 * For `.tsx` files we use the 'tsx' grammar rather than 'typescript'.
 */
function resolveGrammarKey(filePath) {
  const ext = extname(filePath).toLowerCase();
  const grammarName = LANGUAGE_GRAMMARS[ext];
  if (!grammarName) return null;

  // tsx needs its own WASM grammar
  if (ext === '.tsx') return 'tsx';
  return grammarName;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract function/method blocks that enclose the given changed lines.
 *
 * @param {string} filePath       - File name/path (used for extension detection)
 * @param {string} fileContent    - Full file content
 * @param {number[]} changedLines - 1-indexed line numbers that changed
 * @param {string} [language]     - Override language (unused for now; reserved)
 * @returns {Promise<{blocks: string[]|null, language: string|null, fallback: boolean, reason?: string}>}
 */
// TODO(M-extra): honor explicit _language override to bypass extension-based detection
export async function extractFunctionBlocks(filePath, fileContent, changedLines, _language) {
  // --- Guard: empty content ---
  if (!fileContent || fileContent.trim().length === 0) {
    return fallback('empty_content');
  }

  // --- Resolve grammar ---
  const grammarKey = resolveGrammarKey(filePath);
  if (!grammarKey) {
    return fallback('unsupported_language');
  }

  // --- Init tree-sitter + load grammar ---
  await ensureInit();
  const lang = await loadGrammar(grammarKey);
  /* c8 ignore next 3 -- defensive */
  if (!lang) {
    return fallback('unsupported_language');
  }

  // --- Parse ---
  const parser = new Parser();
  try {
    parser.setLanguage(lang);
    const tree = parser.parse(fileContent);

    try {
      // --- Check for parse errors ---
      if (tree.rootNode.hasError) {
        // If the *entire* root is an error (e.g. totally malformed), treat as parse_error.
        // We check if ALL top-level children are errors, or if the root itself is an error node.
        const topChildren = tree.rootNode.children;
        const allErrors = topChildren.length > 0 && topChildren.every((c) => c.isError);
        if (tree.rootNode.isError || allErrors) {
          return fallback('parse_error');
        }
      }

      // --- Resolve block types for this language ---
      const grammarName = LANGUAGE_GRAMMARS[extname(filePath).toLowerCase()];
      const blockTypes = BLOCK_TYPES[grammarName] || [];

      // --- Find all function nodes ---
      const allFuncNodes = tree.rootNode.descendantsOfType(blockTypes);

      // --- For each changed line, find the innermost enclosing function ---
      const seen = new Set(); // deduplicate by node id
      const blocks = [];

      for (const line of changedLines) {
        const row = line - 1; // tree-sitter rows are 0-indexed

        // Find all function nodes that span this row
        let innermost = null;
        let innermostSize = Infinity;

        for (const fn of allFuncNodes) {
          if (fn.startPosition.row <= row && fn.endPosition.row >= row) {
            const size = fn.endIndex - fn.startIndex;
            if (size < innermostSize) {
              innermost = fn;
              innermostSize = size;
            }
          }
        }

        if (innermost && !seen.has(innermost.id)) {
          seen.add(innermost.id);
          blocks.push(innermost.text);
        }
      }

      // --- No enclosing block found for any changed line ---
      if (blocks.length === 0) {
        return fallback('no_enclosing_block');
      }

      return { blocks, language: grammarName, fallback: false };
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}
