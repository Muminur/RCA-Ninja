import * as git from './util/git.mjs';
import { run } from './util/exec.mjs';
import { RcaError } from './errors.mjs';

const MAX_DIFF_BYTES = 200 * 1024;

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

export async function buildContext({ cwd = process.cwd(), ref = 'HEAD', logs = null } = {}) {
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

  let diffContent = rawDiff;
  let diffTruncated = false;
  if (Buffer.byteLength(diffContent) > MAX_DIFF_BYTES) {
    diffContent = diffContent.slice(0, MAX_DIFF_BYTES);
    diffTruncated = true;
  }

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
