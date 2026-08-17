/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

// The content script <-> background port protocol.
//
// A one-shot `sendMessage` would force the worker to buffer the whole NDJSON stream
// before replying, throwing away the point of the server's slot model. A long-lived
// port forwards each frame as it lands, and its disconnect is what aborts the
// in-flight fetch.
//
// Content script -> background:
//   { type: LOOKUP, id, candidates: [string], dicts?, mode?, n?, format? }
//   { type: CANCEL, id }
//
// Background -> content script:
//   { type: BEGIN,  id, term, slots: [{ dict, name }] }
//   { type: HIT,    id, i, dict, name, outcome, results, error }
//   { type: END,    id, term, matched, fromCache }
//   { type: FAILED, id, reason, status?, message }
//
// Only one lookup is in flight per port: a new LOOKUP aborts the previous one, which
// the server honours by stopping work.
//
// `slots[].name` from the server is the dictionary id repeated, because `begin` is
// emitted before any dictionary is opened. The background fills in real names from
// the persisted /api/dicts registry, so the content script never needs it.
//
// CANDIDATES AND COMMITMENT. `candidates` is the fallback chain (exact spelling,
// then apostrophe/possessive/hyphen variants, then naive suffix stripping) because
// wudict does not lemmatise. The background walks it in order and *commits* to the
// first candidate that produces an actual result: nothing is posted until then, so
// a fallback never paints a popup that is immediately replaced. Once committed,
// remaining hits stream live. If no candidate produces results, the only message is
// END with `matched: false` and no popup is ever shown.

// MEDIA AND AUDIO. These are one-shot `runtime.sendMessage` calls, not port frames:
// each is one request with one answer, asked at times unrelated to a lookup (a slot
// scrolling into view, a speaker icon clicked).
//
// They exist because nothing on the server's origin may appear as a URL in the host
// page's DOM — such a request would be the *page's*, and the browser would ask the
// user whether the site they are reading may reach their local network (D69). Media
// arrives as bytes and becomes a blob URL in the popup; audio never reaches the page
// at all.
//
//   { type: MEDIA_GET, url }  -> { ok: true, mime, b64 } | { ok: false, message }
//   { type: AUDIO_PLAY, url } -> { ok } (offscreen document, or the background page)
//   { type: AUDIO_STOP }      -> { ok }

export const MEDIA_GET = 'wudict:media';
export const AUDIO_PLAY = 'wudict:audio';
export const AUDIO_STOP = 'wudict:audioStop';

// Chrome's offscreen document shares the extension's message bus with every other
// extension page, so its messages carry a target as well as a type.
export const OFFSCREEN_TARGET = 'wudict-offscreen';
export const OFFSCREEN_PLAY = 'wudict:offscreen-play';
export const OFFSCREEN_STOP = 'wudict:offscreen-stop';

export const PORT_NAME = 'wudict';

export const LOOKUP = 'lookup';
export const CANCEL = 'cancel';

export const BEGIN = 'begin';
export const HIT = 'hit';
export const END = 'end';
export const FAILED = 'failed';

/** The four mutually exclusive outcomes of a `hit`, which terminates its slot. */
export const OUTCOME = {
  RESULTS: 'results',
  EMPTY: 'empty',
  SKIPPED: 'skipped',
  ERROR: 'error',
};

/** Hover defaults. `n` matters: the server's default is 20, far too many. */
export const LOOKUP_DEFAULTS = {
  mode: 'exact',
  n: 1,
  format: 'clean',
};
