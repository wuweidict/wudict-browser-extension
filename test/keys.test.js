/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { detectOs, foreignNote, keyChoices, keyName, normalizeOs, OS } from '../src/common/keys.js';

const values = (os, current) => keyChoices(os, current).map((choice) => choice.value);

describe('normalizeOs', () => {
  it('maps what getPlatformInfo actually returns', () => {
    assert.equal(normalizeOs('mac'), OS.MAC);
    assert.equal(normalizeOs('win'), OS.WIN);
    assert.equal(normalizeOs('linux'), OS.LINUX);
  });

  it('maps the navigator spellings too', () => {
    assert.equal(normalizeOs('MacIntel'), OS.MAC);
    assert.equal(normalizeOs('macOS'), OS.MAC);
    assert.equal(normalizeOs('Win32'), OS.WIN);
    assert.equal(normalizeOs('Windows'), OS.WIN);
  });

  it('keys everything else like Linux rather than throwing', () => {
    assert.equal(normalizeOs('cros'), OS.LINUX);
    assert.equal(normalizeOs('openbsd'), OS.LINUX);
    assert.equal(normalizeOs(undefined), OS.LINUX);
    assert.equal(normalizeOs(''), OS.LINUX);
  });
});

describe('detectOs', () => {
  it('prefers the browser over the user agent', async () => {
    const api = { runtime: { getPlatformInfo: async () => ({ os: 'win' }) } };
    assert.equal(await detectOs(api, { platform: 'MacIntel' }), OS.WIN);
  });

  it('falls back to the navigator when the API is absent', async () => {
    assert.equal(await detectOs({}, { platform: 'MacIntel' }), OS.MAC);
    assert.equal(await detectOs(undefined, { userAgentData: { platform: 'Windows' } }), OS.WIN);
  });

  it('survives an API that throws', async () => {
    const api = {
      runtime: {
        getPlatformInfo: async () => {
          throw new Error('not available');
        },
      },
    };
    assert.equal(await detectOs(api, { platform: 'MacIntel' }), OS.MAC);
  });
});

describe('keyName', () => {
  it('uses each platform’s own name for the same DOM flag', () => {
    assert.equal(keyName(OS.MAC, 'alt'), 'Option');
    assert.equal(keyName(OS.WIN, 'alt'), 'Alt');
    assert.equal(keyName(OS.MAC, 'meta'), 'Command');
    assert.equal(keyName(OS.WIN, 'meta'), 'Windows key');
    assert.equal(keyName(OS.LINUX, 'meta'), 'Super');
  });
});

describe('keyChoices', () => {
  it('offers Command on macOS', () => {
    assert.deepEqual(values(OS.MAC, 'alt'), ['none', 'alt', 'ctrl', 'shift', 'meta']);
  });

  it('does not offer the Windows or Super key — the OS takes it first', () => {
    assert.deepEqual(values(OS.WIN, 'alt'), ['none', 'alt', 'ctrl', 'shift']);
    assert.deepEqual(values(OS.LINUX, 'alt'), ['none', 'alt', 'ctrl', 'shift']);
  });

  it('still shows a meta value synced in from a Mac, flagged', () => {
    const choices = keyChoices(OS.WIN, 'meta');
    assert.deepEqual(
      choices.map((choice) => choice.value),
      ['none', 'alt', 'ctrl', 'shift', 'meta'],
    );
    const meta = choices.at(-1);
    assert.equal(meta.foreign, true);
    assert.equal(meta.name, 'Windows key');
    // Abbreviated in the segmented control, spelled out everywhere with room.
    assert.equal(meta.short, 'Win');
    assert.equal(meta.long, 'Windows key');
    assert.equal(keyChoices(OS.LINUX, 'meta').at(-1).short, 'Super');
    // Every offered choice is native by definition.
    assert.equal(
      choices.slice(0, -1).every((choice) => choice.foreign === false),
      true,
    );
  });

  it('uses symbols only where the platform established them', () => {
    const mac = keyChoices(OS.MAC, 'alt');
    assert.deepEqual(
      mac.map((choice) => choice.short),
      ['None', '⌥', '⌃', '⇧', '⌘'],
    );
    assert.equal(mac[1].long, '⌥ Option');

    const win = keyChoices(OS.WIN, 'alt');
    assert.deepEqual(
      win.map((choice) => choice.short),
      ['None', 'Alt', 'Ctrl', 'Shift'],
    );
    assert.equal(win[1].long, 'Alt');
  });

  it('keeps the accessible name full even when the label is a glyph', () => {
    for (const choice of keyChoices(OS.MAC, 'alt')) {
      assert.ok(choice.name.length > 1, `${choice.value} has no readable name`);
    }
  });
});

describe('foreignNote', () => {
  it('explains a Mac-set modifier on each platform that cannot honour it', () => {
    assert.match(foreignNote(OS.WIN, 'meta'), /Windows key/);
    assert.match(foreignNote(OS.LINUX, 'meta'), /Super/);
  });

  it('says nothing when there is nothing to explain', () => {
    assert.equal(foreignNote(OS.MAC, 'meta'), null);
    assert.equal(foreignNote(OS.WIN, 'alt'), null);
  });
});
