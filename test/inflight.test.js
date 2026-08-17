/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createInflight } from '../src/background/inflight.js';

/** A promise whose settlement this test controls. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createInflight', () => {
  it('runs the factory once for concurrent callers of one key', async () => {
    const inflight = createInflight();
    const gate = deferred();
    let calls = 0;

    const factory = () => {
      calls += 1;
      return gate.promise;
    };

    const first = inflight.run('k', factory);
    const second = inflight.run('k', factory);
    assert.equal(calls, 1);
    assert.equal(inflight.size(), 1);
    assert.ok(inflight.has('k'));

    gate.resolve('value');
    assert.deepEqual(await Promise.all([first, second]), ['value', 'value']);
  });

  it('keeps different keys apart', async () => {
    const inflight = createInflight();
    const a = inflight.run('a', async () => 'A');
    const b = inflight.run('b', async () => 'B');
    assert.equal(inflight.size(), 2);
    assert.deepEqual(await Promise.all([a, b]), ['A', 'B']);
  });

  it('drops the entry once it settles, so the next caller runs again', async () => {
    const inflight = createInflight();
    let calls = 0;

    await inflight.run('k', async () => {
      calls += 1;
      return calls;
    });
    assert.equal(inflight.size(), 0);
    assert.equal(inflight.has('k'), false);

    assert.equal(await inflight.run('k', async () => ++calls), 2);
  });

  it('never replays a rejection to a later caller', async () => {
    const inflight = createInflight();
    await assert.rejects(
      inflight.run('k', async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(inflight.size(), 0);
    assert.equal(await inflight.run('k', async () => 'ok'), 'ok');
  });

  it('turns a synchronous throw into a rejection and registers nothing', async () => {
    const inflight = createInflight();
    await assert.rejects(
      inflight.run('k', () => {
        throw new Error('sync');
      }),
      /sync/,
    );
    assert.equal(inflight.size(), 0);
  });

  it('joins an existing run and returns null when there is none', async () => {
    const inflight = createInflight();
    const gate = deferred();
    const leader = inflight.run('k', () => gate.promise);

    assert.equal(inflight.join('k'), leader);
    assert.equal(inflight.join('other'), null);

    gate.resolve(1);
    await leader;
    assert.equal(inflight.join('k'), null);
  });

  it('does not delete a newer generation when an older promise settles', async () => {
    const inflight = createInflight();
    const first = deferred();
    const stale = inflight.run('k', () => first.promise);

    first.resolve('first');
    await stale;

    const second = deferred();
    const fresh = inflight.run('k', () => second.promise);
    // The first release already ran; the entry now belongs to `fresh` and must
    // survive until `fresh` itself settles.
    assert.equal(inflight.join('k'), fresh);

    second.resolve('second');
    assert.equal(await fresh, 'second');
    assert.equal(inflight.size(), 0);
  });
});
