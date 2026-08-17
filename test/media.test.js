/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, it } from 'node:test';

import {
  createMediaProxy,
  fetchMedia,
  isMediaType,
  MediaError,
  mediaUrl,
  toBase64,
} from '../src/background/media.js';

const BASE = 'http://127.0.0.1:6888';

/** A Response-shaped stub: only what fetchMedia actually reads. */
function reply(options = {}) {
  const { status = 200, type = 'image/png', length, body = new Uint8Array([1, 2, 3]) } = options;
  const headers = new Map();
  if (type !== null) headers.set('content-type', type);
  if (length !== undefined) headers.set('content-length', String(length));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

/** Records every call, answers with `responses` in order. */
function recorder(...responses) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  };
  impl.calls = calls;
  return impl;
}

describe('mediaUrl', () => {
  it('resolves a relative /res/ path against the base', () => {
    assert.equal(mediaUrl('/res/ldoce/a.png', BASE), `${BASE}/res/ldoce/a.png`);
    assert.equal(mediaUrl('res/ldoce/a.png', BASE), `${BASE}/res/ldoce/a.png`);
  });

  it('accepts an absolute URL on the same origin', () => {
    assert.equal(mediaUrl(`${BASE}/res/x.wav`, BASE), `${BASE}/res/x.wav`);
  });

  it('refuses another origin, whatever the path says', () => {
    assert.throws(() => mediaUrl('http://evil.example/res/x.png', BASE), MediaError);
    // Same host, different port: a different origin, and a different server.
    assert.throws(() => mediaUrl('http://127.0.0.1:9999/res/x.png', BASE), MediaError);
    assert.throws(() => mediaUrl('https://127.0.0.1:6888/res/x.png', BASE), MediaError);
  });

  it('refuses non-http schemes', () => {
    for (const raw of ['data:image/png;base64,AAAA', 'file:///etc/passwd', 'blob:x']) {
      assert.throws(() => mediaUrl(raw, BASE), MediaError);
    }
  });

  it('refuses anything outside /res/, including the private API', () => {
    for (const path of ['/api/library', '/api/search?q=a', '/', '/resource/x.png']) {
      assert.throws(() => mediaUrl(path, BASE), MediaError);
    }
  });

  it('does not let traversal escape the /res/ prefix', () => {
    // `new URL` normalises the dot segments, so the check sees the real path.
    assert.throws(() => mediaUrl('/res/../api/library', BASE), MediaError);
  });

  it('derives the prefix from a wudict mounted under a path', () => {
    const mounted = 'http://127.0.0.1:6888/dict';
    assert.equal(mediaUrl('/dict/res/a.png', mounted), `${mounted}/res/a.png`);
    assert.throws(() => mediaUrl('/res/a.png', mounted), MediaError);
  });

  it('rejects a malformed base and a malformed URL', () => {
    assert.throws(() => mediaUrl('/res/a.png', 'not a url'), MediaError);
    assert.throws(() => mediaUrl(null, BASE), MediaError);
  });
});

describe('isMediaType', () => {
  it('accepts image and audio, with parameters', () => {
    assert.equal(isMediaType('image/png'), true);
    assert.equal(isMediaType('audio/wav; charset=binary'), true);
    assert.equal(isMediaType('IMAGE/JPEG'), true);
  });

  it('refuses everything else', () => {
    for (const type of ['text/html', 'application/json', '', null, undefined, 'video/mp4']) {
      assert.equal(isMediaType(type), false);
    }
  });
});

describe('toBase64', () => {
  it('matches the reference encoding across the chunk boundary', () => {
    // 8 KiB is the chunk size; 20 000 bytes crosses it twice and ends mid-chunk.
    const bytes = new Uint8Array(20_000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7) % 256;
    assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'));
  });

  it('encodes an empty array', () => {
    assert.equal(toBase64(new Uint8Array(0)), '');
  });
});

