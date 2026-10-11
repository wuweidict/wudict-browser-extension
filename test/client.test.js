/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';

import {
  buildSearchUrl,
  classifyHit,
  droppedIds,
  fetchDicts,
  InvalidQueryError,
  parseMorph,
  search,
} from '../src/background/client.js';
import { ProtocolError } from '../src/background/ndjson.js';
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
  it('distinguishes every outcome', () => {
    assert.equal(classifyHit({ results: [{ Headword: 'x' }] }), OUTCOME.RESULTS);
    assert.equal(classifyHit({ results: [] }), OUTCOME.EMPTY);
    assert.equal(classifyHit({ skipped: true }), OUTCOME.SKIPPED);
    assert.equal(classifyHit({ error: 'boom' }), OUTCOME.ERROR);
    assert.equal(classifyHit({ deferred: true, bytes: 1 }), OUTCOME.DEFERRED);
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

describe('parseMorph', () => {
  it('reads a complete frame', () => {
    assert.deepEqual(parseMorph({ t: 'morph', i: 0, from: 'mice', to: 'mouse', lang: 'en' }), {
      from: 'mice',
      to: 'mouse',
      lang: 'en',
    });
  });

  it('nulls missing, blank or mistyped fields instead of rejecting the frame', () => {
    assert.deepEqual(parseMorph({ from: '', to: 1 }), { from: null, to: null, lang: null });
    assert.deepEqual(parseMorph(null), { from: null, to: null, lang: null });
  });
});

/** Answer every fetch with these NDJSON frames. */
function serve(frames, init = {}) {
  globalThis.fetch = async () =>
    new Response(frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n', {
      headers: { 'content-type': 'application/x-ndjson' },
      ...init,
    });
}

describe('search stream semantics', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const collect = async () => {
    const out = [];
    for await (const frame of search('http://wudict.test', {
      ...QUERY,
      q: 'mice',
      dicts: ['a', 'b'],
    })) {
      out.push(frame);
    }
    return out;
  };
  const hitsOf = (frames) =>
    frames
      .filter((frame) => frame.t === 'hit')
      .map((hit) => [hit.i, hit.outcome, hit.morph?.to ?? null]);
  const begin = {
    t: 'begin',
    i: 0,
    slots: [
      { dict: 'a', name: 'a' },
      { dict: 'b', name: 'b' },
    ],
  };
  const miss = (i) => ({ t: 'hit', i, dict: 'ab'[i], name: 'AB'[i] });
  const morph = { t: 'morph', i: 0, from: 'mice', to: 'mouse', lang: 'en' };
  const found = (i) => ({
    t: 'hit',
    i,
    dict: 'ab'[i],
    name: 'AB'[i],
    results: [{ Headword: 'mouse', Body: 'x' }],
  });
  const end = { t: 'end', i: 0 };

  it('yields the lemma hit for a slot that missed, tagged with the morph', async () => {
    serve([begin, miss(1), miss(0), morph, found(0), end]);
    assert.deepEqual(hitsOf(await collect()), [
      [1, OUTCOME.EMPTY, null],
      [0, OUTCOME.EMPTY, null],
      [0, OUTCOME.RESULTS, 'mouse'],
    ]);
  });

  it('yields end only when the server sent it', async () => {
    serve([begin, miss(0), miss(1), end]);
    assert.equal((await collect()).at(-1).t, 'end');
    serve([begin, miss(0)]);
    assert.ok(!(await collect()).some((frame) => frame.t === 'end'));
  });

  it('drops a second hit without a morph frame, and a third after one', async () => {
    serve([begin, miss(0), found(0), morph, found(0), found(0), end]);
    assert.deepEqual(hitsOf(await collect()), [
      [0, OUTCOME.EMPTY, null],
      [0, OUTCOME.RESULTS, 'mouse'],
    ]);
  });

  it('drops a lemma hit for a slot whose first hit was final', async () => {
    serve([begin, found(0), { ...miss(1), skipped: true }, morph, found(0), found(1), end]);
    assert.deepEqual(hitsOf(await collect()), [
      [0, OUTCOME.RESULTS, null],
      [1, OUTCOME.SKIPPED, null],
    ]);
  });

  it('drops hits outside the slot range and keeps going', async () => {
    serve([
      begin,
      { ...miss(0), i: 7 },
      { ...miss(0), i: -1 },
      { ...miss(0), i: '0' },
      found(1),
      end,
    ]);
    assert.deepEqual(hitsOf(await collect()), [[1, OUTCOME.RESULTS, null]]);
  });

  it('takes the dictionary id from the slot, not the frame', async () => {
    serve([begin, { ...found(0), dict: 'zzz' }, end]);
    const hit = (await collect()).find((frame) => frame.t === 'hit');
    assert.equal(hit.dict, 'a');
  });

  it('survives a malformed morph frame and an unknown frame type', async () => {
    serve([begin, miss(0), { t: 'morph', i: 0 }, { t: 'future', x: 1 }, found(0), end]);
    const hits = (await collect()).filter((frame) => frame.t === 'hit');
    assert.equal(hits.at(-1).outcome, OUTCOME.RESULTS);
    assert.deepEqual(hits.at(-1).morph, { from: null, to: null, lang: null });
  });

  it('classifies a deferred slot as final', async () => {
    serve([begin, { ...miss(0), deferred: true, bytes: 9 }, morph, found(0), end]);
    assert.deepEqual(hitsOf(await collect()), [[0, OUTCOME.DEFERRED, null]]);
  });

  it('raises a ProtocolError for a line that is not JSON', async () => {
    globalThis.fetch = async () => new Response('{"t":"begin","slots":[]}\nnot json\n');
    await assert.rejects(collect, (error) => error instanceof ProtocolError);
  });
});

