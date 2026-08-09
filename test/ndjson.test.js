/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';

import { assertStreamStarted, readFrames, WudictHttpError } from '../src/background/ndjson.js';

const BASE_URL = process.env.WUDICT_BASE_URL ?? 'http://127.0.0.1:6888';

function ndjsonResponse(body, init) {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
    ...init,
  });
}

async function collect(response) {
  const frames = [];
  for await (const frame of readFrames(response)) frames.push(frame);
  return frames;
}

describe('assertStreamStarted', () => {
  it('passes a 200 through', async () => {
    await assertStreamStarted(ndjsonResponse('{"t":"end"}\n'));
  });

  it('throws with the plain-JSON detail on a pre-stream failure', async () => {
    const response = new Response(JSON.stringify({ error: 'missing q parameter' }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    await assert.rejects(
      () => assertStreamStarted(response),
      (error) => {
        assert.ok(error instanceof WudictHttpError);
        assert.equal(error.status, 400);
        assert.equal(error.detail, 'missing q parameter');
        assert.match(error.message, /missing q parameter/);
        return true;
      },
    );
  });

  it('still throws when the error body is not JSON', async () => {
    const response = new Response('gateway exploded', { status: 502 });
    await assert.rejects(
      () => assertStreamStarted(response),
      (error) => {
        assert.equal(error.status, 502);
        assert.equal(error.detail, '');
        return true;
      },
    );
  });
});

describe('readFrames', () => {
  it('yields one object per line', async () => {
    const frames = await collect(
      ndjsonResponse('{"t":"begin","total":2}\n{"t":"dict"}\n{"t":"end"}\n'),
    );
    assert.deepEqual(
      frames.map((f) => f.t),
      ['begin', 'dict', 'end'],
    );
    assert.equal(frames[0].total, 2);
  });

  it('yields a final line that has no trailing newline', async () => {
    const frames = await collect(ndjsonResponse('{"t":"begin"}\n{"t":"end"}'));
    assert.equal(frames.length, 2);
    assert.equal(frames[1].t, 'end');
  });

  it('ignores blank lines', async () => {
    const frames = await collect(ndjsonResponse('{"t":"begin"}\n\n\n{"t":"end"}\n'));
    assert.equal(frames.length, 2);
  });

  it('reassembles a frame split across chunk boundaries', async () => {
    const chunks = ['{"t":"be', 'gin","total":1}\n{"t":"e', 'nd"}\n'];
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const frames = await collect(ndjsonResponse(stream));
    assert.deepEqual(
      frames.map((f) => f.t),
      ['begin', 'end'],
    );
  });

  it('reassembles a multi-byte character split across chunk boundaries', async () => {
    // "é" is two bytes; splitting it must not corrupt the frame.
    const bytes = new TextEncoder().encode('{"t":"hit","name":"café"}\n');
    const split = 21;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    });
    const frames = await collect(ndjsonResponse(stream));
    assert.equal(frames[0].name, 'café');
  });

  it('throws with context on a malformed line', async () => {
    await assert.rejects(
      () => collect(ndjsonResponse('{"t":"begin"}\nnot json\n')),
      /malformed NDJSON line: not json/,
    );
  });
});

