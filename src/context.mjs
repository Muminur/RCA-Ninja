import * as git from './util/git.mjs';
import { run } from './util/exec.mjs';
import { RcaError } from './errors.mjs';
import { isTriggeringCommit } from './triggers.mjs';

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
  '*.snap',
  '__snapshots__/**',
  '*.generated.*',
  'vendor/**',
  'third_party/**',
  'node_modules/**',
  '*.lock.json',
  '*.min.*',
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
 * Walk a unified diff and truncate each per-file section at hunk boundaries
 * so that no single file exceeds `capBytes`. Files that were truncated are
 * listed in `files_capped`.
 *
 * @param {string} diff - full unified diff string
 * @param {number} capBytes - maximum bytes allowed per file section
 * @returns {{ diff: string, files_capped: string[] }}
 */
export function applyPerFileCap(diff, capBytes) {
  if (!diff) return { diff: '', files_capped: [] };

  const fileSections = diff.split(/(?=^diff --git )/m);
  const kept = [];
  const filesCapped = [];

  for (const section of fileSections) {
    if (!section.trim()) continue;

    // Extract file path from header
    const headerMatch = section.match(/^diff --git a\/(.*?) b\/(.*?)$/m);
    const filePath = headerMatch ? headerMatch[2] : null;

    const sectionBytes = Buffer.byteLength(section);
    if (sectionBytes <= capBytes) {
      kept.push(section);
      continue;
    }

    // Split into file header (before first @@) and hunks
    const hunkSplitIdx = section.search(/^@@/m);
    if (hunkSplitIdx === -1) {
      // No hunks — just a header (e.g., new file mode). Keep it under cap.
      if (Buffer.byteLength(section) <= capBytes) {
        kept.push(section);
      } else if (filePath) {
        filesCapped.push(filePath);
      }
      continue;
    }

    const fileHeader = section.slice(0, hunkSplitIdx);
    const hunksStr = section.slice(hunkSplitIdx);
    const hunks = hunksStr.split(/(?=^@@)/m);

    let assembled = fileHeader;
    let anyDropped = false;

    for (const hunk of hunks) {
      if (!hunk.trim()) continue;
      const candidate = assembled + hunk;
      if (Buffer.byteLength(candidate) > capBytes) {
        anyDropped = true;
        break;
      }
      assembled = candidate;
    }

    kept.push(assembled);
    if (anyDropped && filePath) {
      filesCapped.push(filePath);
    }
  }

  return { diff: kept.join(''), files_capped: filesCapped };
}

/**
 * Regex matching import/require/from/use/using statements across languages.
 * Used to identify non-substantive diff hunks.
 */
const IMPORT_RE = /^\s*(import\s|from\s|require\s*\(|use\s|using\s)/;

/**
 * Check whether a hunk contains only import/whitespace changes.
 * Context lines (prefixed with space) and diff metadata (\\ No newline...)
 * are ignored when scoring.
 *
 * @param {string} hunk - a single hunk string starting with @@
 * @returns {boolean} true if all +/- lines are imports or whitespace
 */
function isImportOrWhitespaceOnlyHunk(hunk) {
  const lines = hunk.split('\n');
  let hasChangedLines = false;

  for (const line of lines) {
    // Skip hunk header, context lines, and backslash metadata
    if (line.startsWith('@@') || line.startsWith(' ') || line.startsWith('\\') || line === '') {
      continue;
    }

    if (line.startsWith('+') || line.startsWith('-')) {
      hasChangedLines = true;
      const content = line.slice(1); // strip the +/- prefix

      // Whitespace-only (including empty after stripping prefix)
      if (content.trim() === '') continue;

      // Import/require/from/use/using statement
      if (IMPORT_RE.test(content)) continue;

      // Also match closing parens for multi-line imports like Go's `import (`
      if (/^\s*\)\s*$/.test(content)) continue;

      // Also match bare string lines inside Go import blocks like `"fmt"`
      if (/^\s*"[^"]*"\s*$/.test(content)) continue;

      // This line is substantive — hunk is not import-only
      return false;
    }
  }

  // Only consider it import/ws-only if there were actual changed lines
  return hasChangedLines;
}

/**
 * Parse a unified diff into per-file groups of hunks. For each file, if a
 * hunk is import/whitespace-only AND the file has at least one other hunk,
 * drop it. Returns the cleaned diff and a count of dropped hunks.
 *
 * @param {string} diff - full unified diff string
 * @returns {{ diff: string, hunks_dropped: number }}
 */
