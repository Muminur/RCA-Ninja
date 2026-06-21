// LLM provider registry.
//
// Maps a provider name (from `config.provider`, default "claude") to its
// adapter module. Adapters are the only modules permitted to know about a
// specific LLM CLI's flags and output format, keeping the rest of the codebase
// LLM-agnostic.

import { RcaError } from '../errors.mjs';
import * as claude from './claude.mjs';
import * as codex from './codex.mjs';

const REGISTRY = {
  claude,
  codex,
};

/** Provider names that have a registered adapter. */
export const SUPPORTED_PROVIDERS = Object.keys(REGISTRY);

/**
 * Resolve a provider adapter by name.
 *
 * @param {string|undefined} providerName value of `config.provider` (default "claude")
 * @returns {object} the adapter module
 * @throws {RcaError} INVALID_CONFIG_VALUE when the provider is unknown
 */
export function getProvider(providerName) {
  const key = providerName || 'claude';
  const adapter = REGISTRY[key];
  if (!adapter) {
    throw new RcaError('INVALID_CONFIG_VALUE', {
      key: 'provider',
      reason: `unknown LLM provider "${key}" (supported: ${SUPPORTED_PROVIDERS.join(', ')})`,
    });
  }
  return adapter;
}
