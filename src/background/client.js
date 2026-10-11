/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

// The wudict HTTP client: the only place that knows the server's URL shape and
// frame vocabulary.

import { OUTCOME } from '../common/protocol.js';
import { assertStreamStarted, readFrames } from './ndjson.js';

/** Thrown for a request that must not be sent, before any network activity. */
export class InvalidQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidQueryError';
  }
}

/**
 * Fetch the dictionary list. Called once at startup and on explicit refresh —
 * never polled.
 *
 * `begin.total` is an upper bound, not a row count: a dictionary that cannot be
 * described is omitted. So the terminator is `end`, never a count.
 */
export async function fetchDicts(baseUrl, { signal } = {}) {
  const response = await fetch(`${baseUrl}/api/dicts`, {
    signal,
    headers: { accept: 'application/x-ndjson' },
  });
  await assertStreamStarted(response);

  let total = null;
  let sawEnd = false;
  const dicts = [];

  for await (const frame of readFrames(response)) {
    switch (frame.t) {
      case 'begin':
        total = frame.total ?? null;
        break;
      case 'dict':
        if (frame.dict?.id) {
          // Deliberately narrow: paths and sizes belong to the desktop panel.
          const { id, name, format, entries, caps } = frame.dict;
          dicts.push({ id, name, format, entries, caps });
        }
        break;
      case 'end':
        sawEnd = true;
        break;
      default:
        break;
    }
  }

  if (!sawEnd) throw new Error('/api/dicts ended without an `end` frame');
  return { total, dicts };
}

/**
 * Stream a search.
 *
 * Yields `{ t: 'begin', slots }` first, then one `{ t: 'hit', ... }` per slot in
 * completion order, and nothing after the stream ends. Hits arrive out of request
 * order by design — render into slots by `i`.
 *
 * A slot can then receive ONE more hit: when a single word finds nothing in some
 * dictionaries, the server searches those again for the word's lemma and announces
 * it with a `{t:'morph', from, to, lang}` frame. Every hit after that frame is for
 * `to`, not the typed word, and replaces the slot's miss; it carries `morph` so the
 * reader can be told. A first-wave hit carries `morph: null`. So a non-results hit
 * is final only once the stream has ended.
 */
export async function* search(baseUrl, query, { signal } = {}) {
  const url = buildSearchUrl(baseUrl, query);

  const response = await fetch(url, { signal, headers: { accept: 'application/x-ndjson' } });
  await assertStreamStarted(response);

  let slots = null;
  const seen = new Set();
  // Slots already re-answered by a lemma wave, and the wave currently streaming.
  const relemmatised = new Set();
  let morph = null;

  for await (const frame of readFrames(response)) {
    switch (frame.t) {
      case 'begin':
        // `i` is emitted on every frame and is meaningless here — switch on `t`.
        slots = (frame.slots ?? []).map((slot) => ({ dict: slot.dict }));
        yield { t: 'begin', slots };
        break;

      case 'hit': {
        if (slots === null) throw new Error('received a hit before begin');
        if (seen.has(frame.i)) {
          // A second hit is legal only once per slot, and only for a lemma.
          if (morph === null || relemmatised.has(frame.i)) {
            throw new Error(`slot ${frame.i} produced two hits`);
          }
          relemmatised.add(frame.i);
        }
        seen.add(frame.i);
        yield {
          t: 'hit',
          i: frame.i,
          dict: frame.dict,
          // The real name arrives here, not on `begin`.
          name: frame.name,
          outcome: classifyHit(frame),
          results: frame.results ?? [],
          error: frame.error ?? null,
          morph,
        };
        break;
      }

      case 'morph':
        // `i` is meaningless here too. Hits after this frame belong to `to`.
        morph = parseMorph(frame);
        if (morph === null) throw new Error('malformed morph frame');
        break;

      case 'end':
        return;

      default:
        // The contract fixes `t` at begin|hit|morph|end. A future addition should not
        // break a lookup, so it is ignored rather than thrown on.
        break;
    }
  }
}

/** `{ from, to, lang }` from a morph frame, or null if any part is not a non-empty string. */
export function parseMorph(frame) {
  const { from, to, lang } = frame ?? {};
  const ok = [from, to, lang].every((value) => typeof value === 'string' && value !== '');
  return ok ? { from, to, lang } : null;
}

/**
 * Which of the four outcomes a `hit` carries.
 *
 * `skipped` and `error` arrive as explicit JSON null on a normal hit rather than
 * being absent, so these must be truthiness checks — `'skipped' in frame` is true
 * even when the dictionary was not skipped.
 */
export function classifyHit(frame) {
  if (frame.error) return OUTCOME.ERROR;
  if (frame.skipped) return OUTCOME.SKIPPED;
  if (frame.results && frame.results.length > 0) return OUTCOME.RESULTS;
  return OUTCOME.EMPTY;
}

export function buildSearchUrl(baseUrl, { q, dicts, mode, n, format }) {
  // An empty or whitespace-only q is a 400, and a hover handler fires one on every
  // gap between words — so it never leaves the client.
  if (typeof q !== 'string' || q.trim() === '') {
    throw new InvalidQueryError('q must be a non-empty, non-whitespace string');
  }
  if (!Array.isArray(dicts) || dicts.length === 0) {
    throw new InvalidQueryError('at least one dictionary id is required');
  }

  const params = new URLSearchParams({
    q,
    mode,
    // The server default is 20 per dictionary; always explicit.
    n: String(n),
    format,
    dict: dicts.join(','),
  });
  return `${baseUrl}/api/search?${params}`;
}

/**
 * Ids the server dropped from the request.
 *
 * Unknown ids are silently dropped and the search proceeds with whatever resolved
 * (only an all-unknown list is a 404), so a stale id degrades quietly unless the
 * returned slots are compared against what was asked for.
 */
export function droppedIds(requested, slots) {
  const returned = new Set(slots.map((slot) => slot.dict));
  return requested.filter((id) => !returned.has(id));
}
