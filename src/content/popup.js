// The popup: a closed shadow root on a single element, isolated from the host page.
//
// Isolation has three layers. `format=clean` removes scripts and styles at the
// source; the shadow root stops host page CSS reaching in and host page scripts
// reaching the tree (it is *closed*, so `element.shadowRoot` is null); `all: initial`
// on the host stops inherited page styles reaching the host element itself.
//
// The @font-face trap the contract warns about cannot arise here: `clean` strips
// dictionary styles, so there are no faces to hoist, and the popup's own stack is
// system fonts only.

import { OUTCOME } from '../common/protocol.js';
import { sanitizeArticle } from './sanitize.js';

const HOST_ID = 'wudict-hover-host';
const MARGIN = 12;

// Styles must be a string: a shadow root cannot use a manifest-injected stylesheet,
// and fetching one would need web_accessible_resources plus an async hop before the
// first paint.
const STYLES = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .panel {
    font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #1a1a1a;
    background: #fffef9;
    border: 1px solid rgba(0, 0, 0, 0.18);
    border-radius: 6px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
    max-width: 480px;
    max-height: 60vh;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0;
  }
  .term {
    position: sticky; top: 0;
    background: #f2efe4;
    border-bottom: 1px solid rgba(0, 0, 0, 0.12);
    padding: 6px 10px;
    font-weight: 600;
    display: flex; justify-content: space-between; gap: 10px; align-items: baseline;
  }
  .term .meta { font-weight: 400; opacity: 0.6; font-size: 11px; }
  .slot { border-top: 1px solid rgba(0, 0, 0, 0.07); }
  .slot:first-of-type { border-top: 0; }
  .dict {
    padding: 4px 10px 2px;
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
    opacity: 0.55;
  }
  .body { padding: 2px 10px 8px; }
  .body img { max-width: 100%; height: auto; }
  .body audio { max-width: 100%; height: 28px; }
  .body table { border-collapse: collapse; max-width: 100%; }
  .body td, .body th { border: 1px solid rgba(0,0,0,0.12); padding: 2px 5px; }
  .body a { color: #0b5cad; }
  .note { padding: 2px 10px 8px; opacity: 0.5; font-style: italic; }
  .note.error { color: #a12; opacity: 0.85; font-style: normal; }
  .pending { padding: 2px 10px 8px; opacity: 0.4; }
  .more {
    display: block; width: 100%;
    padding: 7px 10px; border: 0; border-top: 1px solid rgba(0, 0, 0, 0.12);
    background: #f7f4ea; color: #0b5cad;
    font: inherit; text-align: center; cursor: pointer;
  }
  .more:hover { background: #efe9d8; }
  .more[disabled] { color: #888; cursor: default; }
  @media (prefers-color-scheme: dark) {
    .panel { color: #e8e6e0; background: #23231f; border-color: rgba(255,255,255,0.16); }
    .term { background: #2d2d27; border-bottom-color: rgba(255,255,255,0.12); }
    .slot { border-top-color: rgba(255,255,255,0.09); }
    .body a { color: #7ab8ff; }
    .body td, .body th { border-color: rgba(255,255,255,0.14); }
    .more { background: #2a2a24; border-top-color: rgba(255,255,255,0.12); color: #7ab8ff; }
    .more:hover { background: #33332b; }
  }
`;

export function createPopup({ onMore, onEnter, onLeave }) {
  let host = null;
  let shadow = null;
  let panel = null;
  let groups = [];
  let anchor = { x: 0, y: 0 };
  let serverOrigin = '';

  function mount() {
    if (host) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText =
      'all: initial; position: fixed; top: 0; left: 0; z-index: 2147483647; display: none;';
    // Closed: the host page cannot reach into the tree via element.shadowRoot.
    shadow = host.attachShadow({ mode: 'closed' });

    const sheet = document.createElement('style');
    sheet.textContent = STYLES;
    shadow.appendChild(sheet);

    panel = document.createElement('div');
    panel.className = 'panel';
    shadow.appendChild(panel);

    // Entering the popup must keep it alive regardless of what the document-level
    // mousemove handler makes of the pointer's position.
    host.addEventListener('mouseenter', () => onEnter?.());
    host.addEventListener('mouseleave', () => onLeave?.());

    document.documentElement.appendChild(host);
  }

  function isOwnElement(target) {
    return target === host;
  }

  function begin({ term, slots, origin, anchorAt, fromCache }) {
    mount();
    serverOrigin = origin;
    anchor = anchorAt ?? anchor;
    groups = [];
    panel.replaceChildren();

    const header = document.createElement('div');
    header.className = 'term';
    header.append(text('span', term));
    if (fromCache) header.append(text('span', 'cached', 'meta'));
    panel.appendChild(header);

    addGroup(slots);
    show();
  }

  /** A group is one request's worth of slots; "more" appends another. */
  function addGroup(slots) {
    const group = { slots, elements: new Map() };
    for (let i = 0; i < slots.length; i += 1) {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.append(text('div', slots[i].name, 'dict'));
      slot.append(text('div', 'searching…', 'pending'));
      panel.appendChild(slot);
      group.elements.set(i, slot);
    }
    groups.push(group);
    return groups.length - 1;
  }

  function hit(groupIndex, { i, name, outcome, results, error }) {
    const group = groups[groupIndex];
    const slot = group?.elements.get(i);
    if (!slot) return;

    slot.replaceChildren();
    slot.append(text('div', name || group.slots[i]?.name || '', 'dict'));

    if (outcome === OUTCOME.RESULTS) {
      for (const result of results) {
        const body = document.createElement('div');
        body.className = 'body';
        body.appendChild(sanitizeArticle(result.Body, serverOrigin));
        slot.appendChild(body);
      }
      return;
    }

    if (outcome === OUTCOME.ERROR) {
      // One dictionary failing leaves the others unaffected.
      slot.append(text('div', error ?? 'lookup failed', 'note error'));
      return;
    }
    if (outcome === OUTCOME.SKIPPED) {
      // Expected whenever a mixed set is queried with a mode it cannot answer.
      slot.append(text('div', 'does not support this search mode', 'note'));
      return;
    }
    slot.append(text('div', 'no entry', 'note'));
  }

  /** Drop slots that never produced anything worth showing. */
  function prune() {
    for (const group of groups) {
      for (const [i, slot] of group.elements) {
        if (slot.querySelector('.body')) continue;
        slot.remove();
        group.elements.delete(i);
      }
    }
    if (!panel.querySelector('.body')) hide();
  }

  function showMore(label, enabled) {
    let button = panel.querySelector('.more');
    if (!button) {
      button = document.createElement('button');
      button.className = 'more';
      button.addEventListener('click', () => onMore?.());
      panel.appendChild(button);
    } else {
      panel.appendChild(button); // keep it last
    }
    button.textContent = label;
    button.disabled = !enabled;
  }

  function show() {
    host.style.display = 'block';
    position();
  }

  function position() {
    // Measure first, then flip so the panel stays on screen near the cursor.
    const rect = panel.getBoundingClientRect();
    const width = rect.width || 320;
    const height = rect.height || 120;

    let left = anchor.x + MARGIN;
    let top = anchor.y + MARGIN;
    if (left + width > window.innerWidth - MARGIN)
      left = Math.max(MARGIN, anchor.x - width - MARGIN);
    if (top + height > window.innerHeight - MARGIN)
      top = Math.max(MARGIN, anchor.y - height - MARGIN);

    host.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  function hide() {
    if (host) host.style.display = 'none';
  }

  function isVisible() {
    return Boolean(host) && host.style.display !== 'none';
  }

  function contains(target) {
    // The panel lives in a closed root, so composedPath is the only way the outside
    // sees it; the host element is the single observable ancestor.
    return Boolean(host) && (target === host || host.contains(target));
  }

  function destroy() {
    host?.remove();
    host = null;
    shadow = null;
    panel = null;
    groups = [];
  }

  return {
    begin,
    addGroup,
    hit,
    prune,
    showMore,
    position,
    hide,
    isVisible,
    contains,
    isOwnElement,
    destroy,
    groupCount: () => groups.length,
  };
}

function text(tag, value, className) {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}