describe('fetchMedia', () => {
  it('returns the mime, the base64 and the byte count', async () => {
    const body = new Uint8Array([0, 1, 2, 250]);
    const impl = recorder(reply({ type: 'image/png', body }));

    const result = await fetchMedia('/res/a.png', { baseUrl: BASE, fetchImpl: impl });

    assert.deepEqual(result, {
      mime: 'image/png',
      b64: Buffer.from(body).toString('base64'),
      bytes: 4,
    });
    assert.equal(impl.calls[0].url, `${BASE}/res/a.png`);
    assert.equal(impl.calls[0].options.credentials, 'omit');
    assert.equal(impl.calls[0].options.headers.accept, 'image/*,audio/*');
  });

  it('validates the URL itself, before any request', async () => {
    const impl = recorder(reply());
    await assert.rejects(
      fetchMedia('http://evil.example/res/a.png', { baseUrl: BASE, fetchImpl: impl }),
      MediaError,
    );
    assert.equal(impl.calls.length, 0);
  });

  it('refuses a non-2xx answer', async () => {
    const impl = recorder(reply({ status: 404 }));
    await assert.rejects(fetchMedia('/res/a.png', { baseUrl: BASE, fetchImpl: impl }), /HTTP 404/);
  });

  it('refuses a non-media content type, whatever the extension claims', async () => {
    const impl = recorder(reply({ type: 'text/html' }));
    await assert.rejects(fetchMedia('/res/a.png', { baseUrl: BASE, fetchImpl: impl }), /not media/);

    const untyped = recorder(reply({ type: null }));
    await assert.rejects(
      fetchMedia('/res/a.png', { baseUrl: BASE, fetchImpl: untyped }),
      /untyped/,
    );
  });

  it('refuses a declared size over the cap without reading the body', async () => {
    let read = false;
    const response = reply({ length: 10_000 });
    response.arrayBuffer = async () => {
      read = true;
      return new ArrayBuffer(0);
    };
    const impl = recorder(response);

    await assert.rejects(
      fetchMedia('/res/a.png', { baseUrl: BASE, fetchImpl: impl, maxBytes: 1000 }),
      /declares 10000 bytes/,
    );
    assert.equal(read, false);
  });

  it('refuses a body over the cap even when Content-Length lied', async () => {
    const impl = recorder(reply({ length: 4, body: new Uint8Array(2000) }));
    await assert.rejects(
      fetchMedia('/res/a.png', { baseUrl: BASE, fetchImpl: impl, maxBytes: 1000 }),
      /2000 bytes, over the 1000 cap/,
    );
  });
});

describe('createMediaProxy', () => {
  it('fetches once and serves the rest from cache', async () => {
    const impl = recorder(reply({ body: new Uint8Array([9]) }));
    const proxy = createMediaProxy({ fetchImpl: impl });

    const first = await proxy.get('/res/a.png', { baseUrl: BASE });
    const second = await proxy.get(`${BASE}/res/a.png`, { baseUrl: BASE });

    assert.equal(impl.calls.length, 1);
    assert.equal(second.b64, first.b64);
    assert.equal(proxy.stats().entries, 1);
  });

  it('coalesces concurrent callers of the same URL', async () => {
    const impl = recorder(reply());
    const proxy = createMediaProxy({ fetchImpl: impl });

    const both = await Promise.all([
      proxy.get('/res/a.png', { baseUrl: BASE }),
      proxy.get('/res/a.png', { baseUrl: BASE }),
    ]);

    assert.equal(impl.calls.length, 1);
    assert.equal(both[0].b64, both[1].b64);
    assert.equal(proxy.stats().inflight, 0);
  });

  it('rejects a refused URL as a promise, never as a throw', async () => {
    const impl = recorder(reply());
    const proxy = createMediaProxy({ fetchImpl: impl });

    const promise = proxy.get('/api/library', { baseUrl: BASE });
    assert.ok(promise instanceof Promise);
    await assert.rejects(promise, MediaError);
    assert.equal(impl.calls.length, 0);
  });

  it('does not cache a failure', async () => {
    const impl = recorder(reply({ status: 500 }), reply({ body: new Uint8Array([7]) }));
    const proxy = createMediaProxy({ fetchImpl: impl });

    await assert.rejects(proxy.get('/res/a.png', { baseUrl: BASE }), MediaError);
    const value = await proxy.get('/res/a.png', { baseUrl: BASE });

    assert.equal(value.bytes, 1);
    assert.equal(impl.calls.length, 2);
  });

  it('clears', async () => {
    const impl = recorder(reply());
    const proxy = createMediaProxy({ fetchImpl: impl });
    await proxy.get('/res/a.png', { baseUrl: BASE });
    proxy.clear();
    assert.equal(proxy.stats().entries, 0);
  });
});
