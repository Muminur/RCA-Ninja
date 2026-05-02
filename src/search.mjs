import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { run } from './util/exec.mjs';
import { RcaError } from './errors.mjs';
import { loadManifest } from './manifest.mjs';

function rgInstallHint() {
  const platform = process.platform;
  if (platform === 'darwin') return 'brew install ripgrep';
  if (platform === 'linux') return 'sudo apt-get install -y ripgrep';
  return 'See https://github.com/BurntSushi/ripgrep#installation';
}

async function checkRg() {
  try {
    await run('rg', ['--version'], { timeoutMs: 5000 });
  } catch {
    throw new RcaError('RIPGREP_MISSING', { hint: rgInstallHint() });
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
  await checkRg();

  let rgFiles = null;
  if (tag) {
    try {
      const { stdout } = await run('rg', ['-l', `tags:.*\\b${tag}\\b`, outputDir], {
        timeoutMs: 10000,
      });
      rgFiles = stdout.trim().split('\n').filter(Boolean);
      if (rgFiles.length === 0) return [];
    } catch {
      return [];
    }
  }

  const rgArgs = ['--line-number', '--no-heading', query];
  if (rgFiles) {
    for (const f of rgFiles) rgArgs.push(f);
  } else {
    rgArgs.push(outputDir);
  }

  let stdout;
  try {
    const result = await run('rg', rgArgs, { timeoutMs: 30000 });
    stdout = result.stdout;
  } catch {
    return [];
  }

  let results = stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(.+?):(\d+):(.*)$/);
      if (!match) return null;
      const [, path, lineNum, text] = match;
      let mtime = null;
      try {
        mtime = statSync(path).mtime.toISOString();
      } catch {
        /* file may not exist */
      }
      return { path, line: parseInt(lineNum, 10), text: text.trim(), mtime };
    })
    .filter(Boolean);

  if (since) {
    const sinceDate = new Date(since);
    results = results.filter((r) => r.mtime && new Date(r.mtime) >= sinceDate);
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

export function show({ outputDir, id }) {
  if (existsSync(id)) {
    return readFileSync(id, 'utf8');
  }

  const resolved = resolve(id);
  if (existsSync(resolved)) {
    return readFileSync(resolved, 'utf8');
  }

  const allFiles = [];
  collectMdFiles(outputDir, allFiles);

  const byBasename = allFiles.find((f) => basename(f.path) === id);
  if (byBasename) return readFileSync(byBasename.path, 'utf8');

  const byHash = allFiles.find((f) => basename(f.path).includes(id));
  if (byHash) return readFileSync(byHash.path, 'utf8');

  throw new RcaError('NOT_FOUND', { id });
}
