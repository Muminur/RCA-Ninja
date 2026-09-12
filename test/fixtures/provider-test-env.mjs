import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const PROVIDER_BINARIES =
  process.platform === 'win32'
    ? ['claude.exe', 'claude.cmd', 'claude.bat', 'codex.exe', 'codex.cmd', 'codex.bat']
    : ['claude', 'codex'];

/**
 * A PATH with no LLM CLI on it.
 *
 * Generation now really does invoke a provider, so a test that wants to assert
 * everything *up to* that invocation has to make the invocation fail fast and
 * deterministically — otherwise it reaches the developer's own logged-in CLI,
 * takes minutes, and bills a real API call. With every provider missing the
 * broker reports PROVIDER_UNAVAILABLE immediately.
 *
 * @param {string} [basePath] PATH to filter (default: the current one)
 * @returns {string}
 */
export function pathWithoutProviders(basePath = process.env.PATH || '') {
  return basePath
    .split(delimiter)
    .filter((entry) => entry && !PROVIDER_BINARIES.some((name) => existsSync(join(entry, name))))
    .join(delimiter);
}

/** The exact message PROVIDER_UNAVAILABLE renders when no provider is installed. */
export const NO_PROVIDER_MESSAGE =
  'No usable LLM provider: claude (not installed), codex (not installed). ' +
  'Log in (claude /login, codex login) and retry.';
