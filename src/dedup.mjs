import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';

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
