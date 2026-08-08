import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveUrl } from '../src/content/sanitize.js';

// Only the URL policy is covered here: it is the security-critical half and is pure.
// sanitizeArticle needs DOMParser and a document, which node has no business
// providing without pulling in jsdom — it is exercised in the browser instead.

const ORIGIN = 'http://127.0.0.1:6888';

describe('resolveUrl — media', () => {
  for (const tag of ['img', 'audio', 'source']) {
    it(`${tag}: keeps a URL on the wudict origin`, () => {
      assert.equal(
        resolveUrl(`${ORIGIN}/res/abc/spkr.png`, ORIGIN, tag),
        `${ORIGIN}/res/abc/spkr.png`,
      );
    });

    it(`${tag}: absolutises a root-absolute /res/ path against the server`, () => {
      // format=clean already does this, but an older server would not — and the
      // path would otherwise resolve against the host page and 404.
      assert.equal(resolveUrl('/res/abc/spkr.png', ORIGIN, tag), `${ORIGIN}/res/abc/spkr.png`);
    });

    it(`${tag}: rejects a third-party origin`, () => {
      // Stops a dictionary from beaconing to someone else's server.
      assert.equal(resolveUrl('https://evil.example/pixel.gif', ORIGIN, tag), null);
    });

    it(`${tag}: rejects javascript: and other schemes`, () => {
      assert.equal(resolveUrl('javascript:alert(1)', ORIGIN, tag), null);
      assert.equal(resolveUrl('vbscript:msgbox', ORIGIN, tag), null);
      assert.equal(resolveUrl('file:///etc/passwd', ORIGIN, tag), null);
    });

    it(`${tag}: rejects a protocol-relative URL`, () => {
      assert.equal(resolveUrl('//evil.example/x.png', ORIGIN, tag), null);
    });
  }

  it('allows an inline image but not other data: payloads', () => {
    const image = 'data:image/png;base64,iVBORw0KGgo=';
    assert.equal(resolveUrl(image, ORIGIN, 'img'), image);
    assert.equal(resolveUrl('data:text/html,<script>x</script>', ORIGIN, 'img'), null);
    assert.equal(resolveUrl('data:application/javascript,alert(1)', ORIGIN, 'img'), null);
  });
});

describe('resolveUrl — links', () => {
  it('allows external http(s) links', () => {
    assert.equal(resolveUrl('https://example.org/entry', ORIGIN, 'a'), 'https://example.org/entry');
  });

  it('rejects a javascript: link', () => {
    assert.equal(resolveUrl('javascript:alert(1)', ORIGIN, 'a'), null);
  });

  it('gives a fragment-only link no href', () => {
    // It must not become a navigable href — inside a popup on someone else's page
    // that navigates the host site. The original is preserved in data-ref and
    // routed at click time, where it scrolls within the popup instead.
    assert.equal(resolveUrl('#sense2', ORIGIN, 'a'), null);
  });

  it('gives a bword:/entry:/bare cross-reference no href', () => {
    // Same reason: these are not URLs at all. data-ref carries them.
    assert.equal(resolveUrl('bword://run', ORIGIN, 'a'), null);
    assert.equal(resolveUrl('d:run', ORIGIN, 'a'), null);
  });

  it('drops an empty or whitespace href', () => {
    assert.equal(resolveUrl('', ORIGIN, 'a'), null);
    assert.equal(resolveUrl('   ', ORIGIN, 'a'), null);
  });

  it('tolerates a malformed URL rather than throwing', () => {
    assert.equal(resolveUrl('http://[', ORIGIN, 'a'), null);
  });
});
