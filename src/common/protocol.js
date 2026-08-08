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
