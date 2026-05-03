import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { loadManifest } from './manifest.mjs';

export function findRelatedRcas({ outputDir, filesChanged, title: _title }) {
  const mdFiles = [];
  try {
    const entries = readdirSync(outputDir, { recursive: true });
    for (const entry of entries) {
      if (typeof entry === 'string' && entry.endsWith('.md')) {
        mdFiles.push(join(outputDir, entry));
      }
    }
  } catch {
    return [];
  }

  const changedSet = new Set(filesChanged || []);
  if (changedSet.size === 0) return [];

  const related = [];
  for (const filePath of mdFiles) {
    try {
      const content = readFileSync(filePath, 'utf8');
      const { data } = matter(content);
      if (!data.files || !Array.isArray(data.files)) continue;

      const sharedFiles = data.files.filter((f) => changedSet.has(f));
      const overlapScore = sharedFiles.length / changedSet.size;

      if (overlapScore > 0.5) {
        related.push({
          path: filePath,
          title: data.title || '',
          overlap_score: Math.round(overlapScore * 100) / 100,
          shared_files: sharedFiles,
        });
      }
    } catch {
      continue;
    }
  }

  return related.sort((a, b) => b.overlap_score - a.overlap_score);
}

/**
 * Extracts the text under `## Root Cause` from a markdown body string.
 * Returns empty string if section is not found.
 * @param {string} body
 * @returns {string}
 */
function extractRootCause(body) {
  const match = body.match(/^## Root Cause\s*\n([\s\S]*?)(?=\n## |\s*$)/m);
  if (!match) return '';
  return match[1].trim();
}

/**
 * Converts a gray-matter date value (may be JS Date or string) to YYYY-MM-DD string.
 * @param {*} val
 * @returns {string}
 */
function toDateString(val) {
  if (!val) return '';
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  const s = String(val);
  if (s.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s;
}

/**
 * Returns up to `limit` prior RCAs related to `filesChanged`, reading their full
 * markdown to extract root_cause text.
 *
 * @param {{ outputDir: string, filesChanged: string[], limit?: number }} opts
 * @returns {Array<{ title: string, root_cause: string, date: string, files: string[] }>}
 */
export function readPriorRcas({ outputDir, filesChanged, limit = 3 }) {
  const related = findRelatedRcas({ outputDir, filesChanged });
  const top = related.slice(0, limit);

  const results = [];
  for (const entry of top) {
    try {
      const content = readFileSync(entry.path, 'utf8');
      const { data, content: body } = matter(content);
      const rawRootCause = extractRootCause(body);
      const root_cause = rawRootCause.slice(0, 500);
      results.push({
        title: entry.title,
        root_cause,
        date: toDateString(data.date),
        files: Array.isArray(data.files) ? data.files : [],
      });
    } catch {
      // skip unreadable files
    }
  }
  return results;
}

/**
 * Returns up to 5 manifest entries that share at least one file with `filesChanged`,
 * sorted by date descending.
 *
 * @param {{ outputDir: string, filesChanged: string[] }} opts
 * @returns {Array<{ id: string, title: string, date: string }>}
 */
export function detectRecurrences({ outputDir, filesChanged }) {
  const entries = loadManifest(outputDir);
  if (entries.length === 0) return [];

  const changedSet = new Set(filesChanged || []);
  if (changedSet.size === 0) return [];

  const overlapping = entries.filter((e) => {
    if (!Array.isArray(e.files)) return false;
    return e.files.some((f) => changedSet.has(f));
  });

  overlapping.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  return overlapping.slice(0, 5).map(({ id, title, date }) => ({ id, title, date }));
}
