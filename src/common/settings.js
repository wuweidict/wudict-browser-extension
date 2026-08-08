import { api } from './api.js';

// The contract is explicit that both the IP and the port are user-configurable, so
// the base URL is configuration and never a constant.
export const DEFAULT_BASE_URL = 'http://127.0.0.1:6888';

export const DEFAULTS = {
  baseUrl: DEFAULT_BASE_URL,
};

/** Strip a trailing slash and reject anything that is not a usable http(s) origin. */
export function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`base URL must be http or https, got ${url.protocol}`);
  }
  if (url.search || url.hash) {
    throw new Error('base URL must not carry a query string or fragment');
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

export async function getSettings() {
  const stored = await api.storage.sync.get(DEFAULTS);
  try {
    return { ...stored, baseUrl: normalizeBaseUrl(stored.baseUrl) };
  } catch {
    // A corrupt stored value must not brick every lookup.
    return { ...stored, baseUrl: DEFAULT_BASE_URL };
  }
}

export function onSettingsChanged(listener) {
  api.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync') listener(changes);
  });
}
