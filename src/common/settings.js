/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

import { api } from './api.js';

// The contract is explicit that both the IP and the port are user-configurable, so
// the base URL is configuration and never a constant.
export const DEFAULT_BASE_URL = 'http://127.0.0.1:6888';

/** `none` means hover alone triggers a lookup. */
export const MODIFIERS = ['none', 'alt', 'ctrl', 'shift', 'meta'];

/**
 * Where a deliberate search lands — the toolbar search box and the selection
 * context menu, never hover.
 *
 * `page` is the default because a deliberate search is a different act from a
 * hover: the user has stopped reading and wants the entry, with everything the full
 * page has that a 380px panel cannot (all dictionaries, history, an address bar).
 * `popup` is for people who want the two to behave alike.
 */
export const SEARCH_TARGETS = ['page', 'popup'];

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
  // Deliberate searches: full wudict page, all dictionaries. See SEARCH_TARGETS.
  searchTarget: 'page',
  // "Look up in wudict" on a right-clicked selection. The one entry point that
  // works with no hover and no modifier key.
  contextMenu: true,
  // Per-host opt-out: { 'example.com': false }. Only false is ever stored, so the
  // object stays as small as the number of sites the user has actually silenced —
  // which matters, because storage.sync caps individual items at 8 KB.
  siteRules: {},
};

/** Cap on stored opt-outs, so a runaway cannot exceed the storage.sync item limit. */
export const MAX_SITE_RULES = 200;

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

  if (!SEARCH_TARGETS.includes(settings.searchTarget)) {
    settings.searchTarget = DEFAULTS.searchTarget;
  }
  settings.contextMenu = settings.contextMenu !== false;
  settings.siteRules = normalizeSiteRules(settings.siteRules);

  return settings;
}

/**
 * Keep only genuine opt-outs. A `true` entry means "allowed", which is already the
 * default, so storing it would be dead weight that counts against the quota.
 */
function normalizeSiteRules(stored) {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const rules = {};
  let count = 0;
  for (const [host, allowed] of Object.entries(stored)) {
    if (allowed !== false || host === '') continue;
    if (count >= MAX_SITE_RULES) break;
    rules[host] = false;
    count += 1;
  }
  return rules;
}

/** Flip one host's opt-out, returning the patch to store. */
export function withSiteRule(settings, host, allowed) {
  const rules = { ...(settings?.siteRules ?? {}) };
  if (allowed) delete rules[host];
  else rules[host] = false;
  return { siteRules: normalizeSiteRules(rules) };
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