describe('fetchDicts', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const rows = [
    { t: 'begin', total: 2 },
    {
      t: 'dict',
      dict: { id: 'a', name: 'A', format: 'mdx', entries: 1, caps: { Exact: true }, path: '/x' },
    },
    { t: 'busy', busy: [{ id: 'b', name: 'b', phase: 'indexing', done: 1, total: 9 }] },
    { t: 'dict', dict: { id: 'b', name: 'B', format: 'dsl', entries: 0, caps: {}, error: 'boom' } },
  ];

  it('keeps the etag from end, and each row narrowed with its error', async () => {
    serve([...rows, { t: 'end', etag: '"abc"' }]);
    const { total, dicts, etag } = await fetchDicts('http://wudict.test');
    assert.equal(total, 2);
    assert.equal(etag, '"abc"');
    assert.deepEqual(
      dicts.map((dict) => [dict.id, dict.error]),
      [
        ['a', null],
        ['b', 'boom'],
      ],
    );
    assert.ok(!('path' in dicts[0]));
  });

  it('orders rows by name, whatever order they completed in', async () => {
    const row = (id, name) => ({ t: 'dict', dict: { id, name, caps: {} } });
    serve([
      { t: 'begin', total: 3 },
      row('3', 'oxford'),
      row('1', 'Cambridge'),
      row('2', 'LDOCE 10'),
      { t: 'end' },
    ]);
    const { dicts } = await fetchDicts('http://wudict.test');
    assert.deepEqual(
      dicts.map((dict) => dict.name),
      ['Cambridge', 'LDOCE 10', 'oxford'],
    );
  });

  it('reports no etag when the server withholds one', async () => {
    serve([...rows, { t: 'end' }]);
    assert.equal((await fetchDicts('http://wudict.test')).etag, null);
  });

  it('sends If-None-Match only with an etag, and reads a 304 as unchanged', async () => {
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push(init.headers['if-none-match'] ?? null);
      return new Response(null, { status: 304 });
    };
    assert.deepEqual(await fetchDicts('http://wudict.test', { etag: '"abc"' }), {
      notModified: true,
    });
    assert.deepEqual(seen, ['"abc"']);

    serve([...rows, { t: 'end' }]);
    let header = 'unset';
    const inner = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      header = init.headers['if-none-match'];
      return inner(url, init);
    };
    await fetchDicts('http://wudict.test');
    assert.equal(header, undefined);
  });

  it('raises a ProtocolError when the list ends without end', async () => {
    serve(rows);
    await assert.rejects(
      fetchDicts('http://wudict.test'),
      (error) => error instanceof ProtocolError,
    );
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

  it('search yields begin, one hit per slot, then end', async (t) => {
    if (!reachable) return t.skip(`no wudict at ${BASE_URL}`);
    const dicts = exactIds.slice(0, 3);
    const frames = [];
    for await (const frame of search(BASE_URL, { ...QUERY, dicts })) frames.push(frame);

    assert.equal(frames[0].t, 'begin');
    assert.deepEqual(
      frames[0].slots.map((slot) => slot.dict),
      dicts,
    );

    assert.equal(frames.at(-1).t, 'end');
    const hits = frames.slice(1, -1);
    assert.equal(hits.length, dicts.length);
    for (const hit of hits) {
      assert.equal(hit.t, 'hit');
      // The real name arrives on the hit, never on begin.
      assert.equal(typeof hit.name, 'string');
      assert.notEqual(hit.name, hit.dict);
      assert.ok(Object.values(OUTCOME).includes(hit.outcome));
      assert.ok(Array.isArray(hit.results));
    }
  });

  it('answers an inflected form with its lemma', async (t) => {
    if (!reachable) return t.skip(`no wudict at ${BASE_URL}`);
    const lemmaHits = [];
    for await (const frame of search(BASE_URL, {
      ...QUERY,
      q: 'mice',
      dicts: exactIds.slice(0, 32),
    })) {
      if (frame.t === 'hit' && frame.morph) lemmaHits.push(frame);
    }
    // Some dictionaries list "mice" themselves, in which case no lemma wave runs.
    if (lemmaHits.length === 0) return t.skip('no dictionary needed the lemma for "mice"');
    for (const hit of lemmaHits) {
      assert.equal(hit.outcome, OUTCOME.RESULTS);
      // One wave per language: "mice" is also Romanian (-> mică).
      assert.equal(hit.morph.from, 'mice');
      assert.notEqual(hit.morph.to, 'mice');
      assert.equal(typeof hit.morph.lang, 'string');
    }
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
