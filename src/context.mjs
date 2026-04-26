import * as git from './util/git.mjs';
import { RcaError } from './errors.mjs';

const MAX_DIFF_BYTES = 200 * 1024;

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
  };
}
