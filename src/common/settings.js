import { api } from './api.js';

// The contract is explicit that both the IP and the port are user-configurable, so
// the base URL is configuration and never a constant.
export const DEFAULT_BASE_URL = 'http://127.0.0.1:6888';

/** `none` means hover alone triggers a lookup. */
export const MODIFIERS = ['none', 'alt', 'ctrl', 'shift', 'meta'];

export const DEFAULTS = {
  enabled: true,
  baseUrl: DEFAULT_BASE_URL,
  modifier: 'alt',
  // The contract suggests 150-250 ms; the desktop UI uses 300.
  debounceMs: 200,
  // `n` is per dictionary and the server default of 20 is far too many for hover.
  resultsPerDict: 1,
  // Fallback chain length. Each extra candidate is one more request, but only for
  // a word that would otherwise show nothing — and misses are cached.
  maxCandidates: 4,
  // Empty means "pick automatically from the registry, filtered by capability".
  dicts: [],
  dictLimit: 3,
  // The server opens at most 8 dictionaries concurrently; past that, latency grows
  // with the queue.
  moreLimit: 8,
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

/** Clamp and coerce stored values so one bad field cannot break every lookup. */
export function normalizeSettings(stored) {
  const settings = { ...DEFAULTS, ...stored };

  try {
    settings.baseUrl = normalizeBaseUrl(settings.baseUrl);
  } catch {
    settings.baseUrl = DEFAULT_BASE_URL;
  }

  if (!MODIFIERS.includes(settings.modifier)) settings.modifier = DEFAULTS.modifier;
  settings.enabled = settings.enabled !== false;
  settings.debounceMs = clamp(settings.debounceMs, 0, 2000, DEFAULTS.debounceMs);
  settings.resultsPerDict = clamp(settings.resultsPerDict, 1, 10, DEFAULTS.resultsPerDict);
  settings.maxCandidates = clamp(settings.maxCandidates, 1, 8, DEFAULTS.maxCandidates);
  settings.dictLimit = clamp(settings.dictLimit, 1, 8, DEFAULTS.dictLimit);
  settings.moreLimit = clamp(settings.moreLimit, 1, 8, DEFAULTS.moreLimit);
  settings.dicts = Array.isArray(settings.dicts)
    ? settings.dicts.filter((id) => typeof id === 'string' && id !== '')
    : [];

  return settings;
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

export async function getSettings() {
  const stored = await api.storage.sync.get(DEFAULTS);
  return normalizeSettings(stored);
}

export async function setSettings(patch) {
  await api.storage.sync.set(patch);
}

export function onSettingsChanged(listener) {
  api.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync') listener(changes);
  });
}
