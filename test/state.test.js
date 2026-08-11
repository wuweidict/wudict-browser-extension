/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { activeOn, HEALTH, hostOf, ICON, siteEnabled, toolbarState } from '../src/common/state.js';
import {
  DEFAULTS,
  MAX_SITE_RULES,
  normalizeSettings,
  withSiteRule,
} from '../src/common/settings.js';

const base = (patch) => normalizeSettings({ ...DEFAULTS, ...patch });

describe('hostOf', () => {
  it('returns the bare hostname', () => {
    assert.equal(hostOf('https://example.com/a/b?c#d'), 'example.com');
    assert.equal(hostOf('http://sub.example.com:8080/'), 'sub.example.com');
  });

  it('rejects everything a content script cannot run on', () => {
    assert.equal(hostOf('about:blank'), null);
    assert.equal(hostOf('chrome://extensions'), null);
    assert.equal(hostOf('file:///tmp/x.html'), null);
    assert.equal(hostOf(''), null);
    assert.equal(hostOf(undefined), null);
  });
});

describe('siteEnabled', () => {
  it('treats an absent rule as allowed', () => {
    assert.equal(siteEnabled(base(), 'example.com'), true);
    assert.equal(siteEnabled(base({ siteRules: { 'other.com': false } }), 'example.com'), true);
  });

  it('honours an opt-out', () => {
    assert.equal(siteEnabled(base({ siteRules: { 'example.com': false } }), 'example.com'), false);
  });

  it('allows a page with no host, which has no rule to apply', () => {
    assert.equal(siteEnabled(base({ siteRules: { 'example.com': false } }), null), true);
  });

  it('does not match subdomains — the rule is exactly the host stored', () => {
    const settings = base({ siteRules: { 'example.com': false } });
    assert.equal(siteEnabled(settings, 'www.example.com'), true);
  });
});

describe('activeOn', () => {
  it('needs both switches', () => {
    assert.equal(activeOn(base(), 'example.com'), true);
    assert.equal(activeOn(base({ enabled: false }), 'example.com'), false);
    assert.equal(activeOn(base({ siteRules: { 'example.com': false } }), 'example.com'), false);
  });
});

describe('withSiteRule', () => {
  it('stores only opt-outs', () => {
    const patch = withSiteRule(base(), 'example.com', false);
    assert.deepEqual(patch.siteRules, { 'example.com': false });
  });

  it('removes the entry when resuming rather than storing true', () => {
    const settings = base({ siteRules: { 'example.com': false, 'other.com': false } });
    const patch = withSiteRule(settings, 'example.com', true);
    assert.deepEqual(patch.siteRules, { 'other.com': false });
  });

  it('caps the list so storage.sync item limits cannot be blown', () => {
    const many = {};
    for (let i = 0; i < MAX_SITE_RULES + 50; i += 1) many[`host${i}.example`] = false;
    const settings = normalizeSettings({ siteRules: many });
    assert.equal(Object.keys(settings.siteRules).length, MAX_SITE_RULES);
  });
});

describe('normalizeSettings — new fields', () => {
  it('defaults an unknown search target to the full page', () => {
    assert.equal(normalizeSettings({ searchTarget: 'sidebar' }).searchTarget, 'page');
    assert.equal(normalizeSettings({}).searchTarget, 'page');
    assert.equal(normalizeSettings({ searchTarget: 'popup' }).searchTarget, 'popup');
  });

  it('keeps the context menu on unless explicitly disabled', () => {
    assert.equal(normalizeSettings({}).contextMenu, true);
    assert.equal(normalizeSettings({ contextMenu: false }).contextMenu, false);
    assert.equal(normalizeSettings({ contextMenu: 'no' }).contextMenu, true);
  });

  it('discards junk in siteRules rather than trusting storage', () => {
    assert.deepEqual(normalizeSettings({ siteRules: null }).siteRules, {});
    assert.deepEqual(normalizeSettings({ siteRules: ['a'] }).siteRules, {});
    assert.deepEqual(
      normalizeSettings({ siteRules: { a: false, b: true, '': false } }).siteRules,
      { a: false },
    );
  });
});

describe('toolbarState', () => {
  const view = (settings, host, health) =>
    toolbarState({ settings, host, health, baseUrl: 'http://127.0.0.1:6888' });

  it('is on and unbadged when everything is fine', () => {
    const result = view(base(), 'example.com', HEALTH.OK);
    assert.equal(result.icon, ICON.ON);
    assert.equal(result.badge, '');
    assert.match(result.title, /Connected/);
  });

  it('badges a reachable-server failure only while it would matter', () => {
    assert.equal(view(base(), 'example.com', HEALTH.DOWN).badge, '!');
    // Paused: the user has already opted out, so the server is not their problem.
    assert.equal(view(base({ enabled: false }), 'example.com', HEALTH.DOWN).badge, '');
    assert.equal(
      view(base({ siteRules: { 'example.com': false } }), 'example.com', HEALTH.DOWN).badge,
      '',
    );
  });

  it('greys the icon for either switch', () => {
    assert.equal(view(base({ enabled: false }), 'example.com', HEALTH.OK).icon, ICON.OFF);
    assert.equal(
      view(base({ siteRules: { 'example.com': false } }), 'example.com', HEALTH.OK).icon,
      ICON.OFF,
    );
  });

  it('names the paused host, so the tooltip is not ambiguous', () => {
    const result = view(base({ siteRules: { 'example.com': false } }), 'example.com', HEALTH.OK);
    assert.match(result.title, /Paused on example\.com/);
  });

  it('says a page is out of scope without calling it an error', () => {
    const result = view(base(), null, HEALTH.OK);
    assert.match(result.title, /cannot be read/);
    assert.equal(result.badge, '');
    assert.equal(result.icon, ICON.ON);
  });

  it('reports an unknown server as neither connected nor down', () => {
    const result = view(base(), 'example.com', HEALTH.UNKNOWN);
    assert.equal(result.badge, '');
    assert.doesNotMatch(result.title, /Connected|Cannot reach/);
  });
});
