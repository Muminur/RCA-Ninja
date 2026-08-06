import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { RcaError } from './errors.mjs';
import { atomicWrite } from './util/fs.mjs';
import { buildContext } from './context.mjs';
import { generate } from './generator.mjs';
import { renderRca } from './renderer.mjs';
import { rebuildManifest } from './manifest.mjs';
import { readPriorRcas } from './dedup.mjs';

/**
 * Walk outputDir recursively and return all .md files (not starting with _).
 * @param {string} dir
 * @returns {string[]} absolute file paths
 */
function walkMdFiles(dir) {
  const results = [];
  let items;
  try {
    items = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const item of items) {
    const fullPath = join(dir, item.name);
    if (item.isDirectory()) {
      results.push(...walkMdFiles(fullPath));
    } else if (item.name.endsWith('.md') && !item.name.startsWith('_')) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Amend an existing RCA by re-running generation with an optional correction hint.
 *
 * @param {{
 *   id: string,
 *   correctionHint?: string,
 *   outputDir: string,
 *   cwd: string,
 *   config: Object,
 *   systemPromptPath: string,
 *   schemaPath: string,
 *   _buildContextFn?: Function,
 *   _rebuildManifestFn?: Function,
 * }} options
 * @returns {Promise<{ path: string }>}
 */
export async function amendRca({
  id,
  correctionHint,
  outputDir,
  cwd,
  config,
  systemPromptPath,
  schemaPath,
  _buildContextFn = buildContext,
  _rebuildManifestFn = rebuildManifest,
  _readPriorRcasFn = readPriorRcas,
}) {
  // Find the matching .md file
  const allFiles = walkMdFiles(outputDir);
  const matched = allFiles.find((filePath) => filePath.includes(id));

  if (!matched) {
    throw new RcaError('NOT_FOUND', { id });
  }

  // Read frontmatter to get ref and other metadata
  const raw = readFileSync(matched, 'utf8');
  const { data: frontmatter } = matter(raw);

  const ref = frontmatter.ref || 'HEAD';

  // Build context using the original commit ref
  const context = await _buildContextFn({ cwd, ref });

  // Load prior RCAs for recurrence context (same as initial generation)
  const priorRcas = _readPriorRcasFn({ outputDir, filesChanged: context.files_changed });

  // Generate the updated RCA (passing correctionHint and prior context through)
  const { rca } = await generate({
    context,
    config,
    systemPromptPath,
    schemaPath,
    correctionHint,
    priorRcas,
  });

  // Render and write atomically (overwrite in place)
  const md = renderRca(rca, context);
  await atomicWrite(matched, md);

  // Rebuild manifest to reflect the updated content
  await _rebuildManifestFn(outputDir);

  return { path: matched };
}
