import * as git from './util/git.mjs';
import { run } from './util/exec.mjs';
import { RcaError } from './errors.mjs';

const MAX_DIFF_BYTES = 200 * 1024;

export const DEFAULT_SKIP_FILES = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'npm-shrinkwrap.json',
  'composer.lock',
  '*.min.js',
  '*.min.css',
  '*.map',
  'dist/**',
  'build/**',
  '.next/**',
  'coverage/**',
];

/**
 * Minimal glob matcher.
 * - star         -> any chars except "/"
 * - star-star-/  -> any path prefix (zero or more directory components)
 * - star-star    -> matches anything including "/"
 * - literals     -> exact match
 * @param {string} filePath
 * @param {string} pattern
 * @returns {boolean}
 */
function matchesGlob(filePath, pattern) {
  // Escape regex special chars except * which we handle specially
  const SPECIAL = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);
  const escapeNonStar = (s) =>
    s
      .split('')
      .map((ch) => (SPECIAL.has(ch) ? '\\' + ch : ch))
      .join('');

  // Build a regex from the glob pattern token-by-token
  let regexStr = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      // ** — check for **/ prefix (start of pattern) or standalone **
      if (i === 0 && pattern[i + 2] === '/') {
        // **/ at the start: match any leading path prefix (zero or more dirs)
        regexStr += '(?:.+/)?';
        i += 3;
      } else {
        // ** anywhere else: match any sequence of chars including /
        regexStr += '.*';
        i += 2;
      }
    } else if (pattern[i] === '*') {
      // * — match any chars except /
      regexStr += '[^/]*';
      i += 1;
    } else {
      regexStr += escapeNonStar(pattern[i]);
      i += 1;
    }
  }

  return new RegExp('^' + regexStr + '$').test(filePath);
}

/**
 * Filter a unified diff, removing binary-file sections and sections whose
 * file path matches one of the skip patterns.
 *
 * @param {string} diff - full unified diff string
 * @param {{ skipFiles?: string[], skipBinary?: boolean }} [options]
 * @returns {{ content: string, filesSkipped: string[] }}
 */
export function filterDiff(diff, options = {}) {
  const { skipFiles = DEFAULT_SKIP_FILES, skipBinary = true } = options;

  // Split into per-file sections; each starts with "diff --git a/..."
  // Use a lookahead so the delimiter stays at the start of each chunk.
  const sections = diff.split(/(?=^diff --git )/m);

  const kept = [];
  const filesSkipped = [];

  for (const section of sections) {
    if (!section.trim()) continue;

    // Extract the file path from the "diff --git a/<path> b/<path>" header
    // Prefer the b/ (post-change) path; fall back to a/ for pure deletes.
    const headerMatch = section.match(/^diff --git a\/(.*?) b\/(.*?)$/m);
    const filePath = headerMatch ? headerMatch[2] : null;

    // Check for binary section
    if (skipBinary && /^Binary files /m.test(section)) {
      if (filePath) filesSkipped.push(filePath);
      continue;
    }

    // Check against skip patterns
    if (filePath && skipFiles.some((pattern) => matchesGlob(filePath, pattern))) {
      filesSkipped.push(filePath);
      continue;
    }

    kept.push(section);
  }

  return { content: kept.join(''), filesSkipped };
}

/**
 * Truncate a unified diff at hunk boundaries so we never send Claude a half-hunk.
 * Returns { content, truncated }.
 * @param {string} diff
 * @param {number} maxBytes
 * @returns {{ content: string, truncated: boolean }}
 */
export function truncateDiff(diff, maxBytes = MAX_DIFF_BYTES) {
  if (Buffer.byteLength(diff) <= maxBytes) return { content: diff, truncated: false };

  // Split on hunk headers (@@) preserving the delimiter at the start of each chunk
  const parts = diff.split(/(?=^@@)/m);
  let result = '';
  for (const part of parts) {
    const candidate = result + part;
    if (Buffer.byteLength(candidate) > maxBytes) break;
    result = candidate;
  }
  return { content: result, truncated: true };
}

/**
 * Find the commit that last touched any of the given files before the fix commit.
 * Returns { commit, author, date } or null.
 * @param {string[]} filesChanged - list of files changed by the fix commit
 * @param {string} cwd - working directory (git repo root)
 * @param {string} [ref='HEAD'] - the fix commit ref; we look at <ref>^ and earlier
 */
