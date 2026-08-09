/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

// Word boundary detection and the lookup fallback chain.
//
// Pure string logic, deliberately free of DOM access so it can be unit-tested
// directly — this is the piece with enough branching to deserve it.

const WORD_RE = /[\p{L}\p{M}\p{N}]/u;

// Kept inside a word, trimmed at either end. Curly apostrophes matter more than
// straight ones: real prose is full of `don’t`, while dictionaries index `don't`.
const APOSTROPHES = "'’ʼ‘";
const HYPHENS = '-‑';
const INTRA = new Set([...APOSTROPHES, ...HYPHENS]);

// Stripped before expansion, with the offset adjusted to match. Justified text and
// CMS-mangled copy are full of these, and they otherwise split a word invisibly.
const INVISIBLE = new Set(['­', '​', '‌', '‍', '﻿']);

const DOTTED_ABBREVIATION = /^(?:\p{L}\.){2,}$/u;

export function isWordChar(char) {
  return WORD_RE.test(char);
}

function isWordish(char) {
  return WORD_RE.test(char) || INTRA.has(char);
}

/** Characters that survive, each carrying its index in the original string. */
function visibleChars(text) {
  const chars = [];
  for (let i = 0; i < text.length; i += 1) {
    if (!INVISIBLE.has(text[i])) chars.push({ c: text[i], i });
  }
  return chars;
}

/**
 * Extract the word at `offset`, returning it with the original-string span so the
 * caller can build a Range over exactly those characters.
 *
 * `caretPositionFromPoint` reports the nearest caret *boundary*, not the character
 * under the cursor, so the right half of a word's last letter yields an offset past
 * the end of that word. Checking the character before the offset when the one at it
 * is not wordish makes both halves of every character resolve to the same word.
 */
export function extractTerm(text, offset) {
  if (typeof text !== 'string' || text === '') return null;

  const chars = visibleChars(text);
  if (chars.length === 0) return null;

  let k = chars.findIndex((ch) => ch.i >= offset);
  if (k === -1) k = chars.length;

  let pos = -1;
  if (k < chars.length && isWordish(chars[k].c)) pos = k;
  else if (k > 0 && isWordish(chars[k - 1].c)) pos = k - 1;
  if (pos === -1) return null;

  let start = pos;
  let end = pos;
  while (start > 0 && isWordish(chars[start - 1].c)) start -= 1;
  while (end + 1 < chars.length && isWordish(chars[end + 1].c)) end += 1;

  // Apostrophes and hyphens are only intra-word; at an edge they are punctuation.
  while (start <= end && INTRA.has(chars[start].c)) start += 1;
  while (end >= start && INTRA.has(chars[end].c)) end -= 1;
  if (start > end) return null;

  const expanded = expandAbbreviation(chars, start, end);
  const term = chars
    .slice(expanded.start, expanded.end + 1)
    .map((ch) => ch.c)
    .join('');
  if (term === '') return null;

  return { term, start: chars[expanded.start].i, end: chars[expanded.end].i + 1 };
}

/**
 * Grow a single letter into a dotted abbreviation (`U.S.A.`, `e.g.`).
 *
 * A full stop is a boundary everywhere else, so without this, hovering `U.S.A.`
 * looks up `U`. Requires at least two letter-dot groups, which keeps it from
 * swallowing a sentence boundary like `...the end. Next...`.
 */
function expandAbbreviation(chars, start, end) {
  if (end !== start) return { start, end };

  let left = start;
  let right = end;

  while (
    right + 2 < chars.length &&
    chars[right + 1].c === '.' &&
    WORD_RE.test(chars[right + 2].c)
  ) {
    right += 2;
  }
  if (right + 1 < chars.length && chars[right + 1].c === '.') right += 1;

  while (left >= 2 && chars[left - 1].c === '.' && WORD_RE.test(chars[left - 2].c)) {
    left -= 2;
  }

  const candidate = chars
    .slice(left, right + 1)
    .map((ch) => ch.c)
    .join('');
  return DOTTED_ABBREVIATION.test(candidate) ? { start: left, end: right } : { start, end };
}

/**
 * The fallback chain, in the order it should be tried.
 *
 * wudict has no morphology: `q=running` hits only if some dictionary stores
 * *running* as a headword. Large dictionaries usually do, but coverage varies, so
 * the client owns its own chain. Each entry costs one request, but only for a word
 * that would otherwise show nothing — and misses are cached.
 */
export function candidates(term, limit = 4) {
  const out = [];
  const add = (value) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed);
  };

  add(term);

  // Real text uses `’`; dictionaries index `'`. This single step recovers most
  // contractions, so it comes before anything lossy.
  const straight = toStraightApostrophes(term);
  add(straight);

  // Possessives: `dog's` -> `dog`. (`dogs’` already lost its apostrophe to the
  // edge-trimming in extractTerm.)
  add(straight.replace(/'s$/i, ''));

  if (straight.includes('-')) {
    add(straight.replace(/-/g, ' '));
    add(straight.replace(/-/g, ''));
  }

  for (const stripped of stripSuffixes(straight)) add(stripped);

  return out.slice(0, Math.max(1, limit));
}

export function toStraightApostrophes(term) {
  return term.replace(/[’ʼ‘]/g, "'");
}

/** Naive suffix stripping — the last resort the contract recommends. */
function stripSuffixes(term) {
  const lower = term.toLowerCase();
  const out = [];
  const add = (value) => {
    if (value && value.length >= 2) out.push(value);
  };

  if (/ies$/.test(lower)) add(term.slice(0, -3) + 'y');
  if (/(?:sses|shes|ches|xes|zes)$/.test(lower)) add(term.slice(0, -2));
  if (/s$/.test(lower) && !/(?:ss|us|is)$/.test(lower)) add(term.slice(0, -1));
  if (/ing$/.test(lower)) {
    const stem = term.slice(0, -3);
    add(stem);
    add(stem + 'e');
    if (hasDoubledFinal(stem)) add(stem.slice(0, -1));
  }
  if (/ed$/.test(lower)) {
    const stem = term.slice(0, -2);
    add(stem);
    add(term.slice(0, -1));
    if (hasDoubledFinal(stem)) add(stem.slice(0, -1));
  }
  if (/ly$/.test(lower)) add(term.slice(0, -2));

  return out;
}

function hasDoubledFinal(stem) {
  return stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2];
}
