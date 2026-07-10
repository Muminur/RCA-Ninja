import { mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
  const base = computeRcaPath({ outputDir, date, shortHash, title, maxSlugWords });
  mkdirSync(dirname(base), { recursive: true });

  // Derive every collision candidate from the original stem. Stripping a trailing
  // -\d+ off the previous candidate instead would eat a slug that legitimately
  // ends in a number: "...-crash-module-42.md" became "...-crash-module-2.md".
  const stem = base.slice(0, -'.md'.length);

  // Reserve the name with O_EXCL rather than checking existsSync() first: two
  // concurrent generate runs (the post-commit hook backgrounds one) could both
  // pass the check and then have the second rename silently clobber the first.
  let candidate = base;
  let suffix = 1;
  let fd;
  for (;;) {
    try {
      fd = openSync(candidate, 'wx');
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      suffix += 1;
      candidate = `${stem}-${suffix}.md`;
    }
  }
  closeSync(fd);

  try {
    await atomicWrite(candidate, content);
  } catch (err) {
    try {
      unlinkSync(candidate);
    } catch {
      /* leave the reservation behind rather than mask the real error */
    }
    throw err;
  }

  return { path: candidate };
}
