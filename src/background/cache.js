/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

// LRU for lookup results, shared by every tab.
//
// Keyed per *dictionary* rather than per request — `dict|mode|n|format|q` — so an
// entry stays reusable when the set of dictionaries being queried changes. A lookup
// is served from cache only when every requested dictionary is present; a partial
// hit refetches the whole list rather than computing the missing subset and merging
// it back by slot index. That trades a little bandwidth for a lot less machinery,
// and can be revisited if "more dictionaries" makes partial hits common.
//
// Misses are cached too. Without that, a word whose candidate chain ends in nothing
// re-probes the server on every crossing — the worst case for a hover client.
//
// Bounded by bytes as well as entries: article sizes span 135 B to 187 KB, so an
// entry count alone is not a memory bound.

const DEFAULTS = {
  maxEntries: 400,
  maxBytes: 8 * 1024 * 1024,
};

export function cacheKey(dictId, { q, mode, n, format }) {
  return `${dictId}|${mode}|${n}|${format}|${q}`;
}

export function createCache(options = {}) {
  const { maxEntries, maxBytes } = { ...DEFAULTS, ...options };
  // Map iterates in insertion order, so the first key is the least recently used
  // as long as every read re-inserts.
  const entries = new Map();
  let bytes = 0;
  let hits = 0;
  let misses = 0;

  function get(key) {
    if (!entries.has(key)) {
      misses += 1;
      return undefined;
    }
    const entry = entries.get(key);
    entries.delete(key);
    entries.set(key, entry);
    hits += 1;
    return entry.value;
  }

  function set(key, value) {
    if (entries.has(key)) {
      bytes -= entries.get(key).bytes;
      entries.delete(key);
    }
    const size = estimateBytes(value);
    entries.set(key, { value, bytes: size });
    bytes += size;
    evict();
  }

  function evict() {
    for (const key of entries.keys()) {
      if (entries.size <= maxEntries && bytes <= maxBytes) break;
      bytes -= entries.get(key).bytes;
      entries.delete(key);
    }
  }

  return {
    get,
    set,
    has: (key) => entries.has(key),
    delete(key) {
      if (!entries.has(key)) return false;
      bytes -= entries.get(key).bytes;
      return entries.delete(key);
    },
    clear() {
      entries.clear();
      bytes = 0;
    },
    stats: () => ({ entries: entries.size, bytes, hits, misses, maxEntries, maxBytes }),
  };
}

/**
 * Cheap size estimate: the article HTML dominates, so summing string lengths is
 * within a small factor and costs far less than serialising the value.
 */
function estimateBytes(value) {
  let total = 64; // key and bookkeeping overhead
  if (value?.name) total += value.name.length;
  if (value?.error) total += value.error.length;
  for (const result of value?.results ?? []) {
    total += (result.Headword?.length ?? 0) + (result.Body?.length ?? 0);
  }
  return total;
}
