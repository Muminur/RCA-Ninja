import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';

/**
 * Walk outputDir recursively for .md files, parse frontmatter via gray-matter,
 * and separate files with an `auto_filled` field from clean ones.
 *
 * @param {{ outputDir: string }} options
 * @returns {{ degraded: Array<{path: string, auto_filled: string[]}>, clean_count: number }}
 */
export function auditCorpus({ outputDir }) {
  const degraded = [];
  let clean_count = 0;

  let entries;
  try {
    entries = readdirSync(outputDir, { recursive: true, withFileTypes: true });
  } catch {
    return { degraded, clean_count };
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!name.endsWith('.md')) continue;

    // entry.parentPath is Node 20+; fall back to entry.path for older Node
    const dir = entry.parentPath ?? entry.path;
    const fullPath = join(dir, name);

    let content;
    try {
      content = readFileSync(fullPath, 'utf8');
    } catch {
      // Unreadable file — skip silently
      continue;
    }

    const { data } = matter(content);

    if (data.auto_filled && Array.isArray(data.auto_filled) && data.auto_filled.length > 0) {
      degraded.push({ path: fullPath, auto_filled: data.auto_filled });
    } else {
      clean_count++;
    }
  }

  return { degraded, clean_count };
}
