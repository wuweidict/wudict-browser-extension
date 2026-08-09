/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

// The persisted /api/dicts registry.
//
// This is not a convenience: `begin.slots[].name` is the dictionary id repeated, so
// the registry is the only source of real names for the popup's placeholder rows.
// It also backs re-resolution by name, since ids derive from the path and change if
// a dictionary moves.
//
// Storage and selection only — no network. The caller does the fetching, which
// keeps this module usable from the options page without importing worker code.

import { api } from './api.js';

const STORAGE_KEY = 'dictRegistry';

/** caps keys are capitalised Go field names, and mode values are lowercase. */
const CAP_FOR_MODE = {
  exact: 'Exact',
  prefix: 'Prefix',
  contains: 'Contains',
  fts: 'FTS',
};

export function buildRegistry({ baseUrl, total, dicts }) {
  return { baseUrl, total, dicts, fetchedAt: Date.now() };
}

export async function loadRegistry() {
  const stored = await api.storage.local.get(STORAGE_KEY);
  const registry = stored?.[STORAGE_KEY];
  if (!registry || !Array.isArray(registry.dicts)) return null;
  return registry;
}

export async function saveRegistry(registry) {
  await api.storage.local.set({ [STORAGE_KEY]: registry });
}

export async function clearRegistry() {
  await api.storage.local.remove(STORAGE_KEY);
}

/**
 * Ids are derived from the server's paths, so a registry fetched from one base URL
 * says nothing about another.
 */
export function isForBaseUrl(registry, baseUrl) {
  return Boolean(registry) && registry.baseUrl === baseUrl;
}

export function labelFor(registry, id) {
  const found = registry?.dicts?.find((dict) => dict.id === id);
  // Falling back to the id keeps a row labelled rather than blank.
  return found?.name ?? id;
}

/** Map of real name -> current id, for re-resolving an id that has gone stale. */
export function nameIndex(registry) {
  const index = new Map();
  for (const dict of registry?.dicts ?? []) index.set(dict.name, dict.id);
  return index;
}

/**
 * Re-resolve ids the server no longer knows, by the name they had when last seen.
 * Returns a Map of old id -> current id for those that could be recovered.
 */
export function resolveByName(staleRegistry, freshRegistry, staleIds) {
  const byId = new Map((staleRegistry?.dicts ?? []).map((dict) => [dict.id, dict.name]));
  const byName = nameIndex(freshRegistry);
  const remap = new Map();
  for (const id of staleIds) {
    const name = byId.get(id);
    const current = name === undefined ? undefined : byName.get(name);
    if (current !== undefined && current !== id) remap.set(id, current);
  }
  return remap;
}

/**
 * Which dictionaries a lookup should query by default.
 *
 * Only dictionaries that can answer the mode are worth naming — asking anyway is
 * not an error, but it spends a slot on a guaranteed `skipped`. Small by default:
 * `n` is per dictionary, and the server opens at most 8 concurrently.
 */
export function defaultSelection(registry, { mode = 'exact', limit = 3 } = {}) {
  const cap = CAP_FOR_MODE[mode];
  const capable = (registry?.dicts ?? []).filter((dict) =>
    cap ? dict.caps?.[cap] === true : true,
  );
  return capable.slice(0, limit).map((dict) => dict.id);
}

export { CAP_FOR_MODE };