export async function getBugIntroducedBy(filesChanged, cwd, ref = 'HEAD') {
  if (!filesChanged || filesChanged.length === 0) return null;

  // We search in the history *before* the fix commit (ref^).
  // git log <ref>^ --follow -1 -- <file> finds the last commit touching the file
  // before the fix (Added or Modified). Using \x1f as delimiter to handle
  // author names and ISO dates that may contain colons or spaces.
  const FORMAT = '%H\x1f%an\x1f%aI';

  for (const file of filesChanged) {
    try {
      const { stdout } = await run(
        'git',
        ['log', `${ref}^`, '--follow', '-1', `--format=${FORMAT}`, '--', file],
        { cwd },
      );
      const trimmed = stdout.trim();
      if (!trimmed) continue;
      const parts = trimmed.split('\x1f');
      if (parts.length < 3) continue;
      const [fullHash, author, date] = parts;
      if (!fullHash) continue;
      // Use the short 7-char hash to match project conventions
      const commit = fullHash.slice(0, 7);
      return { commit, author: author.trim(), date: date.trim() };
    } catch {
      // If ref^ doesn't exist (single-commit repo) or file has no prior history, skip
      continue;
    }
  }

  return null;
}

export async function buildContext({ cwd = process.cwd(), ref = 'HEAD', logs = null, config = null } = {}) {
  let resolvedRef;
  try {
    resolvedRef = await git.revParse(ref, cwd);
  } catch {
    throw new RcaError('NO_DIFF', { ref });
  }

  const [repoRoot, hash, msg, auth, br, rawDiff, files, ts] = await Promise.all([
    git.repoRoot(cwd),
    git.shortHash(ref, cwd),
    git.commitMessage(ref, cwd),
    git.author(ref, cwd).catch(() => null),
    git.branch(cwd),
    git.diff(ref, cwd),
    git.filesChanged(ref, cwd),
    git.timestamp(ref, cwd),
  ]);

  if (!rawDiff || rawDiff.trim().length === 0) {
    throw new RcaError('NO_DIFF', { ref });
  }

  const configSkip = config?.diff_filter?.skip_files ?? DEFAULT_SKIP_FILES;
  const configSkipBinary = config?.diff_filter?.skip_binary ?? true;
  const { content: filteredDiff, filesSkipped } = filterDiff(rawDiff, {
    skipFiles: configSkip,
    skipBinary: configSkipBinary,
  });

  const { content: diffContent, truncated: diffTruncated } = truncateDiff(filteredDiff);

  const isoDate = new Date(ts).toISOString().replace(/\.\d{3}Z$/, 'Z');

  const bugIntroducedBy = await getBugIntroducedBy(files, cwd, ref).catch(() => null);

  return {
    repo_root: repoRoot,
    cwd,
    branch: br,
    ref: resolvedRef,
    short_hash: hash,
    commit_message: msg,
    author: auth,
    files_changed: files,
    diff: diffContent,
    diff_truncated: diffTruncated,
    files_filtered: filesSkipped,
    logs,
    timestamp_utc: isoDate,
    bug_introduced_by: bugIntroducedBy,
  };
}

/**
 * Return all commits in the range since..HEAD whose subject starts with
 * `fix:` or `fix(...)` (Conventional Commits). No Claude round-trip.
 * @param {{ cwd: string, since: string }} opts
 * @returns {Promise<Array<{ hash: string, subject: string }>>}
 */
export async function getFixCommits({ cwd, since }) {
  let stdout;
  try {
    ({ stdout } = await run('git', ['log', `${since}..HEAD`, '--format=%H %s'], { cwd }));
  } catch {
    return [];
  }

  const commits = [];
  for (const line of stdout.trim().split('\n')) {
    if (!line.trim()) continue;
    const spaceIdx = line.indexOf(' ');
    if (spaceIdx === -1) continue;
    const hash = line.slice(0, spaceIdx);
    const subject = line.slice(spaceIdx + 1);
    if (/^fix[:(]/.test(subject)) {
      commits.push({ hash, subject });
    }
  }
  return commits;
}
