/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import {
  buildSearchUrl,
  classifyHit,
  droppedIds,
  fetchDicts,
  InvalidQueryError,
  search,
} from '../src/background/client.js';
import { OUTCOME } from '../src/common/protocol.js';

const BASE_URL = process.env.WUDICT_BASE_URL ?? 'http://127.0.0.1:6888';
const QUERY = { q: 'speed', mode: 'exact', n: 1, format: 'clean', dicts: ['d1'] };

describe('buildSearchUrl', () => {
  it('sends every parameter explicitly', () => {
    const url = new URL(buildSearchUrl(BASE_URL, { ...QUERY, dicts: ['d1', 'd2'] }));
    assert.equal(url.pathname, '/api/search');
    assert.equal(url.searchParams.get('q'), 'speed');
    assert.equal(url.searchParams.get('mode'), 'exact');
    // The server default is 20 per dictionary — far too many for hover.
    assert.equal(url.searchParams.get('n'), '1');
    assert.equal(url.searchParams.get('format'), 'clean');
    assert.equal(url.searchParams.get('dict'), 'd1,d2');
  });

  it('encodes a term that would otherwise break the query string', () => {
    const url = new URL(buildSearchUrl(BASE_URL, { ...QUERY, q: 'a&b=c d' }));
    assert.equal(url.searchParams.get('q'), 'a&b=c d');
  });

  // An empty q is a 400, and a hover handler fires one on every gap between words.
  for (const q of ['', '   ', '\t\n', null, undefined, 42]) {
    it(`refuses to build a request for ${JSON.stringify(q)}`, () => {
      assert.throws(
        () => buildSearchUrl(BASE_URL, { ...QUERY, q }),
        (error) => error instanceof InvalidQueryError,
      );
    });
  }

  it('refuses an empty dictionary list', () => {
    assert.throws(
      () => buildSearchUrl(BASE_URL, { ...QUERY, dicts: [] }),
      (error) => error instanceof InvalidQueryError,
    );
  });
});

describe('classifyHit', () => {
  it('distinguishes all four outcomes', () => {
    assert.equal(classifyHit({ results: [{ Headword: 'x' }] }), OUTCOME.RESULTS);
    assert.equal(classifyHit({ results: [] }), OUTCOME.EMPTY);
    assert.equal(classifyHit({ skipped: true }), OUTCOME.SKIPPED);
    assert.equal(classifyHit({ error: 'boom' }), OUTCOME.ERROR);
  });

  it('treats explicit nulls as absent', () => {
    // The server emits skipped/error as null on a normal hit rather than omitting
    // them, so `'skipped' in frame` would misclassify every result.
    const frame = { results: [{ Headword: 'x' }], skipped: null, error: null };
    assert.equal(classifyHit(frame), OUTCOME.RESULTS);
    assert.equal(classifyHit({ results: [], skipped: null, error: null }), OUTCOME.EMPTY);
  });

  it('ranks error above skipped above results', () => {
    assert.equal(classifyHit({ error: 'boom', skipped: true, results: [{}] }), OUTCOME.ERROR);
    assert.equal(classifyHit({ skipped: true, results: [{}] }), OUTCOME.SKIPPED);
  });
});

describe('droppedIds', () => {
  it('reports ids the server did not return', () => {
    const slots = [{ dict: 'a' }, { dict: 'c' }];
    assert.deepEqual(droppedIds(['a', 'b', 'c'], slots), ['b']);
  });

  it('reports nothing when every id resolved', () => {
    assert.deepEqual(droppedIds(['a'], [{ dict: 'a' }]), []);
  });
});

describe('live client', () => {
  let reachable = false;
  let exactIds = [];

  before(async () => {
    try {
      const { dicts } = await fetchDicts(BASE_URL, { signal: AbortSignal.timeout(5000) });
      exactIds = dicts.filter((dict) => dict.caps?.Exact).map((dict) => dict.id);
      reachable = dicts.length > 0;
    } catch {
      reachable = false;
    }
  });

  it('fetchDicts returns narrowed records', async (t) => {
    if (!reachable) return t.skip(`no wudict at ${BASE_URL}`);
    const { total, dicts } = await fetchDicts(BASE_URL);
    assert.ok(dicts.length > 0);
    assert.ok(dicts.length <= total);
    for (const dict of dicts.slice(0, 5)) {
      assert.equal(typeof dict.id, 'string');
      assert.equal(typeof dict.name, 'string');
      assert.ok(dict.caps);
      // Paths and sizes belong to the desktop panel and must not be retained.
      assert.ok(!('path' in dict));
    }
  });

  it('search yields begin then exactly one hit per slot', async (t) => {
    if (!reachable) return t.skip(`no wudict at ${BASE_URL}`);
    const dicts = exactIds.slice(0, 3);
    const frames = [];
    for await (const frame of search(BASE_URL, { ...QUERY, dicts })) frames.push(frame);

    assert.equal(frames[0].t, 'begin');
    assert.deepEqual(
      frames[0].slots.map((slot) => slot.dict),
      dicts,
    );

    const hits = frames.slice(1);
    assert.equal(hits.length, dicts.length);
    for (const hit of hits) {
      assert.equal(hit.t, 'hit');
      // The real name arrives on the hit, never on begin.
      assert.equal(typeof hit.name, 'string');
      assert.notEqual(hit.name, hit.dict);
      assert.ok(Object.values(OUTCOME).includes(hit.outcome));
      assert.ok(Array.isArray(hit.results));
    }
    // Nothing is yielded after the stream ends.
    assert.ok(!frames.some((frame) => frame.t === 'end'));
  });

  it('returns clean bodies with absolute /res/ URLs', async (t) => {
    if (!reachable) return t.skip(`no wudict at ${BASE_URL}`);
    let checked = 0;
    for await (const frame of search(BASE_URL, { ...QUERY, dicts: exactIds.slice(0, 8), n: 1 })) {
      if (frame.t !== 'hit' || frame.outcome !== OUTCOME.RESULTS) continue;
      for (const result of frame.results) {
        // format=clean drops scripts, styles and link tags entirely.
        assert.doesNotMatch(result.Body, /<script/i);
        assert.doesNotMatch(result.Body, /<style/i);
        assert.doesNotMatch(result.Body, /<link/i);
        assert.doesNotMatch(result.Body, /\son[a-z]+\s*=/i);
        // Root-absolute /res/ must already be absolutised by the server.
        assert.doesNotMatch(result.Body, /(?:src|href)="\/res\//);
        checked += 1;
      }
    }
    assert.ok(checked > 0, 'expected at least one article to inspect');
  });

  it('aborts an in-flight search', async (t) => {
    if (!reachable) return t.skip(`no wudict at ${BASE_URL}`);
    const controller = new AbortController();
    const iterate = async () => {
      for await (const frame of search(
        BASE_URL,
        { ...QUERY, dicts: exactIds.slice(0, 8) },
        { signal: controller.signal },
      )) {
        if (frame.t === 'begin') controller.abort();
      }
    };
    await assert.rejects(iterate, (error) => error.name === 'AbortError');
  });

  it('surfaces a pre-stream failure as WudictHttpError', async (t) => {
    if (!reachable) return t.skip(`no wudict at ${BASE_URL}`);
    const iterate = async () => {
      // eslint-disable-next-line no-unused-vars
      for await (const frame of search(BASE_URL, { ...QUERY, dicts: ['deadbeefcafe'] })) {
        // the 404 lands before any frame
      }
    };
    await assert.rejects(iterate, (error) => {
      assert.equal(error.name, 'WudictHttpError');
      assert.equal(error.status, 404);
      return true;
    });
  });
});
