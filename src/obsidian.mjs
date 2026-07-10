import { existsSync, readFileSync, statSync, appendFileSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { atomicWrite } from './util/fs.mjs';
import { RcaError } from './errors.mjs';

export function detectVault(vaultPath) {
  if (!vaultPath) {
    throw new RcaError('NO_VAULT', {});
  }
  const resolved = resolve(vaultPath);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new RcaError('INVALID_VAULT', { p: resolved });
  }
  const obsidianDir = join(resolved, '.obsidian');
  if (!existsSync(obsidianDir) || !statSync(obsidianDir).isDirectory()) {
    throw new RcaError('INVALID_VAULT', { p: resolved });
  }
  return resolved;
}

export async function syncToVault({ rcaPath, vaultPath, targetFolder = 'RCA Inbox' }) {
  const vault = detectVault(vaultPath);
  const destDir = join(vault, targetFolder);
  const destFile = join(destDir, basename(rcaPath));
  const content = readFileSync(rcaPath, 'utf8');
  await atomicWrite(destFile, content);
  return destFile;
}

/**
 * Obsidian names daily notes by the user's local calendar date. toISOString()
 * yields the UTC date, so anyone east of UTC writing before their local noon (or
 * west of it after ~18:00) was linked into the wrong day's note.
 */
export function localDateParts(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return {
    YYYY: String(now.getFullYear()),
    MM: pad(now.getMonth() + 1),
    DD: pad(now.getDate()),
  };
}

export function formatDailyNoteName(dailyNoteFormat, now = new Date()) {
  const { YYYY, MM, DD } = localDateParts(now);
  return (dailyNoteFormat || 'YYYY-MM-DD')
    .replace('YYYY', YYYY)
    .replace('MM', MM)
    .replace('DD', DD);
}

export function appendDailyNote({
  vaultPath,
  dailyNotesFolder,
  dailyNoteFormat,
  rcaBasename,
  title,
}) {
  const vault = detectVault(vaultPath);
  const noteName = formatDailyNoteName(dailyNoteFormat);
  const notePath = join(vault, dailyNotesFolder || 'Daily Notes', `${noteName}.md`);

  if (!existsSync(notePath)) return null;

  const existing = readFileSync(notePath, 'utf8');
  const linkName = rcaBasename.replace(/\.md$/, '');
  const bullet = `- [[${linkName}]] — ${title}`;
  if (existing.includes(bullet)) return notePath;

  appendFileSync(notePath, `\n${bullet}\n`);
  return notePath;
}

export function buildObsidianUri({ vaultPath, targetFolder, rcaBasename }) {
  const vaultName = basename(vaultPath);
  const filePath = `${targetFolder}/${rcaBasename.replace(/\.md$/, '')}`;
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(filePath)}`;
}

/**
 * Resolve the vault target folder for an RCA artifact.
 *
 * Priority:
 *  1. configTargetFolder is non-empty and not the legacy default "RCA Inbox" → use as-is.
 *  2. repoName is truthy → "RCA/<repoName>".
 *  3. Fallback → "RCA/unknown".
 *
 * @param {{ configTargetFolder: string, repoName: string }} opts
 * @returns {string}
 */
export function resolveTargetFolder({ configTargetFolder, repoName }) {
  if (configTargetFolder && configTargetFolder !== 'RCA Inbox') {
    return configTargetFolder;
  }
  if (repoName) {
    return `RCA/${repoName}`;
  }
  return 'RCA/unknown';
}
