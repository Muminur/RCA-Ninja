import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { slugify } from './slug.mjs';
import { atomicWrite } from './util/fs.mjs';

export function computeRcaPath({ outputDir, date, shortHash, title, maxSlugWords = 5 }) {
  const [yyyy, mm, dd] = date.split('-');
  const slug = slugify(title, maxSlugWords);
  const basename = `RCA-${yyyy}-${mm}-${dd}-${shortHash}-${slug}.md`;
  const dir = join(outputDir, yyyy, mm);
  const fullPath = resolve(dir, basename);

  if (!fullPath.startsWith(resolve(outputDir))) {
    return resolve(dir, 'RCA-' + yyyy + '-' + mm + '-' + dd + '-' + shortHash + '-untitled.md');
  }

  return fullPath;
}

export async function writeRca({ outputDir, content, date, shortHash, title, maxSlugWords = 5 }) {
  let candidate = computeRcaPath({ outputDir, date, shortHash, title, maxSlugWords });
  let suffix = 1;

  while (existsSync(candidate)) {
    suffix++;
    const base = candidate.replace(/(-\d+)?\.md$/, '');
    candidate = `${base}-${suffix}.md`;
  }

  await atomicWrite(candidate, content);

  return { path: candidate };
}
