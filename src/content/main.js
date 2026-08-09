/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

// Content script entry point.
//
// Detects the word under the pointer, asks the background to look it up, and renders
// the result. It never fetches wudict itself: its requests would carry the host
// page's origin and be subject to that page's CORS, which the server does not
// satisfy.

import { api } from '../common/api.js';
import { BEGIN, CANCEL, END, FAILED, HIT, LOOKUP, PORT_NAME } from '../common/protocol.js';
import { getSettings, onSettingsChanged } from '../common/settings.js';
import { samePosition, wordAtPoint } from './caret.js';
import { candidates } from './words.js';
import { createPopup } from './popup.js';

const HIGHLIGHT_NAME = 'wudict-term';

// Leaving the word must not dismiss instantly: the pointer has to cross a strip of
// ordinary page text to reach the popup, and the modifier is usually released on the
// way. Long enough to travel, short enough not to linger.
const HIDE_DELAY_MS = 400;

const state = {
  settings: null,
  port: null,
  lookupId: 0,
  activeId: null,
  activeGroup: 0,
  lastWord: null,
  matchedTerm: null,
  lastPointer: { x: 0, y: 0 },
  debounceTimer: null,
  hideTimer: null,
  pointerInPopup: false,
  shownDicts: [],
  moreBusy: false,
};

const popup = createPopup({
  onMore: requestMore,
  onEnter: () => {
    state.pointerInPopup = true;
    cancelHide();
  },
  onLeave: () => {
    state.pointerInPopup = false;
    scheduleHide();
  },
  // A content script has no chrome.tabs; the worker opens it, reusing one wudict
  // tab rather than accumulating twenty.
  onOpen: ({ url, reuse }) => {
    api.runtime.sendMessage({ type: 'wudict:open', url, reuse }).catch(() => {});
  },
});

function scheduleHide() {
  clearTimeout(state.hideTimer);
  state.hideTimer = setTimeout(dismiss, HIDE_DELAY_MS);
}

function cancelHide() {
  clearTimeout(state.hideTimer);
}

// ------------------------------------------------------------------- highlight

let highlight = null;

function highlightRange(range) {
  // The Custom Highlight API paints without touching the DOM: no wrapper elements,
  // no reflow, nothing for a framework to fight over.
  if (typeof Highlight === 'undefined' || !CSS.highlights) return;
  if (!highlight) {
    highlight = new Highlight();
    CSS.highlights.set(HIGHLIGHT_NAME, highlight);
    // ::highlight() only resolves against document stylesheets, so this one style
    // rule has to live in the page. It is scoped to our highlight name and cannot
    // affect anything else.
    const style = document.createElement('style');
    style.textContent = `::highlight(${HIGHLIGHT_NAME}) { background: #ffe9a8; color: inherit; }`;
    document.documentElement.appendChild(style);
  }
  highlight.clear();
  highlight.add(range);
}

function clearHighlight() {
  highlight?.clear();
}

// ------------------------------------------------------------------------ port

function connect() {
  if (state.port) return state.port;

  // Chrome tears the worker down when idle, taking the port with it, so this
  // reconnects lazily rather than holding one open from load.
  const port = api.runtime.connect({ name: PORT_NAME });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    state.port = null;
    state.activeId = null;
  });
  state.port = port;
  return port;
}

function send(message) {
  try {
    connect().postMessage(message);
  } catch {
    // The worker was replaced mid-send; the next hover reconnects.
    state.port = null;
  }
}

function onMessage(message) {
  if (message.id !== state.activeId) return; // a superseded lookup

  switch (message.type) {
    case BEGIN:
      state.matchedTerm = message.term;
      if (message.append) {
        // "More dictionaries" adds a group below what is already on screen.
        state.shownDicts.push(...message.slots.map((slot) => slot.dict));
        state.activeGroup = popup.addGroup(message.slots);
      } else {
        state.shownDicts = message.slots.map((slot) => slot.dict);
        state.activeGroup = 0;
        popup.begin({
          term: message.term,
          slots: message.slots,
          base: state.settings.baseUrl,
          anchorAt: state.lastPointer,
          fromCache: message.fromCache,
        });
      }
      break;

    case HIT:
      popup.hit(state.activeGroup, message);
      popup.position();
      break;

    case END:
      if (!message.matched) {
        popup.hide();
        break;
      }
      popup.prune();
      state.moreBusy = false;
      updateMore();
      popup.position();
      break;

    case FAILED:
      state.moreBusy = false;
      // A lookup that never started is not worth a popup on every hover; the
      // background console carries the detail.
      console.debug('[wudict]', message.reason, message.message);
      break;

    default:
      break;
  }
}

// --------------------------------------------------------------------- lookups