export function dropImportOnlyHunks(diff) {
  if (!diff) return { diff: '', hunks_dropped: 0 };

  const fileSections = diff.split(/(?=^diff --git )/m);
  const result = [];
  let totalDropped = 0;

  for (const section of fileSections) {
    if (!section.trim()) continue;

    // Split into file header (before first @@) and hunks
    const hunkSplitIdx = section.search(/^@@/m);
    if (hunkSplitIdx === -1) {
      // No hunks — keep the section as-is
      result.push(section);
      continue;
    }

    const fileHeader = section.slice(0, hunkSplitIdx);
    const hunksStr = section.slice(hunkSplitIdx);
    const hunks = hunksStr.split(/(?=^@@)/m).filter((h) => h.trim());

    // Only drop import-only hunks if the file has more than one hunk
    if (hunks.length <= 1) {
      result.push(section);
      continue;
    }

    // Classify each hunk
    const substantiveHunks = [];
    const importOnlyHunks = [];

    for (const hunk of hunks) {
      if (isImportOrWhitespaceOnlyHunk(hunk)) {
        importOnlyHunks.push(hunk);
      } else {
        substantiveHunks.push(hunk);
      }
    }

    // If ALL hunks are import-only, keep them all (don't drop everything)
    if (substantiveHunks.length === 0) {
      result.push(section);
      continue;
    }

    // Drop import-only hunks, keep substantive ones
    totalDropped += importOnlyHunks.length;
    result.push(fileHeader + substantiveHunks.join(''));
  }

  return { diff: result.join(''), hunks_dropped: totalDropped };
}

const BLAME_MAX_FILES = 10;
const BLAME_MAX_LINES_PER_FILE = 200;
// %at (unix seconds) orders commits correctly across timezone offsets; %aI is
// only there because it is what the frontmatter prints.
const BLAME_FORMAT = '%H\x1f%an\x1f%aI\x1f%at';

function isSkipped(file, skipFiles) {
  return skipFiles.some((pattern) => matchesGlob(file, pattern));
}

/**
 * Map each file in a unified diff to the parent-side line numbers the patch
 * deletes. The hunk body is walked rather than trusting the `@@ -a,b @@` span,
 * because git.diff() passes -W and that widens the span to whole functions.
 * @param {string|null} diff
 * @returns {Map<string, number[]>}
 */
function deletedLinesByFile(diff) {
  const byFile = new Map();
  if (!diff) return byFile;

  for (const section of diff.split(/(?=^diff --git )/m)) {
    // A wholesale deletion is "+++ /dev/null", and it is exactly the case whose
    // lines matter most, so fall back to the pre-image path.
    const post = /^\+\+\+ (?:b\/)?(.+)$/m.exec(section);
    const pre = /^--- (?:a\/)?(.+)$/m.exec(section);
    const postPath = post ? post[1].trim() : '';
    const prePath = pre ? pre[1].trim() : '';
    const file = postPath && postPath !== '/dev/null' ? postPath : prePath;
    if (!file || file === '/dev/null') continue;

    const lines = [];
    let parentLine = 0;
    for (const line of section.split('\n')) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+/.exec(line);
      if (hunk) {
        parentLine = Number(hunk[1]);
        continue;
      }
      // Everything before the first @@ is header (including "--- a/path").
      if (parentLine === 0) continue;
      if (line.startsWith('-')) {
        lines.push(parentLine);
        parentLine += 1;
      } else if (line.startsWith(' ')) {
        parentLine += 1;
      }
      // "+" lines and "\ No newline at end of file" do not advance the parent.
    }
    if (lines.length > 0) byFile.set(file, lines);
  }
  return byFile;
}

/** Collapse a sorted line-number list into contiguous [start, end] ranges. */
function toRanges(lines) {
  const ranges = [];
  let start = lines[0];
  let prev = lines[0];
  for (const n of lines.slice(1)) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    ranges.push([start, prev]);
    start = n;
    prev = n;
  }
  ranges.push([start, prev]);
  return ranges;
}

async function addBlameVotes(file, ranges, cwd, ref, votes) {
  for (const [from, to] of ranges) {
    try {
      const { stdout } = await run(
        'git',
        ['blame', '--porcelain', '-L', `${from},${to}`, `${ref}^`, '--', file],
        { cwd },
      );
      // Porcelain emits "<sha40> <origline> <finalline>[ <numlines>]" per line.
      for (const m of stdout.matchAll(/^([0-9a-f]{40}) \d+ \d+/gm)) {
        votes.set(m[1], (votes.get(m[1]) || 0) + 1);
      }
    } catch {
      // File absent from the parent, or ref^ does not exist — best effort.
    }
  }
}

