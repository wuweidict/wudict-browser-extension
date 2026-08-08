import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildEntryUrl, classifyRef, REF } from '../src/common/refs.js';

const BASE = 'http://127.0.0.1:6888';

describe('classifyRef — the six spellings of a lookup', () => {
  for (const href of ['bword://run', 'bword:run', 'entry://run', 'entry:run', 'd:run', 'x:run']) {
    it(`${href} is a lookup for "run"`, () => {
      assert.deepEqual(classifyRef(href), { kind: REF.LOOKUP, q: 'run' });
    });
  }

  it('is case-insensitive about the scheme', () => {
    assert.equal(classifyRef('BWORD://run').kind, REF.LOOKUP);
    assert.equal(classifyRef('X:run').kind, REF.LOOKUP);
  });

  it('treats a bare href as a headword', () => {
    // slob and OALD write cross-references bare.
    assert.deepEqual(classifyRef('defendant'), { kind: REF.LOOKUP, q: 'defendant' });
  });

  it('percent-decodes the headword', () => {
    assert.equal(classifyRef('bword://caf%C3%A9').q, 'café');
    assert.equal(classifyRef('bword://New%20York').q, 'New York');
  });

  it('splits at the first literal # before decoding', () => {
    // A # inside a headword arrives percent-encoded; decoding first would promote
    // it to a delimiter and truncate the word.
    assert.equal(classifyRef('bword://C%23').q, 'C#');
    assert.equal(classifyRef('bword://run#sense2').q, 'run');
  });

  it('survives a malformed percent escape', () => {
    assert.equal(classifyRef('bword://100%').kind, REF.LOOKUP);
  });
});

describe('classifyRef — sections', () => {
  it('treats an @-prefixed headword as a section', () => {
    const ref = classifyRef('bword://@Examples');
    assert.equal(ref.kind, REF.SUB);
    // The @ passes through: it is a real headword and resolves.
    assert.equal(ref.q, '@Examples');
    // A label without it, because "@Examples" shown raw looks like a bug.
    assert.equal(ref.label, 'Examples');
  });

  it('recognises a bare @-section too', () => {
    assert.equal(classifyRef('@Word Origin').kind, REF.SUB);
  });
});

describe('classifyRef — anchors', () => {
  it('recognises a bare fragment', () => {
    assert.deepEqual(classifyRef('#sense2'), { kind: REF.ANCHOR, id: 'sense2' });
  });

  it('recognises a scheme-with-fragment-only', () => {
    assert.deepEqual(classifyRef('bword://#sense2'), { kind: REF.ANCHOR, id: 'sense2' });
  });

  it('ignores an empty fragment', () => {
    assert.equal(classifyRef('#').kind, REF.IGNORE);
  });
});

describe('classifyRef — audio', () => {
  for (const ext of ['mp3', 'ogg', 'wav', 'spx', 'm4a']) {
    it(`recognises .${ext}`, () => {
      const ref = classifyRef(`${BASE}/res/abc/say.${ext}`);
      assert.equal(ref.kind, REF.AUDIO);
    });
  }

  it('recognises audio followed by a query or fragment', () => {
    assert.equal(classifyRef('/res/a/x.mp3?v=2').kind, REF.AUDIO);
    assert.equal(classifyRef('/res/a/x.wav#t=1').kind, REF.AUDIO);
  });

  it('wins over the external classification', () => {
    // An audio anchor is otherwise a perfectly ordinary http(s) URL.
    assert.equal(classifyRef('https://example.org/say.mp3').kind, REF.AUDIO);
  });

  it('is case-insensitive about the extension', () => {
    assert.equal(classifyRef('/res/a/X.MP3').kind, REF.AUDIO);
  });

  it('does not match an extension in the middle of a path', () => {
    assert.notEqual(classifyRef('/res/a/mp3file/x.png').kind, REF.AUDIO);
  });
});

describe('classifyRef — external and ignored', () => {
  it('treats http(s) as external', () => {
    assert.deepEqual(classifyRef('https://example.org/x'), {
      kind: REF.EXTERNAL,
      url: 'https://example.org/x',
    });
  });

  for (const href of ['/rooted/path', 'res/spkr.png', 'assets/app.js', 'mailto:a@b.c']) {
    it(`ignores ${href}`, () => {
      // Each exclusion has an owner elsewhere; dropping one would search for it.
      assert.equal(classifyRef(href).kind, REF.IGNORE);
    });
  }

  it('ignores empty and non-string input', () => {
    assert.equal(classifyRef('').kind, REF.IGNORE);
    assert.equal(classifyRef('   ').kind, REF.IGNORE);
    assert.equal(classifyRef(null).kind, REF.IGNORE);
    assert.equal(classifyRef(undefined).kind, REF.IGNORE);
  });

  it('never classifies a fragment as a word', () => {
    for (const href of ['#sense2', 'bword://#sense2', '#']) {
      assert.notEqual(classifyRef(href).kind, REF.LOOKUP);
    }
  });
});

describe('buildEntryUrl', () => {
  it('always sends mode and dict, even at their defaults', () => {
    // The page only assigns a parameter that is present, so an omitted dict
    // silently searches whatever the user last selected.
    const url = new URL(buildEntryUrl(BASE, { q: 'speed' }));
    assert.equal(url.searchParams.get('q'), 'speed');
    assert.equal(url.searchParams.get('mode'), 'exact');
    assert.equal(url.searchParams.get('dict'), 'all');
  });

  it('scopes to a single dictionary id', () => {
    const url = new URL(buildEntryUrl(BASE, { q: 'speed', dict: '04cee2b110f1' }));
    assert.equal(url.searchParams.get('dict'), '04cee2b110f1');
    assert.equal(url.pathname, '/');
  });

  it('encodes a term that would break the query string', () => {
    const url = new URL(buildEntryUrl(BASE, { q: 'rock & roll', dict: 'all' }));
    assert.equal(url.searchParams.get('q'), 'rock & roll');
  });

  it('encodes an @-section headword', () => {
    const url = new URL(buildEntryUrl(BASE, { q: '@Examples', dict: 'abc' }));
    assert.equal(url.searchParams.get('q'), '@Examples');
  });

  it('never sets theme, which would overwrite a stored preference', () => {
    assert.ok(!buildEntryUrl(BASE, { q: 'speed' }).includes('theme'));
  });

  it('honours a base URL with a path prefix', () => {
    assert.ok(
      buildEntryUrl('http://host:8080/wudict', { q: 'x' }).startsWith('http://host:8080/wudict/?'),
    );
  });
});
