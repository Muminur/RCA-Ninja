// The single answer to "does this commit deserve an RCA".
//
// It used to live in two places that disagreed: hooks/post-commit matched
// `fix:` on the subject with a shell `case`, and getFixCommits() matched the
// same thing with a regex. Both read the subject only, so a `feat:` commit that
// resolved a reported bug was never analysed — and on GitHub's squash-merge
// default the PR description, where the closing keyword lives, is the body.

export const TRIGGER_DEFAULTS = Object.freeze({
  commit_types: Object.freeze(['fix']),
  closes_issue: true,
});

// "Fixes #12", "Closed #7", "resolves #142" — GitHub's closing keywords.
const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#\d+\b/i;

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * Resolve the effective trigger settings from a loaded config.
 * @param {{ triggers?: { commit_types?: string[], closes_issue?: boolean } }|null} config
 * @returns {{ commit_types: string[], closes_issue: boolean }}
 */
export function triggerSettings(config) {
  const t = config?.triggers ?? {};
  const types =
    Array.isArray(t.commit_types) && t.commit_types.length > 0
      ? t.commit_types
      : TRIGGER_DEFAULTS.commit_types;
  return {
    commit_types: types,
    closes_issue: t.closes_issue === undefined ? TRIGGER_DEFAULTS.closes_issue : !!t.closes_issue,
  };
}

/** First line that is neither blank nor a git comment. */
function subjectOf(message) {
  for (const line of message.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) return trimmed;
  }
  return '';
}

/**
 * @param {{ message?: string, config?: object|null }} opts - `message` is the
 *   full commit message (git `%B`), not just the subject.
 * @returns {boolean}
 */
export function isTriggeringCommit({ message, config = null } = {}) {
  if (!message || typeof message !== 'string') return false;

  const { commit_types, closes_issue } = triggerSettings(config);

  const subject = subjectOf(message);
  if (subject) {
    const types = commit_types.map((t) => String(t).replace(REGEX_SPECIAL, '\\$&')).join('|');
    if (new RegExp(`^(?:${types})(?:\\([^)]*\\))?!?:`).test(subject)) return true;
  }

  return closes_issue && CLOSING_KEYWORD.test(message);
}
