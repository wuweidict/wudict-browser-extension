/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cacheKey, createCache } from '../src/background/cache.js';

const QUERY = { q: 'speed', mode: 'exact', n: 1, format: 'clean' };

function entry(body) {
  return {
    name: 'D',
    outcome: 'results',
    results: [{ Headword: 'speed', Body: body }],
    error: null,
  };
}

describe('cacheKey', () => {
  it('separates entries that differ in any parameter', () => {
    const base = cacheKey('d1', QUERY);
    assert.notEqual(base, cacheKey('d2', QUERY));
    assert.notEqual(base, cacheKey('d1', { ...QUERY, q: 'sped' }));
    assert.notEqual(base, cacheKey('d1', { ...QUERY, mode: 'prefix' }));
    // n and format change the payload, so they must be part of the key even though
    // the contract describes the key as dict|mode|q.
    assert.notEqual(base, cacheKey('d1', { ...QUERY, n: 3 }));
    assert.notEqual(base, cacheKey('d1', { ...QUERY, format: 'text' }));
  });

  it('is stable for equal parameters', () => {
    assert.equal(cacheKey('d1', QUERY), cacheKey('d1', { ...QUERY }));
  });
});

describe('createCache', () => {
  it('round-trips a value', () => {
    const cache = createCache();
    cache.set('k', entry('x'));
    assert.equal(cache.get('k').results[0].Body, 'x');
    assert.ok(cache.has('k'));
  });

  it('caches a miss, so a fruitless word is not re-probed', () => {
    const cache = createCache();
    const empty = { name: 'D', outcome: 'empty', results: [], error: null };
    cache.set('k', empty);
    assert.ok(cache.has('k'));
    assert.equal(cache.get('k').outcome, 'empty');
  });

  it('evicts the least recently used entry past maxEntries', () => {
    const cache = createCache({ maxEntries: 2 });
    cache.set('a', entry('a'));
    cache.set('b', entry('b'));
    cache.get('a'); // 'a' is now the most recently used, so 'b' must go first
    cache.set('c', entry('c'));

    assert.ok(cache.has('a'));
    assert.ok(!cache.has('b'));
    assert.ok(cache.has('c'));
  });

  it('evicts by byte budget, not just entry count', () => {
    const cache = createCache({ maxEntries: 100, maxBytes: 500 });
    cache.set('big', entry('x'.repeat(400)));
    cache.set('bigger', entry('y'.repeat(400)));
    // Both together exceed the budget, so the older one is gone.
    assert.ok(!cache.has('big'));
    assert.ok(cache.has('bigger'));
    assert.ok(cache.stats().bytes <= 500);
  });

  it('does not double-count bytes when a key is overwritten', () => {
    const cache = createCache();
    cache.set('k', entry('x'.repeat(1000)));
    const first = cache.stats().bytes;
    cache.set('k', entry('x'.repeat(1000)));
    assert.equal(cache.stats().bytes, first);
    assert.equal(cache.stats().entries, 1);
  });

  it('tracks hits and misses', () => {
    const cache = createCache();
    cache.set('k', entry('x'));
    cache.get('k');
    cache.get('absent');
    const stats = cache.stats();
    assert.equal(stats.hits, 1);
    assert.equal(stats.misses, 1);
  });

  it('clear and delete release bytes', () => {
    const cache = createCache();
    cache.set('a', entry('x'.repeat(100)));
    cache.set('b', entry('y'.repeat(100)));
    assert.ok(cache.delete('a'));
    assert.equal(cache.stats().entries, 1);
    cache.clear();
    assert.equal(cache.stats().entries, 0);
    assert.equal(cache.stats().bytes, 0);
  });
});
