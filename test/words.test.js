/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { candidates, extractTerm, toStraightApostrophes } from '../src/content/words.js';

/** Extract at the offset of the first `|` marker, which is removed from the text. */
function at(marked) {
  const offset = marked.indexOf('|');
  assert.notEqual(offset, -1, 'fixture must contain a | cursor marker');
  return extractTerm(marked.replace('|', ''), offset);
}

describe('extractTerm — punctuation', () => {
  const cases = [
    ['plain word', 'the qu|ick fox', 'quick'],
    ['comma follows', 'Hello, wo|rld', 'world'],
    ['full stop follows', 'the e|nd. Next', 'end'],
    ['curly quotes around', '“Hel|lo”', 'Hello'],
    ['straight quotes around', '"Hel|lo"', 'Hello'],
    ['parenthesised', '(paren|thesised)', 'parenthesised'],
    ['bracketed', '[brack|eted]', 'bracketed'],
    ['semicolon follows', 'one; tw|o', 'two'],
    ['exclamation follows', 'wo|w!', 'wow'],
    ['ellipsis follows', 'wa|it…', 'wait'],
    ['colon follows', 'not|e: this', 'note'],
    ['curly apostrophe kept', 'do|n’t stop', 'don’t'],
    ['straight apostrophe kept', "do|n't stop", "don't"],
    ['leading apostrophe trimmed', '‘quo|ted’', 'quoted'],
    ['possessive apostrophe kept', "the do|g's bone", "dog's"],
    ['plural possessive trimmed', "the dog|s' bones", 'dogs'],
    ['hyphen kept inside', 'a well-kn|own fact', 'well-known'],
    ['trailing hyphen trimmed', 'line end-| break', 'end'],
    ['em dash is a boundary', 'a—b|c', 'bc'],
    ['en dash is a boundary', '1990–2|000', '2000'],
    ['accented letters', 'caf|é noir', 'café'],
    ['digits are word chars', 'COVID-1|9 era', 'COVID-19'],
    ['underscore is a boundary', 'snake_ca|se', 'case'],
    ['slash is a boundary', 'and/o|r', 'or'],
  ];

  for (const [name, marked, expected] of cases) {
    it(name, () => {
      assert.equal(at(marked)?.term, expected);
    });
  }

  it('joins a dotted abbreviation rather than stopping at the first stop', () => {
    // A full stop is a boundary everywhere else, so without this `U.S.A.` yields `U`.
    assert.equal(at('the U|.S.A. today')?.term, 'U.S.A.');
    assert.equal(at('the U.S|.A. today')?.term, 'U.S.A.');
    assert.equal(at('e|.g. this')?.term, 'e.g.');
  });

  it('does not treat a sentence boundary as an abbreviation', () => {
    assert.equal(at('I sa|w it. Then left')?.term, 'saw');
    // A single letter followed by one stop is not enough.
    assert.equal(at('a| . b')?.term, 'a');
  });
});

describe('extractTerm — invisible characters', () => {
  it('sees through a soft hyphen', () => {
    // Justified text is full of these and they otherwise split a word silently.
    const found = extractTerm('hy­phen', 4);
    assert.equal(found.term, 'hyphen');
  });

  it('sees through a zero-width space', () => {
    assert.equal(extractTerm('wo​rd', 4).term, 'word');
  });

  it('reports the span in original-string coordinates', () => {
    const text = 'a hy­phen b';
    const found = extractTerm(text, 6);
    assert.equal(found.term, 'hyphen');
    // The span must cover the soft hyphen so the Range highlights the whole word.
    assert.equal(text.slice(found.start, found.end), 'hy­phen');
  });
});

describe('extractTerm — boundaries and misses', () => {
  it('resolves the same word from both halves of a character', () => {
    // caretPositionFromPoint reports the nearest caret boundary, so the right half
    // of the last letter yields an offset past the word.
    const text = 'go now';
    assert.equal(extractTerm(text, 0).term, 'go');
    assert.equal(extractTerm(text, 1).term, 'go');
    assert.equal(extractTerm(text, 2).term, 'go');
  });

  it('returns null in a run of punctuation', () => {
    assert.equal(extractTerm('a --- b', 3), null);
  });

  it('returns null for empty or non-string input', () => {
    assert.equal(extractTerm('', 0), null);
    assert.equal(extractTerm(null, 0), null);
    assert.equal(extractTerm('   ', 1), null);
  });

  it('returns null past the end of a text node', () => {
    assert.equal(extractTerm('   ', 99), null);
  });

  it('never returns a whitespace-only term', () => {
    // An empty or whitespace-only q is a 400, and hovering gaps is the common case.
    for (const text of ['   ', '\t', '. , ;', '­​']) {
      for (let offset = 0; offset <= text.length; offset += 1) {
        const found = extractTerm(text, offset);
        if (found) assert.notEqual(found.term.trim(), '');
      }
    }
  });
});

describe('candidates', () => {
  it('starts with the term as written', () => {
    assert.equal(candidates('speed')[0], 'speed');
  });

  it('normalises a curly apostrophe, which dictionaries do not index', () => {
    const chain = candidates('don’t');
    assert.deepEqual(chain.slice(0, 2), ['don’t', "don't"]);
  });

  it('strips a possessive', () => {
    assert.ok(candidates("dog's").includes('dog'));
  });

  it('offers hyphen variants', () => {
    const chain = candidates('well-known', 8);
    assert.ok(chain.includes('well known'));
    assert.ok(chain.includes('wellknown'));
  });

  it('falls back to naive suffix stripping', () => {
    assert.ok(candidates('cats', 8).includes('cat'));
    assert.ok(candidates('running', 8).includes('run'));
    assert.ok(candidates('flies', 8).includes('fly'));
    assert.ok(candidates('quickly', 8).includes('quick'));
    assert.ok(candidates('boxes', 8).includes('box'));
  });

  it('does not strip the s from words that end in ss or us', () => {
    assert.ok(!candidates('glass', 8).includes('glas'));
    assert.ok(!candidates('bonus', 8).includes('bonu'));
  });

  it('deduplicates and respects the limit', () => {
    const chain = candidates('speed', 4);
    assert.ok(chain.length <= 4);
    assert.equal(new Set(chain).size, chain.length);
  });

  it('always returns at least the term itself', () => {
    assert.deepEqual(candidates('speed', 0), ['speed']);
  });

  it('never emits an empty candidate', () => {
    for (const term of ['a', "'", 'a-', '--', 'ss']) {
      for (const candidate of candidates(term, 8)) assert.notEqual(candidate.trim(), '');
    }
  });
});

describe('toStraightApostrophes', () => {
  it('converts every curly form', () => {
    assert.equal(toStraightApostrophes('’ʼ‘'), "'''");
  });
});
