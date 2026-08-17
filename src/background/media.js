/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

// The media proxy: article images and pronunciation audio are fetched *here* and
// handed to the content script as bytes.
//
// Why not simply put the `/res/` URL in the popup's DOM, which is what the first
// release did: a subresource in the page's DOM is the *page's* request, and the page
// is a public origin reaching loopback. Chrome/Edge 142+ and Firefox 151+ gate that
// behind the Local Network Access prompt — "www.google.com is asking you to access
// other apps and services on this device" — which names the site the user is reading
// and makes a dictionary look like a network scanner. The background is an extension
// origin and is exempt, so the request moves here and the page only ever sees a blob
// URL of bytes it was handed. See D69 in the wudict repo.
//
// Everything here is adversarial about its input: the URL comes from dictionary HTML
// written by a third party, so it is checked against the configured server *origin*
// and the `/res/` prefix before a request is made, the Content-Type must be media,
// and the body is capped. A dictionary cannot use this to reach the private half of
// the API, nor to beacon a word list to someone else's host.

import { createCache } from './cache.js';
import { createInflight } from './inflight.js';

/** Rejected before or during a fetch. Its message is shown in the console only. */
export class MediaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MediaError';
  }
}

// A dictionary image is a few KB and a pronunciation a few dozen; 4 MiB is far above
// anything real and far below what would be uncomfortable to base64 and post.
export const MAX_MEDIA_BYTES = 4 * 1024 * 1024;

// btoa wants one string, but building it with `String.fromCharCode(...bytes)` blows
// the argument limit somewhere around 100 KB — silently on some engines, as a
// RangeError on others. 8 KiB per apply is safely under every limit.
const CHUNK = 8 * 1024;

/**
 * Decide what a media URL is allowed to become, or throw.
 *
 * The origin check is the security boundary; the `/res/` prefix is the API boundary
 * (a dictionary must not be able to drive `/api/library` through us). The prefix is
 * derived from the base URL so a wudict mounted under a path still works.
 */
export function mediaUrl(raw, baseUrl) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new MediaError(`the wudict address is not a URL: ${baseUrl}`);
  }

  let url;
  try {
    url = new URL(String(raw ?? ''), base);
  } catch {
    throw new MediaError(`not a URL: ${raw}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new MediaError(`refusing ${url.protocol} media`);
  }
  if (url.origin !== base.origin) {
    throw new MediaError(`refusing media from ${url.origin}`);
  }

  const prefix = `${base.pathname.replace(/\/+$/, '')}/res/`;
  if (!url.pathname.startsWith(prefix)) {
    throw new MediaError(`only ${prefix} media is proxied, not ${url.pathname}`);
  }
  return url.href;
}

/** Images and audio only: this is a dictionary, not a fetch service. */
export function isMediaType(contentType) {
  const type = String(contentType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return type.startsWith('image/') || type.startsWith('audio/');
}

export function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Fetch one media resource. `url` is validated here too, not only by the caller —
 * this is exported and must not depend on being called correctly.
 */
export async function fetchMedia(
  url,
  { baseUrl, fetchImpl = globalThis.fetch, maxBytes = MAX_MEDIA_BYTES } = {},
) {
  const target = mediaUrl(url, baseUrl);

  const response = await fetchImpl(target, {
    // No credentials, ever: the server has no cookies and must not start seeing any.
    credentials: 'omit',
    headers: { accept: 'image/*,audio/*' },
  });
  if (!response.ok) {
    throw new MediaError(`${target} answered HTTP ${response.status}`);
  }

  const mime = String(response.headers.get('content-type') ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!isMediaType(mime)) {
    // Never sniff the extension: /res/ serves .spx transcoded as audio/wav, so the
    // URL lies and the Content-Type does not.
    throw new MediaError(`${target} is ${mime || 'untyped'}, not media`);
  }

  // Cheap refusal when the server declares the size; the real check is on the body,
  // because Content-Length is advisory and absent on a chunked response.
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new MediaError(`${target} declares ${declared} bytes, over the ${maxBytes} cap`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > maxBytes) {
    throw new MediaError(`${target} is ${bytes.length} bytes, over the ${maxBytes} cap`);
  }

  return { mime, b64: toBase64(bytes), bytes: bytes.length };
}

// Base64 is 4/3 of the bytes and the string is what actually occupies memory, so it
// is what the bound is measured in.
const sizeOfMedia = (value) => 96 + value.b64.length + value.mime.length;

/**
 * The shared, deduplicated, bounded front door. One speaker icon clicked twice, or
 * one image visible in two frames, costs one request.
 */
export function createMediaProxy({ cache, inflight, ...options } = {}) {
  const entries =
    cache ?? createCache({ maxEntries: 64, maxBytes: 16 * 1024 * 1024, sizeOf: sizeOfMedia });
  const pending = inflight ?? createInflight();

  return {
    /** Resolves `{ mime, b64, bytes }`, or rejects with a MediaError. */
    get(url, { baseUrl }) {
      let target;
      try {
        target = mediaUrl(url, baseUrl);
      } catch (error) {
        return Promise.reject(error);
      }

      const cached = entries.get(target);
      if (cached) return Promise.resolve(cached);

      return pending.run(target, async () => {
        const value = await fetchMedia(target, { baseUrl, ...options });
        entries.set(target, value);
        return value;
      });
    },
    stats: () => ({ ...entries.stats(), inflight: pending.size() }),
    clear: () => entries.clear(),
  };
}
