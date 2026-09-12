// The isolated provider broker.
//
// Provider adapters describe an invocation (binary, argv, scrubbed env, cwd,
// stdin); nothing else in the codebase may spawn an LLM CLI. Every invocation
// runs inside a throwaway workspace directory that is also its cwd and its
// TEMP/TMP/TMPDIR/APPDATA (see buildProviderEnv), and that directory is removed
// afterwards, so a provider leaves nothing behind and starts with no API keys,
// tokens, or repository variables in its environment. HOME and USERPROFILE are
// the single documented exception — see CREDENTIAL_ENV_KEYS in
// providers/shared.mjs.
//
// The payload is scanned for secrets before we get here — see
// scanProviderPayload() in secret-scan.mjs. This module never decides whether a
// payload may be sent; it only decides how it is run once that gate has passed.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { run } from './util/exec.mjs';
import { RcaError } from './errors.mjs';
import { buildProviderEnv } from './providers/shared.mjs';

/**
 * Create an isolated workspace, hand it to `fn`, and remove it afterwards.
 * @template T
 * @param {(workspaceDir: string) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withProviderWorkspace(fn) {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'rca-provider-')));
  try {
    return await fn(dir);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A leftover temp directory is not worth masking the real outcome.
    }
  }
}

// Why a provider cannot be used right now, as opposed to a bad response from
// one that is working. These are the cases where trying a different provider is
// the right move; anything else would fail identically on the next one.
export const UNUSABLE_REASONS = Object.freeze({
  MISSING: 'not installed',
  AUTH: 'not logged in',
  LIMIT: 'usage limited',
});

const MISSING_RE = /\bENOENT\b|is not recognized as|command not found|no such file or directory/i;
const AUTH_RE =
  /not logged ?in|please run \/login|please log ?in|\bunauthorized\b|\b401\b|invalid[_ -]?api[_ -]?key|authentication[_ -]?error|oauth[_ -]?token|credentials? (?:not found|expired|invalid)/i;
const LIMIT_RE =
  /rate[_ -]?limit|\b429\b|\bquota\b|usage limit|too many requests|insufficient[_ -]?quota|credit balance|not supported when using|\b(?:402|403)\b/i;

/**
 * Decide whether a failed provider attempt means "this provider is unusable"
 * (so fall back) rather than "this provider answered badly" (so retry or give
 * up here).
 *
 * Only ever called once an attempt has already failed to yield RCA data, so a
 * model that legitimately writes "rate limit" *inside* a successful RCA is
 * never misread as a quota failure.
 *
 * @param {{ stdout?: string, stderr?: string, error?: unknown }} attempt
 * @returns {'MISSING'|'AUTH'|'LIMIT'|null}
 */
export function classifyProviderFailure({ stdout = '', stderr = '', error = null } = {}) {
  const errText = error ? `${error.code ?? ''} ${error.message ?? ''}` : '';
  const text = `${stdout}\n${stderr}\n${errText}`;
  if (MISSING_RE.test(text)) return 'MISSING';
  if (AUTH_RE.test(text)) return 'AUTH';
  if (LIMIT_RE.test(text)) return 'LIMIT';
  return null;
}

/**
 * Spawn one provider invocation and return its raw streams.
 * Never throws on a non-zero exit: the caller classifies the output instead.
 *
 * @param {{cmd: string, argv: string[], cwd: string, env: object, input?: string, timeoutMs?: number}} inv
 * @returns {Promise<{ stdout: string, stderr: string, error: unknown|null }>}
 */
export async function runProviderInvocation(inv) {
  try {
    const { stdout, stderr } = await run(inv.cmd, inv.argv, {
      cwd: inv.cwd,
      env: inv.env,
      input: inv.input,
      timeoutMs: inv.timeoutMs ?? 60000,
    });
    return { stdout, stderr, error: null };
  } catch (err) {
    return { stdout: err?.stdout ?? '', stderr: err?.stderr ?? '', error: err };
  }
}

// Variables that must point at the throwaway workspace, so a provider writes
// its scratch state there and not into the user's own directories. HOME and
// USERPROFILE are deliberately not on this list — see CREDENTIAL_ENV_KEYS in
// providers/shared.mjs for why redirecting them logs the provider out instead
// of sandboxing it.
const LEAKY_ENV_KEYS = ['APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR'];

/**
 * Confirm the broker actually isolates: build the env a real invocation would
 * get and check every home/temp variable points at the throwaway workspace
 * rather than the user's own directories. Used by `doctor` and `setup` so the
 * claim is verified rather than asserted.
 *
 * @param {string} providerName
 * @returns {string} a short description for the doctor line
 * @throws {RcaError} PROVIDER_ISOLATION_UNAVAILABLE when isolation does not hold
 */
export function verifyProviderIsolation(providerName) {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'rca-isolation-probe-')));
  try {
    const env = buildProviderEnv(providerName, process.env, dir);
    for (const key of LEAKY_ENV_KEYS) {
      if (env[key] !== dir) {
        throw new RcaError('PROVIDER_ISOLATION_UNAVAILABLE');
      }
    }
    for (const key of Object.keys(env)) {
      if (/^(ANTHROPIC|OPENAI|AWS|GITHUB|GH)_/i.test(key)) {
        throw new RcaError('PROVIDER_ISOLATION_UNAVAILABLE');
      }
    }
    return `workspace-isolated (${Object.keys(env).length} env vars, scratch dirs redirected, no API keys)`;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* probe directory only */
    }
  }
}
