/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildRegistry,
  defaultSelection,
  isForBaseUrl,
  labelFor,
  nameIndex,
  resolveByName,
} from '../src/common/dicts.js';

const BASE_URL = 'http://127.0.0.1:6888';

function dict(id, name, caps = { Exact: true, Prefix: true, FTS: false, Wildcard: false }) {
  return { id, name, format: 'bgl', entries: 1000, caps };
}

const registry = buildRegistry({
  baseUrl: BASE_URL,
  total: 4,
  dicts: [
    dict('aaa', 'Oxford English Dictionary'),
    dict('bbb', 'LDOCE'),
    dict('ccc', 'Wildcard Only', { Exact: false, Prefix: false, FTS: false, Wildcard: true }),
    dict('ddd', 'Merriam-Webster'),
  ],
});

describe('isForBaseUrl', () => {
  it('rejects a registry fetched from a different origin', () => {
    // Ids derive from the server's paths, so they say nothing about another server.
    assert.ok(isForBaseUrl(registry, BASE_URL));
    assert.ok(!isForBaseUrl(registry, 'http://127.0.0.1:7000'));
    assert.ok(!isForBaseUrl(null, BASE_URL));
  });
});

describe('labelFor', () => {
  it('returns the real name for a known id', () => {
    assert.equal(labelFor(registry, 'bbb'), 'LDOCE');
  });

  it('falls back to the id so a row is never blank', () => {
    assert.equal(labelFor(registry, 'zzz'), 'zzz');
    assert.equal(labelFor(null, 'zzz'), 'zzz');
  });
});

describe('nameIndex', () => {
  it('maps name to current id', () => {
    assert.equal(nameIndex(registry).get('LDOCE'), 'bbb');
  });
});

describe('resolveByName', () => {
  it('recovers an id that changed because the dictionary moved', () => {
    const fresh = buildRegistry({
      baseUrl: BASE_URL,
      total: 4,
      dicts: [dict('bbb2', 'LDOCE'), dict('aaa', 'Oxford English Dictionary')],
    });
    const remap = resolveByName(registry, fresh, ['bbb']);
    assert.equal(remap.get('bbb'), 'bbb2');
  });

  it('omits ids whose dictionary is genuinely gone', () => {
    const fresh = buildRegistry({
      baseUrl: BASE_URL,
      total: 1,
      dicts: [dict('aaa', 'Oxford English Dictionary')],
    });
    assert.equal(resolveByName(registry, fresh, ['bbb']).size, 0);
  });

  it('omits ids that did not actually change', () => {
    assert.equal(resolveByName(registry, registry, ['bbb']).size, 0);
  });
});

describe('defaultSelection', () => {
  it('names only dictionaries that can answer the mode', () => {
    // Spending a slot on a guaranteed `skipped` is waste, not an error.
    const selected = defaultSelection(registry, { mode: 'exact', limit: 10 });
    assert.deepEqual(selected, ['aaa', 'bbb', 'ddd']);
    assert.ok(!selected.includes('ccc'));
  });

  it('selects the wildcard-capable dictionary for mode=wildcard', () => {
    assert.deepEqual(defaultSelection(registry, { mode: 'wildcard', limit: 10 }), ['ccc']);
  });

  it('never selects a dictionary the server could not open', () => {
    const broken = buildRegistry({
      baseUrl: BASE_URL,
      total: 2,
      dicts: [{ ...dict('x', 'X'), error: 'too large' }, dict('y', 'Y')],
    });
    assert.deepEqual(defaultSelection(broken, { limit: 10 }), ['y']);
  });

  it('keeps the list small by default', () => {
    // n is per dictionary and the server opens at most 8 concurrently.
    assert.equal(defaultSelection(registry).length, 3);
  });

  it('preserves registry order, which becomes the requested slot order', () => {
    assert.deepEqual(defaultSelection(registry, { limit: 2 }), ['aaa', 'bbb']);
  });

  it('returns nothing when no dictionary can answer', () => {
    const ftsOnly = buildRegistry({
      baseUrl: BASE_URL,
      total: 1,
      dicts: [dict('x', 'X', { Exact: false, Prefix: false, FTS: false, Wildcard: false })],
    });
    assert.deepEqual(defaultSelection(ftsOnly, { mode: 'fts' }), []);
  });

  it('tolerates a missing or empty registry', () => {
    assert.deepEqual(defaultSelection(null), []);
    assert.deepEqual(defaultSelection({ dicts: [] }), []);
  });
});
