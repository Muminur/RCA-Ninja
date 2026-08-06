import { RcaError } from './errors.mjs';

const FAIL_CLOSED_PROVIDER_CODES = new Set([
  'SECRET_SCAN_FAILED',
  'SECRET_SCANNER_UNAVAILABLE',
  'PROVIDER_ISOLATION_UNAVAILABLE',
]);

export function isFailClosedProviderError(error) {
  return FAIL_CLOSED_PROVIDER_CODES.has(error?.code);
}

export function throwIfFailClosedProviderError(error) {
  if (!isFailClosedProviderError(error)) return false;
  throw new RcaError(error.code);
}
