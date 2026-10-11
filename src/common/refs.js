/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

// Classifying the links inside an article, and building wudict page URLs.
//
// Pure string logic so it can be unit-tested directly; the routing that acts on it
// lives in the popup.
//
// The rule this exists to enforce: a click that changes *which word* or *which
// dictionary* is being shown leaves the popup and opens the full wudict in a tab.
// A popup has no address bar, no back button and no room; letting it navigate
// strands the user in a box they cannot get out of.

/** The same test the desktop UI uses. Anything else is out of scope. */
export const AUDIO_RE = /\.(mp3|ogg|wav|spx|m4a)(\?|#|$)/i;

// Six spellings of one thing, by six different repackers.
const SCHEME_RE = /^(?:(?:bword|entry):(?:\/\/)?|[dx]:)/i;

// A bare href is a headword only when it looks like nothing else. Each exclusion
// has an owner elsewhere: a real scheme, a rooted path, a fragment, and wudict's
// own res//assets/ prefixes. Drop one and `#sense2` gets searched as a word.
const BARE_EXCLUDE_RE = /^([a-z][\w+.-]*:|\/|#|res\/|assets\/)/i;

export const REF = {
  AUDIO: 'audio',
  LOOKUP: 'lookup',
  SUB: 'sub',
  ANCHOR: 'anchor',
  EXTERNAL: 'external',
  IGNORE: 'ignore',
};

/**
 * What a link inside an article means.
 *
 * Order matters: audio is tested first because an audio anchor is otherwise a
 * perfectly ordinary http(s) URL.
 */
export function classifyRef(rawHref) {
  // ASCII whitespace only, as a URL parser strips it. `String.prototype.trim` would
  // also eat a headword's own trailing U+3000 or NBSP.
  const href =
    typeof rawHref === 'string' ? rawHref.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '') : '';
  if (href === '') return { kind: REF.IGNORE };

  if (AUDIO_RE.test(href)) return { kind: REF.AUDIO, url: href };

  // A place in the article already on screen.
  if (href.startsWith('#')) {
    const id = decodeHalf(href.slice(1));
    return id ? { kind: REF.ANCHOR, id } : { kind: REF.IGNORE };
  }

  if (SCHEME_RE.test(href)) return afterScheme(href.replace(SCHEME_RE, ''));

  if (/^https?:/i.test(href)) return { kind: REF.EXTERNAL, url: href };

  if (BARE_EXCLUDE_RE.test(href)) return { kind: REF.IGNORE };

  // slob and OALD write cross-references bare.
  return afterScheme(href);
}

/**
 * Split at the **first literal `#`**, then percent-decode each half.
 *
 * Decoding first would promote a `#` inside a headword — which arrives
 * percent-encoded — into a delimiter.
 */
function afterScheme(rest) {
  const hash = rest.indexOf('#');
  const target = hash === -1 ? rest : rest.slice(0, hash);
  const word = decodeHalf(target);
  const fragment = hash === -1 ? '' : decodeHalf(rest.slice(hash + 1));

  if (word === '') {
    return fragment ? { kind: REF.ANCHOR, id: fragment } : { kind: REF.IGNORE };
  }
  // MDict repacks store an entry's collapsible sections as headwords beginning
  // with `@`. They are real headwords and resolve; the `@` passes through. Tested
  // BEFORE decoding: wudict encodes a headword's own leading `@` as `%40`, so
  // `entry://%40home` is the word `@home`, not a section.
  if (/^[ \t]*@/.test(target)) return { kind: REF.SUB, q: word, label: word.slice(1) };
  return { kind: REF.LOOKUP, q: word };
}

/**
 * Percent-decode all or nothing — a half that does not decode is kept as written —
 * then trim spaces and tabs only: a headword may begin or end with U+3000 or NBSP.
 */
function decodeHalf(value) {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Kept as written.
  }
  return decoded.replace(/^[ \t]+|[ \t]+$/g, '');
}

/**
 * A link to the full entry in the wudict page.
 *
 * `mode` and `dict` are always sent: the page only assigns a parameter that is
 * present, so an omitted `dict` silently searches whatever the user last selected
 * — which would make a "search everywhere" link search one dictionary.
 *
 * `dict` takes exactly one id or `all`. It is assigned to a <select>, not parsed
 * as a list, so a comma list matches no option and searches nothing.
 */
export function buildEntryUrl(baseUrl, { q, mode = 'exact', dict = 'all' }) {
  const enc = encodeURIComponent;
  return `${baseUrl}/?q=${enc(q)}&mode=${enc(mode)}&dict=${enc(dict)}`;
}