async function resolveCommit(sha, cwd) {
  try {
    const { stdout } = await run('git', ['log', '-1', `--format=${BLAME_FORMAT}`, sha], { cwd });
    const parts = stdout.trim().split('\x1f');
    if (parts.length < 4 || !parts[0]) return null;
    return {
      commit: parts[0].slice(0, 7),
      author: parts[1].trim(),
      date: parts[2].trim(),
      epoch: Number(parts[3]) || 0,
    };
  } catch {
    return null;
  }
}

/**
 * Find the commit that introduced the code this fix removed.
 *
 * With a diff: blame the parent-side lines the patch actually deletes, pooling
 * one vote per line across every changed file. The previous heuristic returned
 * the last commit to touch the *first* entry of `filesChanged` — that is git's
 * path order, so a README.md touch outranked src/auth.js, and "last commit to
 * touch the file" is usually the previous fix rather than the introducer.
 *
 * Without a diff, or when the fix only adds lines, it falls back to one vote
 * per file for the last commit that touched it before `ref`.
 *
 * Best effort: returns null rather than throwing.
 *
 * @param {string[]} filesChanged - files changed by the fix commit
 * @param {string} cwd - working directory inside the repo
 * @param {string} [ref='HEAD'] - the fix commit; history is read from <ref>^
 * @param {string|null} [diff=null] - the fix commit's unified diff
 * @returns {Promise<{commit: string, author: string, date: string}|null>}
 */
export async function getBugIntroducedBy(filesChanged, cwd, ref = 'HEAD', diff = null) {
  if (!filesChanged || filesChanged.length === 0) return null;

  const candidates = filesChanged.filter((f) => f && !isSkipped(f, DEFAULT_SKIP_FILES));
  if (candidates.length === 0) return null;

  const votes = new Map();
  const deleted = deletedLinesByFile(diff);

  let blamedFiles = 0;
  for (const file of candidates) {
    if (blamedFiles >= BLAME_MAX_FILES) break;
    const lines = deleted.get(file);
    if (!lines || lines.length === 0) continue;
    blamedFiles += 1;
    await addBlameVotes(file, toRanges(lines.slice(0, BLAME_MAX_LINES_PER_FILE)), cwd, ref, votes);
  }

  if (votes.size === 0) {
    for (const file of candidates) {
      try {
        const { stdout } = await run(
          'git',
          ['log', `${ref}^`, '--follow', '-1', '--format=%H', '--', file],
          { cwd },
        );
        const sha = stdout.trim().split('\n')[0];
        if (sha) votes.set(sha, (votes.get(sha) || 0) + 1);
      } catch {
        continue;
      }
    }
  }

  if (votes.size === 0) return null;

  const topVotes = Math.max(...votes.values());
  let best = null;
  for (const [sha, count] of votes) {
    if (count !== topVotes) continue;
    const resolved = await resolveCommit(sha, cwd);
    if (!resolved) continue;
    // Tie on votes goes to the older commit — the earlier introduction.
    if (!best || resolved.epoch < best.epoch) best = resolved;
  }
  if (!best) return null;
  return { commit: best.commit, author: best.author, date: best.date };
}

export async function buildContext({
  cwd = process.cwd(),
  ref = 'HEAD',
  logs = null,
  config = null,
} = {}) {
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

  const bugIntroducedBy = await getBugIntroducedBy(files, cwd, ref, rawDiff).catch(() => null);

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
 * Return the commits in `since..HEAD` that should get an RCA, newest first, as
 * decided by isTriggeringCommit(). No provider round-trip.
 *
 * The name predates the configurable trigger; it still covers `fix:` by
 * default, plus whatever `triggers.commit_types` adds and any commit whose
 * body closes a reported issue.
 *
 * @param {{ cwd: string, since: string, config?: object|null }} opts
 * @returns {Promise<Array<{ hash: string, subject: string, message: string }>>}
 */
export async function getFixCommits({ cwd, since, config = null }) {
  let stdout;
  try {
    // %B, not %s: closing keywords live in the body, and GitHub's squash-merge
    // default puts the PR description there. \x1f separates hash from message,
    // \x1e separates records, so multi-line bodies survive parsing.
    ({ stdout } = await run('git', ['log', `${since}..HEAD`, '--format=%H%x1f%B%x1e'], { cwd }));
  } catch {
    return [];
  }

  const commits = [];
  for (const record of stdout.split('\x1e')) {
    const sepIdx = record.indexOf('\x1f');
    if (sepIdx === -1) continue;
    const hash = record.slice(0, sepIdx).trim();
    const message = record.slice(sepIdx + 1).trim();
    if (!hash || !message) continue;
    if (!isTriggeringCommit({ message, config })) continue;
    commits.push({ hash, subject: message.split('\n')[0].trim(), message });
  }
  return commits;
}