function modifierHeld(event) {
  switch (state.settings.modifier) {
    case 'none':
      return true;
    case 'alt':
      return event.altKey;
    case 'ctrl':
      return event.ctrlKey;
    case 'shift':
      return event.shiftKey;
    case 'meta':
      return event.metaKey;
    default:
      return true;
  }
}

function startLookup(word) {
  state.lookupId += 1;
  state.activeId = state.lookupId;
  state.shownDicts = [];

  send({
    type: LOOKUP,
    id: state.activeId,
    candidates: candidates(word.term, state.settings.maxCandidates),
    n: state.settings.resultsPerDict,
    limit: state.settings.dictLimit,
    // Only when the user has chosen explicitly; otherwise the background picks
    // capability-filtered defaults from the registry.
    dicts: state.settings.dicts.length > 0 ? state.settings.dicts : undefined,
  });
}

function cancelLookup() {
  if (state.activeId === null) return;
  send({ type: CANCEL, id: state.activeId });
  state.activeId = null;
}

function requestMore() {
  if (state.moreBusy || !state.settings) return;
  state.moreBusy = true;
  updateMore();
  send({
    type: LOOKUP,
    id: state.activeId,
    candidates: [popupTerm()],
    n: state.settings.resultsPerDict,
    // "More" names the next ids, never the ones already on screen.
    exclude: state.shownDicts,
    limit: state.settings.moreLimit,
    append: true,
  });
}

function popupTerm() {
  // The candidate that actually matched, not the raw hovered text.
  return state.matchedTerm ?? state.lastWord?.term ?? '';
}

function updateMore() {
  if (!popup.isVisible()) return;
  popup.showMore(state.moreBusy ? 'searching…' : 'More dictionaries', !state.moreBusy);
}

function dismiss() {
  cancelHide();
  clearTimeout(state.debounceTimer);
  state.pointerInPopup = false;
  cancelLookup();
  clearHighlight();
  popup.hide();
  state.lastWord = null;
}

// ------------------------------------------------------------------- listeners

function onPointerMove(event) {
  // Moving over the popup must not re-trigger detection or dismiss it.
  if (popup.contains(event.target)) {
    cancelHide();
    return;
  }

  state.lastPointer = { x: event.clientX, y: event.clientY };

  if (!state.settings?.enabled) return;

  if (!modifierHeld(event)) {
    // Released on the way to the popup is the common case, so this is a grace
    // period rather than an immediate dismissal.
    if (popup.isVisible()) scheduleHide();
    return;
  }

  schedule();
}

function schedule() {
  clearTimeout(state.debounceTimer);
  // Hover fires continuously; the debounce and the abort on the next request are
  // what keep this to one request per word.
  state.debounceTimer = setTimeout(evaluate, state.settings.debounceMs);
}

function evaluate() {
  // A debounce timer can still land after the pointer has reached the popup.
  if (state.pointerInPopup) return;

  const { x, y } = state.lastPointer;
  const word = wordAtPoint(x, y);

  if (!word) {
    if (popup.isVisible()) scheduleHide();
    return;
  }

  cancelHide();

  // The single biggest saving: crossing the same word many times costs nothing.
  if (samePosition(state.lastWord, word.node, word.start, word.end)) return;

  state.lastWord = word;
  highlightRange(word.range);
  startLookup(word);
}

function onKeyDown(event) {
  if (event.key === 'Escape' && popup.isVisible()) {
    dismiss();
    return;
  }
  if (!state.settings?.enabled || state.settings.modifier === 'none') return;
  // Holding the modifier while the pointer is already parked must trigger a lookup;
  // without this the feature appears dead until the mouse is jiggled.
  if (modifierHeld(event)) schedule();
}

function onKeyUp() {
  // Reaching the popup requires letting go of the modifier, so releasing it starts
  // the grace period instead of dismissing.
  if (state.settings?.modifier === 'none') return;
  if (state.pointerInPopup) return;
  if (popup.isVisible()) scheduleHide();
}

function onScroll(event) {
  // A capturing listener on window also sees scrolls targeted at descendants, so
  // scrolling the popup itself arrives here — and used to dismiss it.
  if (popup.contains(event.target) || state.pointerInPopup) return;
  if (popup.isVisible()) dismiss();
}

function onMouseDown(event) {
  if (!popup.contains(event.target)) dismiss();
}

// ------------------------------------------------------------------- lifecycle

async function start() {
  state.settings = await getSettings();

  onSettingsChanged(async () => {
    state.settings = await getSettings();
    if (!state.settings.enabled) dismiss();
  });

  document.addEventListener('mousemove', onPointerMove, { passive: true, capture: true });
  document.addEventListener('keydown', onKeyDown, { passive: true, capture: true });
  document.addEventListener('keyup', onKeyUp, { passive: true, capture: true });
  document.addEventListener('mousedown', onMouseDown, { passive: true, capture: true });
  window.addEventListener('scroll', onScroll, { passive: true, capture: true });
  window.addEventListener('blur', dismiss);
}

start();
