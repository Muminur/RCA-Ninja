import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { run } from './util/exec.mjs';
import { RcaError } from './errors.mjs';

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

export async function search({ outputDir, query, tag, since, json }) {
  await checkRg();

  let files = null;
  if (tag) {
    try {
      const { stdout } = await run('rg', ['-l', `tags:.*\\b${tag}\\b`, outputDir], {
        timeoutMs: 10000,
      });
      files = stdout.trim().split('\n').filter(Boolean);
      if (files.length === 0) return [];
    } catch {
      return [];
    }
  }

  const rgArgs = ['--line-number', '--no-heading', query];
  if (files) {
    for (const f of files) rgArgs.push(f);
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
    });

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
