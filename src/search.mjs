import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, basename, relative, isAbsolute } from 'node:path';
import { run } from './util/exec.mjs';
import { RcaError } from './errors.mjs';
import { loadManifest } from './manifest.mjs';

function rgInstallHint() {
  const platform = process.platform;
  if (platform === 'darwin') return 'brew install ripgrep';
  if (platform === 'linux') return 'sudo apt-get install -y ripgrep';
  return 'See https://github.com/BurntSushi/ripgrep#installation';
}

function isMissingRg(err) {
  return err?.code === 'ENOENT' || err?.spawnError?.code === 'ENOENT';
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Run ripgrep, distinguishing its exit codes: 0 = matches, 1 = no matches,
 * 2 = error. Collapsing 1 and 2 into "no results" hid every bad-pattern error.
 * A missing binary is detected from the spawn error, so no extra `rg --version`
 * probe process is needed per search.
 */
async function rg(args) {
  try {
    const { stdout } = await run('rg', args, { timeoutMs: 30000 });
    return stdout;
  } catch (err) {
    if (isMissingRg(err)) {
      throw new RcaError('RIPGREP_MISSING', { hint: rgInstallHint() });
    }
    if (err.childCode === 1) return '';
    if (err.childCode === 2) {
      const reason = (err.stderr || '').split('\n').find(Boolean) || 'ripgrep exited 2';
      throw new RcaError('SEARCH_FAILED', { reason });
    }
    throw err;
  }
}

/**
 * Convert a manifest entry to a search result record.
 * @param {Object} entry  - parsed manifest entry
 * @param {string} outputDir
 * @returns {{ path: string, line: number, text: string, mtime: string|null }}
 */
function entryToResult(entry, outputDir) {
  const fullPath = join(outputDir, entry.path);
  let mtime = null;
  try {
    mtime = statSync(fullPath).mtime.toISOString();
  } catch {
    /* file may not exist */
  }
  return {
    path: fullPath,
    line: 1,
    text: entry.title || '',
    mtime,
  };
}

/**
 * Search RCA corpus.
 *
 * Manifest-backed modes (no rg):
 *   - tag only (no query): filter manifest by tag
 *   - since only (no query): filter manifest by date
 *   - files (no query): filter manifest by files array
 *
 * Ripgrep mode (query provided):
 *   - always uses rg for full-text search
 *   - tag/since are applied as pre/post filters
 *
 * @param {Object} opts
 * @param {string} opts.outputDir
 * @param {string} [opts.query]
 * @param {string} [opts.tag]
 * @param {string} [opts.since]
 * @param {string} [opts.files]
 * @param {boolean} [opts.json]
 */
export async function search({ outputDir, query, tag, since, files, json }) {
  // Manifest-only mode: when no full-text query is supplied, use the manifest.
  const useManifest = !query && (tag || since || files);
  if (useManifest) {
    const entries = loadManifest(outputDir);
    if (entries.length === 0) return [];

    let filtered = entries;

    if (tag) {
      filtered = filtered.filter(
        (e) => Array.isArray(e.tags) && e.tags.some((t) => String(t) === tag),
      );
    }

    if (since) {
      const sinceDate = new Date(since);
      filtered = filtered.filter((e) => e.date && new Date(e.date) >= sinceDate);
    }

    if (files) {
      filtered = filtered.filter(
        (e) => Array.isArray(e.files) && e.files.some((f) => String(f).includes(files)),
      );
    }

    return filtered.map((e) => entryToResult(e, outputDir));
  }

  // If --files only (no query, no tag, no since) and no manifest, return empty.
  if (!query && files) {
    return [];
  }

  // Full-text ripgrep mode.
  // rg exits 2 on a missing path; an un-initialised corpus is "no results".
  if (!existsSync(outputDir)) return [];

  let sinceDate = null;
  if (since) {
    sinceDate = new Date(since);
    if (Number.isNaN(sinceDate.getTime())) {
      throw new RcaError('SEARCH_FAILED', { reason: `unparseable --since value "${since}"` });
    }
  }

  let rgFiles = null;
  if (tag) {
    // Anchor to the frontmatter line and delimit the tag by a bracket, comma or
    // space. A bare \b boundary treats '-' as a break, so --tag race also matched
    // notes tagged only race-condition; and an unescaped tag like "c++" threw.
    const pattern = `^tags:.*[\\[ ,]${escapeRegex(tag)}[,\\] ]`;
    const stdout = await rg(['-l', '-e', pattern, '--', outputDir]);
    rgFiles = stdout.trim().split('\n').filter(Boolean);
    if (rgFiles.length === 0) return [];
  }

  // --with-filename because rg omits the path prefix when handed a single file
  // (which happens when --tag narrows to one RCA), breaking the parse below.
  //
  // -e binds the query as a pattern and -- ends option parsing. Passing the query
  // positionally let a query like "--pre=/bin/sh" reach ripgrep as an option,
  // which is remote code execution via the MCP rca_search tool.
  const rgArgs = [
    '--with-filename',
    '--line-number',
    '--no-heading',
    '--smart-case',
    '-e',
    query,
    '--',
  ];
  if (rgFiles) {
    for (const f of rgFiles) rgArgs.push(f);
  } else {
    rgArgs.push(outputDir);
  }

  const stdout = await rg(rgArgs);
  if (!stdout.trim()) return [];

  // mtime is only consumed by --since and --json, and rg emits one line per
  // match, so stat per line stat'ed the same file repeatedly.
  const needMtime = Boolean(since || json);
  const mtimeCache = new Map();
  function mtimeOf(path) {
    if (!mtimeCache.has(path)) {
      try {
        mtimeCache.set(path, statSync(path).mtime.toISOString());
      } catch {
        mtimeCache.set(path, null);
      }
    }
    return mtimeCache.get(path);
  }

  let results = stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(.+?):(\d+):(.*)$/);
      if (!match) return null;
      const [, path, lineNum, text] = match;
      return {
        path,
        line: parseInt(lineNum, 10),
        text: text.trim(),
        mtime: needMtime ? mtimeOf(path) : null,
      };
    })
    .filter(Boolean);

  if (sinceDate) {
    results = results.filter((r) => r.mtime && new Date(r.mtime) >= sinceDate);
  }

  // Post-filter by manifest files array when both query and files are given.
  // Manifest is source-of-truth: rg hits whose RCA path is not in the manifest
  // files-filtered set are dropped. If manifest absent, skip (pass-through).
  if (files) {
    const entries = loadManifest(outputDir);
    if (entries.length > 0) {
      const allowedPaths = new Set(
        entries
          .filter((e) => Array.isArray(e.files) && e.files.some((f) => String(f).includes(files)))
          .map((e) => join(outputDir, e.path)),
      );
      results = results.filter((r) => allowedPaths.has(r.path));
    }
  }

  if (json) {
    return results;
  }

  return results;
}