// These assert the live contract, not just our parser. They are the session-1 smoke
// test at the transport level: the browser-specific question (whether a worker may
// fetch loopback) still has to be answered in the browser.
describe('live server', () => {
  let reachable = false;
  const dictIds = [];

  before(async () => {
    try {
      const response = await fetch(`${BASE_URL}/api/dicts`, { signal: AbortSignal.timeout(5000) });
      reachable = response.ok;
      if (reachable) {
        for await (const frame of readFrames(response)) {
          if (frame.t === 'dict') dictIds.push(frame.dict.id);
        }
      }
    } catch {
      reachable = false;
    }
  });

  it('/api/dicts streams begin/dict/end and nothing else', async (t) => {
    if (!reachable) return t.skip(`no wudict at ${BASE_URL}`);
    const response = await fetch(`${BASE_URL}/api/dicts`);
    assert.match(response.headers.get('content-type'), /application\/x-ndjson/);

    let total = null;
    let dicts = 0;
    let sawEnd = false;
    for await (const frame of readFrames(response)) {
      switch (frame.t) {
        case 'begin':
          total = frame.total;
          break;
        case 'dict':
          dicts += 1;
          assert.ok(frame.dict.id && frame.dict.name);
          break;
        case 'end':
          sawEnd = true;
          break;
        default:
          assert.fail(`unexpected frame type in /api/dicts: ${frame.t}`);
      }
    }
    assert.ok(sawEnd, 'stream must terminate with an `end` frame');
    // `total` is documented as an upper bound: dictionaries that cannot be
    // described are omitted.
    assert.ok(dicts <= total, `${dicts} dict frames exceeded begin.total ${total}`);
  });

  it('rejects a missing q before the stream starts', async (t) => {
    if (!reachable) return t.skip(`no wudict at ${BASE_URL}`);
    const response = await fetch(`${BASE_URL}/api/search`);
    await assert.rejects(
      () => assertStreamStarted(response),
      (error) => {
        assert.equal(error.status, 400);
        assert.equal(error.detail, 'missing q parameter');
        return true;
      },
    );
  });

  it('rejects an unknown format rather than falling back', async (t) => {
    if (!reachable) return t.skip(`no wudict at ${BASE_URL}`);
    const response = await fetch(`${BASE_URL}/api/search?q=speed&format=bogus`);
    await assert.rejects(
      () => assertStreamStarted(response),
      (error) => {
        assert.equal(error.status, 400);
        return true;
      },
    );
  });

  it('emits exactly one hit per slot, and slots[].name is the id not the name', async (t) => {
    if (!reachable) return t.skip(`no wudict at ${BASE_URL}`);
    const requested = dictIds.slice(0, 3);
    const url =
      `${BASE_URL}/api/search?q=speed&mode=exact&n=1&format=clean` +
      `&dict=${encodeURIComponent(requested.join(','))}`;
    const response = await fetch(url);
    await assertStreamStarted(response);

    let slots = null;
    const hits = new Map();
    let sawEnd = false;

    for await (const frame of readFrames(response)) {
      switch (frame.t) {
        case 'begin':
          slots = frame.slots;
          break;
        case 'hit':
          assert.ok(!hits.has(frame.i), `slot ${frame.i} produced two hits`);
          hits.set(frame.i, frame);
          break;
        case 'end':
          sawEnd = true;
          break;
        default:
          assert.fail(`unexpected frame type in /api/search: ${frame.t}`);
      }
    }

    assert.ok(sawEnd);
    assert.deepEqual(
      slots.map((s) => s.dict),
      requested,
      'begin.slots must be in the requested order',
    );
    // The documented quirk: begin is emitted before any dictionary is opened, so
    // the name is not known yet and the id is repeated instead. Row labels must
    // come from our own /api/dicts cache.
    for (const slot of slots) assert.equal(slot.name, slot.dict);
    assert.equal(hits.size, slots.length, 'every slot must be terminated by a hit');

    for (const [i, hit] of hits) {
      assert.equal(hit.dict, slots[i].dict, 'hit.dict must match its slot');
      // The real name arrives on the hit.
      assert.ok(hit.name);
      // Exactly one of the four outcomes. `skipped`/`error` arrive as explicit
      // null on a normal hit, so these must be truthiness checks.
      const outcomes = [
        hit.results && hit.results.length > 0,
        Boolean(hit.skipped),
        Boolean(hit.error),
      ].filter(Boolean);
      assert.ok(outcomes.length <= 1, `slot ${i} reported conflicting outcomes`);
      if (hit.results) {
        for (const result of hit.results) {
          assert.equal(typeof result.Headword, 'string');
          assert.equal(typeof result.Body, 'string');
        }
      }
    }
  });

  it('skips dictionaries that cannot answer the requested mode', async (t) => {
    if (!reachable) return t.skip(`no wudict at ${BASE_URL}`);
    const requested = dictIds.slice(0, 3);
    const url =
      `${BASE_URL}/api/search?q=speed&mode=contains&n=1` +
      `&dict=${encodeURIComponent(requested.join(','))}`;
    const response = await fetch(url);
    await assertStreamStarted(response);

    let skipped = 0;
    for await (const frame of readFrames(response)) {
      if (frame.t === 'hit' && frame.skipped) skipped += 1;
    }
    // Not an error: `contains` is not in every dictionary's caps.
    assert.ok(skipped >= 1, 'expected at least one skipped dictionary for mode=contains');
  });

  it('silently drops unknown ids, and 404s only when none resolve', async (t) => {
    if (!reachable) return t.skip(`no wudict at ${BASE_URL}`);
    const good = dictIds[0];
    const mixed = await fetch(
      `${BASE_URL}/api/search?q=speed&mode=exact&n=1&dict=deadbeefcafe,${good}`,
    );
    await assertStreamStarted(mixed);
    let slots = null;
    for await (const frame of readFrames(mixed)) {
      if (frame.t === 'begin') slots = frame.slots;
    }
    assert.deepEqual(
      slots.map((s) => s.dict),
      [good],
      'the unknown id must be dropped and the good one kept',
    );

    const allBad = await fetch(`${BASE_URL}/api/search?q=speed&dict=deadbeefcafe`);
    await assert.rejects(
      () => assertStreamStarted(allBad),
      (error) => {
        assert.equal(error.status, 404);
        return true;
      },
    );
  });
});
