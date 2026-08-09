/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULTS, normalizeBaseUrl, normalizeSettings } from '../src/common/settings.js';

describe('normalizeBaseUrl', () => {
  it('strips a trailing slash', () => {
    assert.equal(normalizeBaseUrl('http://127.0.0.1:6888/'), 'http://127.0.0.1:6888');
    assert.equal(normalizeBaseUrl('http://127.0.0.1:6888///'), 'http://127.0.0.1:6888');
  });

  it('keeps a path prefix, for a server behind one', () => {
    assert.equal(normalizeBaseUrl('http://host:8080/wudict/'), 'http://host:8080/wudict');
    // A default port is normalised away by URL itself.
    assert.equal(normalizeBaseUrl('http://host:80/wudict/'), 'http://host/wudict');
  });

  it('accepts a non-loopback host and https', () => {
    assert.equal(normalizeBaseUrl('https://dict.example:8443'), 'https://dict.example:8443');
  });

  it('rejects a non-http scheme', () => {
    assert.throws(() => normalizeBaseUrl('ftp://host'), /must be http or https/);
    assert.throws(() => normalizeBaseUrl('javascript:alert(1)'), /must be http or https/);
  });

  it('rejects a query string or fragment', () => {
    assert.throws(() => normalizeBaseUrl('http://host?a=1'), /query string or fragment/);
    assert.throws(() => normalizeBaseUrl('http://host#x'), /query string or fragment/);
  });

  it('rejects nonsense', () => {
    assert.throws(() => normalizeBaseUrl('not a url'));
  });
});

describe('normalizeSettings', () => {
  it('fills in every default', () => {
    assert.deepEqual(normalizeSettings({}), DEFAULTS);
  });

  it('falls back to the default base URL rather than breaking every lookup', () => {
    assert.equal(normalizeSettings({ baseUrl: 'garbage' }).baseUrl, DEFAULTS.baseUrl);
  });

  it('rejects an unknown modifier', () => {
    assert.equal(normalizeSettings({ modifier: 'hyper' }).modifier, DEFAULTS.modifier);
    assert.equal(normalizeSettings({ modifier: 'none' }).modifier, 'none');
  });

  it('clamps numbers into range', () => {
    assert.equal(normalizeSettings({ debounceMs: -50 }).debounceMs, 0);
    assert.equal(normalizeSettings({ debounceMs: 99999 }).debounceMs, 2000);
    // The server opens at most 8 dictionaries concurrently.
    assert.equal(normalizeSettings({ dictLimit: 40 }).dictLimit, 8);
    assert.equal(normalizeSettings({ moreLimit: 40 }).moreLimit, 8);
    assert.equal(normalizeSettings({ resultsPerDict: 0 }).resultsPerDict, 1);
  });

  it('coerces and rounds numeric strings from form inputs', () => {
    assert.equal(normalizeSettings({ debounceMs: '250' }).debounceMs, 250);
    assert.equal(normalizeSettings({ resultsPerDict: 2.6 }).resultsPerDict, 3);
  });

  it('falls back when a number is not a number', () => {
    assert.equal(normalizeSettings({ debounceMs: 'soon' }).debounceMs, DEFAULTS.debounceMs);
    assert.equal(normalizeSettings({ debounceMs: NaN }).debounceMs, DEFAULTS.debounceMs);
  });

  it('discards junk in the dictionary list', () => {
    assert.deepEqual(normalizeSettings({ dicts: ['a', '', 3, null, 'b'] }).dicts, ['a', 'b']);
    assert.deepEqual(normalizeSettings({ dicts: 'nope' }).dicts, []);
  });

  it('treats enabled as opt-out', () => {
    assert.equal(normalizeSettings({ enabled: undefined }).enabled, true);
    assert.equal(normalizeSettings({ enabled: false }).enabled, false);
  });
});
