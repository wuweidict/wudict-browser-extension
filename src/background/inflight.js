/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

// One request per key, however many callers ask for it.
//
// The content script runs in every frame (`all_frames: true`), so a word hovered on
// a page with iframes, or the same pronunciation icon in two visible articles, asks
// for the identical bytes at the same instant. Without coalescing that is N fetches
// and N cache writes racing each other; with it the followers await the leader's
// promise and the server sees one request.
//
// Deliberately not a cache: the entry is dropped as soon as the promise settles, so
// a rejection is never replayed to a caller that arrived later. Caching successes is
// the caller's job (see media.js), because only the caller knows what is worth
// keeping and for how long.

export function createInflight() {
  const pending = new Map();

  return {
    /**
     * Run `factory()` under `key`, or join the run already under it.
     *
     * `factory` is invoked at most once per settled generation. A synchronous throw
     * inside it becomes a rejected promise like any other, so a caller only ever has
     * one failure shape to handle.
     */
    run(key, factory) {
      const existing = pending.get(key);
      if (existing) return existing;

      let promise;
      try {
        promise = Promise.resolve(factory());
      } catch (error) {
        return Promise.reject(error);
      }

      pending.set(key, promise);
      const release = () => {
        // Guard the identity: a later generation may already own this key.
        if (pending.get(key) === promise) pending.delete(key);
      };
      promise.then(release, release);
      return promise;
    },

    /**
     * The run already under `key`, or null. For a caller that can *use* another
     * caller's result but cannot produce it the same way — it waits, then reads
     * whatever the leader left behind.
     */
    join: (key) => pending.get(key) ?? null,

    has: (key) => pending.has(key),
    size: () => pending.size,
  };
}
