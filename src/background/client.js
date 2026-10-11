/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

// The wudict HTTP client: the only place that knows the server's URL shape and
// frame vocabulary.

import { OUTCOME } from '../common/protocol.js';
import { assertStreamStarted, ProtocolError, readFrames } from './ndjson.js';

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Thrown for a request that must not be sent, before any network activity. */
export class InvalidQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidQueryError';
  }
}

/**
 * Fetch the dictionary list. Called at startup and on explicit refresh — never
 * polled.
 *
 * With the `etag` of an earlier answer the request is conditional, and an
 * unchanged list is a bodiless 304 the server decides without opening a single
 * dictionary: resolves `{ notModified: true }`. Otherwise resolves
 * `{ total, dicts, etag }`, where `etag` is null when the server says this answer
 * must not be kept. It rides on `end`, not in a header, because whether an answer
 * may be kept is known only after its last row.
 *
 * `If-None-Match` is not CORS-safelisted, so a conditional request is preflighted.
 * Only a server that emits `etag` is ever sent one, and that server allows it.
 */
export async function fetchDicts(baseUrl, { signal, etag = null } = {}) {
  const headers = { accept: 'application/x-ndjson' };
  if (etag) headers['if-none-match'] = etag;

  const response = await fetch(`${baseUrl}/api/dicts`, { signal, headers });
  if (response.status === 304) return { notModified: true };
  await assertStreamStarted(response);

  let total = null;
  let end = null;
  const dicts = [];

  for await (const frame of readFrames(response)) {
    switch (frame.t) {
      case 'begin':
        total = frame.total ?? null;
        break;
      case 'dict':
        if (frame.dict?.id) {
          // Deliberately narrow: paths and sizes belong to the desktop panel. A row
          // that could not be opened is still sent, with `error`.
          const { id, name, format, entries, caps, error } = frame.dict;
          dicts.push({ id, name, format, entries, caps, error: error || null });
        }
        break;
      case 'end':
        end = frame;
        break;
      default:
        // `busy` progress frames, and whatever a later server adds.
        break;
    }
  }

  if (end === null) throw new ProtocolError('/api/dicts ended without an `end` frame');
  // Rows arrive in completion order, which differs on every request. Unsorted, the
  // default selection ("the first N that can answer") would change from one refresh
  // to the next for no reason the user could see.
  dicts.sort((a, b) => collator.compare(a.name ?? '', b.name ?? '') || (a.id < b.id ? -1 : 1));
  return { total, dicts, etag: typeof end.etag === 'string' && end.etag ? end.etag : null };
}

/**
 * Stream a search.
 *
 * Yields `{ t: 'begin', slots }` first, then one `{ t: 'hit', ... }` per slot in
 * completion order, then `{ t: 'end' }` — only if the server sent it, so a consumer
 * can tell a complete answer from a truncated one. Hits arrive out of request order
 * by design — render into slots by `i`.
 *
 * A slot that missed can then receive ONE more hit: when a single word finds
 * nothing in a dictionary, the server searches it again for the word's lemma and
 * announces that with a `{t:'morph', from, to, lang}` frame. Every hit after that
 * frame answers `to`, not the typed word, and replaces the slot's miss; it carries
 * `morph` so the reader can be told. A first-wave hit carries `morph: null`. So a
 * miss is final only at `end`; every other outcome is final at once.
 *
 * Frames the contract does not allow — a hit outside the slot range, a second hit
 * for a slot that did not miss, a third hit — are dropped rather than thrown on: one
 * malformed frame must not cost the dictionaries that answered correctly.
 */
export async function* search(baseUrl, query, { signal } = {}) {
  const url = buildSearchUrl(baseUrl, query);

  const response = await fetch(url, { signal, headers: { accept: 'application/x-ndjson' } });
  await assertStreamStarted(response);

  let slots = null;
  // Slot index -> 'first' (answered, still a miss), 'final'.
  const state = new Map();
  let morph = null;

  for await (const frame of readFrames(response)) {
    switch (frame.t) {
      case 'begin':
        // `i` is emitted on every frame and is meaningless here — switch on `t`.
        if (slots !== null) break;
        slots = (Array.isArray(frame.slots) ? frame.slots : []).map((slot) => ({
          dict: slot?.dict,
        }));
        yield { t: 'begin', slots };
        break;

      case 'hit': {
        if (slots === null) throw new ProtocolError('received a hit before begin');
        const { i } = frame;
        if (!Number.isInteger(i) || i < 0 || i >= slots.length) break;
        const seen = state.get(i);
        if (seen === 'final' || (seen === 'first' && morph === null)) break;

        const outcome = classifyHit(frame);
        state.set(i, morph === null && outcome === OUTCOME.EMPTY ? 'first' : 'final');
        yield {
          t: 'hit',
          i,
          // The slot is the authority on which dictionary this is.
          dict: slots[i].dict,
          // The real name arrives here, not on `begin`.
          name: typeof frame.name === 'string' ? frame.name : '',
          outcome,
          results: Array.isArray(frame.results) ? frame.results : [],
          error: frame.error || null,
          morph: seen === 'first' ? morph : null,
        };
        break;
      }

      case 'morph':
        // `i` is meaningless here too. Hits after this frame belong to `to`.
        morph = parseMorph(frame);
        break;

      case 'end':
        yield { t: 'end' };
        return;

      default:
        // `t` gains values over time; an unknown one must not break a lookup.
        break;
    }
  }
}

/**
 * `{ from, to, lang }` from a morph frame. A missing or blank field is null rather
 * than a reason to reject the frame: whatever it says, the hits after it are for a
 * different word than the one typed.
 */
export function parseMorph(frame) {
  const field = (value) => (typeof value === 'string' && value !== '' ? value : null);
  return { from: field(frame?.from), to: field(frame?.to), lang: field(frame?.lang) };
}

/**
 * Which outcome a `hit` carries.
 *
 * Truthiness checks throughout: an absent field and an explicit null must read the
 * same, and `'skipped' in frame` would not.
 */
export function classifyHit(frame) {
  if (frame.error) return OUTCOME.ERROR;
  if (frame.skipped) return OUTCOME.SKIPPED;
  if (frame.deferred) return OUTCOME.DEFERRED;
  if (Array.isArray(frame.results) && frame.results.length > 0) return OUTCOME.RESULTS;
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