export function recent({ outputDir, count = 10, json = false }) {
  const sentinelPath = join(outputDir, '.last-rca-error');
  if (existsSync(sentinelPath)) {
    process.stderr.write("⚠ Last RCA generation failed — run 'claude-rca doctor' for details\n");
  }

  const allFiles = [];
  collectMdFiles(outputDir, allFiles);
  allFiles.sort((a, b) => b.mtime - a.mtime);
  const top = allFiles.slice(0, count);

  if (json) {
    return top.map((f) => ({
      path: f.path,
      basename: basename(f.path),
      mtime: new Date(f.mtime).toISOString(),
    }));
  }

  return top.map((f) => ({
    path: f.path,
    basename: basename(f.path),
    mtime: new Date(f.mtime).toISOString(),
  }));
}

function collectMdFiles(dir, acc) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectMdFiles(full, acc);
    } else if (entry.name.endsWith('.md')) {
      acc.push({ path: full, mtime: statSync(full).mtimeMs });
    }
  }
}

/**
 * `id` may be a path, a basename, or a short hash.
 *
 * restrictToOutputDir confines the path branches to the RCA corpus. The CLI leaves
 * it off: a shell user reading an arbitrary file via `show` gains nothing they did
 * not already have. The MCP server turns it on, because there `id` comes from a
 * model. Note that a bare name like ".env" resolves against process.cwd(), so it
 * must be contained too — not just absolute paths and "..".
 */
export function show({ outputDir, id, restrictToOutputDir = false }) {
  const base = resolve(outputDir);
  const target = resolve(id);
  const rel = relative(base, target);
  const insideCorpus = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);

  if (!restrictToOutputDir || insideCorpus) {
    if (existsSync(id)) {
      return readFileSync(id, 'utf8');
    }
    if (existsSync(target)) {
      return readFileSync(target, 'utf8');
    }
  }

  // These lookups only ever match inside outputDir, so they need no containment.
  const allFiles = [];
  collectMdFiles(outputDir, allFiles);

  const byBasename = allFiles.find((f) => basename(f.path) === id);
  if (byBasename) return readFileSync(byBasename.path, 'utf8');

  const byHash = allFiles.find((f) => basename(f.path).includes(id));
  if (byHash) return readFileSync(byHash.path, 'utf8');

  throw new RcaError('NOT_FOUND', { id });
}
