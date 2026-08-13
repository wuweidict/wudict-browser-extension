/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

// What to call the modifier keys, per platform.
//
// The DOM gives us four booleans with fixed names — altKey, ctrlKey, shiftKey,
// metaKey — and every one of them is a different physical key with a different
// printed name depending on the machine. `altKey` is Option on a Mac; `metaKey` is
// Command there, the Windows key on Windows and Super on Linux. Labelling all of
// them from one hardcoded list means being wrong on two platforms out of three.
//
// This is presentation only. The stored value never changes with the platform: a
// settings object syncs between a Mac and a PC, and rewriting it on arrival would
// mean whichever machine was opened last silently reconfigured the other.
//
// META IS NOT OFFERED OFF MACOS. Holding the Windows key opens the Start menu, and
// most Linux window managers reserve Super for the desktop — the OS takes the event
// before the page ever sees it. Offering a modifier the system will steal is worse
// than offering three, so it is left out of the list rather than labelled. A `meta`
// value that arrived from a Mac over storage.sync is still *shown* (see
// `keyChoices`), because hiding a setting the user can see the effects of is how a
// feature becomes haunted.

/** Canonical per-platform names. Symbols only where the platform established one. */
const LABELS = {
  mac: {
    alt: { symbol: '⌥', name: 'Option' },
    ctrl: { symbol: '⌃', name: 'Control' },
    shift: { symbol: '⇧', name: 'Shift' },
    meta: { symbol: '⌘', name: 'Command' },
  },
  win: {
    alt: { name: 'Alt' },
    ctrl: { name: 'Ctrl' },
    shift: { name: 'Shift' },
    // Never offered; named only so a value synced from a Mac can be described.
    // `short` because the full name is two words and the segmented control is one
    // row: without it the button wraps and squeezes the label out of the panel.
    meta: { short: 'Win', name: 'Windows key' },
  },
  linux: {
    alt: { name: 'Alt' },
    ctrl: { name: 'Ctrl' },
    shift: { name: 'Shift' },
    meta: { name: 'Super' },
  },
};

/** The keys the OS will actually deliver to a web page, in the order shown. */
const OFFERED = {
  mac: ['none', 'alt', 'ctrl', 'shift', 'meta'],
  win: ['none', 'alt', 'ctrl', 'shift'],
  linux: ['none', 'alt', 'ctrl', 'shift'],
};

export const OS = { MAC: 'mac', WIN: 'win', LINUX: 'linux' };

/**
 * Normalise what `runtime.getPlatformInfo()` reports.
 *
 * Chrome answers with mac/win/linux/cros/android/openbsd/fuchsia; everything that
 * is not Mac or Windows keys like Linux, which is the correct default for an
 * unknown unix and harmless for the rest.
 */
export function normalizeOs(value) {
  const os = String(value ?? '').toLowerCase();
  // `mac`, `macOS`, and `MacIntel` — the last is what navigator.platform says, and
  // matching it exactly is how this went wrong the first time.
  if (os.startsWith('mac') || os.includes('darwin')) return OS.MAC;
  if (os.startsWith('win')) return OS.WIN;
  return OS.LINUX;
}

/**
 * Ask the browser, and fall back to the user agent.
 *
 * `getPlatformInfo` is the only answer that is not a guess, but it is async and
 * absent from a content script in Firefox, so the navigator path stays as a
 * fallback. `navigator.platform` is deprecated and still the most reliable of the
 * three UA signals for this one question.
 */
export async function detectOs(api, navigatorRef) {
  try {
    const info = await api?.runtime?.getPlatformInfo?.();
    if (info?.os) return normalizeOs(info.os);
  } catch {
    // Not available in this context; fall through.
  }
  const nav = navigatorRef ?? (typeof navigator === 'undefined' ? null : navigator);
  return normalizeOs(nav?.userAgentData?.platform ?? nav?.platform ?? '');
}

/** The full name for one modifier, e.g. `Option` — never a bare symbol. */
export function keyName(os, modifier) {
  if (modifier === 'none') return 'No key';
  return LABELS[normalizeOs(os)]?.[modifier]?.name ?? modifier;
}

/**
 * The choices to render, in order.
 *
 * `current` is included even when the platform does not offer it, flagged as
 * `foreign` so the caller can explain why a Mac's ⌘ is showing up on a PC. Callers
 * must not filter it back out: it is the value in effect.
 */
export function keyChoices(os, current) {
  const platform = normalizeOs(os);
  const offered = OFFERED[platform];
  const values = offered.includes(current) || !current ? offered : [...offered, current];

  return values.map((value) => {
    const label = LABELS[platform]?.[value];
    const foreign = !offered.includes(value);
    return {
      value,
      foreign,
      // The full name is what a tooltip and a screen reader get.
      name: keyName(platform, value),
      // Mac users read ⌥⌃⇧⌘ faster than the words, and the panel is 340px wide.
      // No other platform has a glyph convention worth inventing one for, so
      // elsewhere this is the name — abbreviated only where the name does not fit.
      short:
        value === 'none' ? 'None' : (label?.symbol ?? label?.short ?? label?.name ?? value),
      long: value === 'none' ? 'No key — hover alone' : compose(label, value),
    };
  });
}

function compose(label, value) {
  if (!label) return value;
  return label.symbol ? `${label.symbol} ${label.name}` : label.name;
}

/** Why a modifier is shown but not offered. Null when there is nothing to explain. */
export function foreignNote(os, modifier) {
  if (normalizeOs(os) === OS.MAC || modifier !== 'meta') return null;
  return normalizeOs(os) === OS.WIN
    ? 'Set on a Mac. The Windows key is taken by the system before a page sees it — pick another.'
    : 'Set on a Mac. Super is usually taken by the window manager — pick another.';
}
