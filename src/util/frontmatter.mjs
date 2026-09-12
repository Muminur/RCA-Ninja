import matter from 'gray-matter';

// A git short hash is an opaque string, but YAML reads unquoted scalars as
// numbers whenever they look like one — and a 7-char hex hash often does:
//   0012345 -> 5349 (octal)   123e456 -> Infinity   0x12345 -> 74565
// The mangled value then flows into manifest ids, prior_bugs cross-links, and
// amend(), which hands it straight to git. Recover the verbatim text from the
// raw frontmatter instead of trusting the parsed value.
const REF_LINE = /^ref:[ \t]*(.*)$/m;

function unquote(raw) {
  const s = raw.trim();
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/**
 * gray-matter, but `data.ref` is always the string the file actually contains.
 * @param {string} content - full markdown document
 * @returns {{ data: Record<string, any>, content: string, matter: string }}
 */
export function parseRca(content) {
  const parsed = matter(content);
  const raw = typeof parsed.matter === 'string' ? parsed.matter : '';
  const m = REF_LINE.exec(raw);
  if (m) {
    const value = unquote(m[1]);
    if (value) parsed.data.ref = value;
  }
  return parsed;
}
