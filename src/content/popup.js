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
import { buildEntryUrl, classifyRef, REF } from '../common/refs.js';
import { sanitizeArticle } from './sanitize.js';

const HOST_ID = 'wudict-hover-host';
const MARGIN = 12;

// Static markup we author, not article HTML — assigned with innerHTML only here.
const ICON_ONE = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
  <path d="M6.5 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5v-3"
    fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  <path d="M9.5 2.5H14v4.5M14 2.5 7.5 9"
    fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const ICON_ALL = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
  <path d="M2 5.2 8 2.2l6 3-6 3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
  <path d="M2 8.4 8 11.4l6-3M2 11.4 8 14.4l6-3"
    fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// One reused element, at module scope. A per-click `new Audio(url)` can be garbage
// collected before it plays, because .spx is transcoded to WAV server-side and the
// first response can lag — silently, and only sometimes.
let audioEl = null;

function playAudio(url) {
  if (!url) return;
  if (!audioEl) audioEl = new Audio();
  // Never sniff the extension to pick a decoder: /res/ serves .spx as audio/wav,
  // so the URL lies and the Content-Type does not.
  audioEl.src = url;
  const played = audioEl.play();
  if (played?.catch) {
    played.catch((error) => console.warn('[wudict] audio play failed:', url, error));
  }
}

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
    position: sticky; top: 0; z-index: 1;
    background: #f2efe4;
    border-bottom: 1px solid rgba(0, 0, 0, 0.12);
    padding: 6px 10px;
    display: flex; gap: 6px; align-items: center;
  }
  .term .word { font-weight: 600; flex: 0 0 auto; max-width: 45%;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .term .sep { opacity: 0.35; flex: 0 0 auto; }
  /* Shrinks first and ellipsises, so the actions are never pushed off. */
  .term .dict-name { flex: 1 1 auto; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    opacity: 0.75; font-size: 12px; }
  .term .meta { font-weight: 400; opacity: 0.5; font-size: 11px; flex: 0 0 auto; }
  .term .act {
    flex: 0 0 auto; display: inline-flex; align-items: center;
    padding: 3px; border-radius: 4px; color: #0b5cad; text-decoration: none;
  }
  .term .act:hover { background: rgba(0, 0, 0, 0.08); }
  .term .act[hidden] { display: none; }
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
    .term .act { color: #7ab8ff; }
    .term .act:hover { background: rgba(255,255,255,0.12); }
    .slot { border-top-color: rgba(255,255,255,0.09); }
    .body a { color: #7ab8ff; }
    .body td, .body th { border-color: rgba(255,255,255,0.14); }
    .more { background: #2a2a24; border-top-color: rgba(255,255,255,0.12); color: #7ab8ff; }
    .more:hover { background: #33332b; }
  }
`;

export function createPopup({ onMore, onEnter, onLeave, onOpen }) {
  let host = null;
  let shadow = null;
  let panel = null;
  let header = null;
  let groups = [];
  let anchor = { x: 0, y: 0 };
  let serverOrigin = '';
  let baseUrl = '';
  let currentTerm = '';
  let observer = null;
  const visibleSlots = new Set();

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

    // Delegated once: articles carry hundreds of links.
    panel.addEventListener('click', onPanelClick);

    document.documentElement.appendChild(host);
  }

  // ------------------------------------------------------------------- routing

  function onPanelClick(event) {
    const target = event.target.closest?.('a[data-act], a[data-ref], a[href]');
    if (!target) return;

    // First, always. A bare href would otherwise navigate the *host page*.
    event.preventDefault();

    const action = target.dataset.act;
    if (action) {
      openEntry(action === 'all' ? 'all' : (target.dataset.dict ?? 'all'));
      return;
    }

    // The dict the article came from — not whatever the user is scrolled to. An
    // author's cross-reference means *this dictionary's* entry.
    const sourceDict = target.closest('[data-dict]')?.dataset.dict ?? null;
    route(target.dataset.ref ?? target.getAttribute('href'), sourceDict);
  }

  function route(raw, sourceDict) {
    const ref = classifyRef(raw);

    switch (ref.kind) {
      case REF.AUDIO:
        playAudio(absolute(ref.url));
        return;

      case REF.ANCHOR:
        // The one shape where a tab is the wrong answer: it points inside the
        // content already on screen, and applyURL does not read location.hash.
        scrollToId(ref.id);
        return;

      case REF.LOOKUP:
      case REF.SUB:
        onOpen?.({
          url: buildEntryUrl(baseUrl, { q: ref.q, mode: 'exact', dict: sourceDict ?? 'all' }),
          reuse: true,
        });
        return;

      case REF.EXTERNAL:
        onOpen?.({ url: ref.url, reuse: false });
        return;

      default:
        // Missing target, res//assets/, unknown scheme: do nothing rather than
        // fall back to searching, or `sense2` gets looked up as a word.
        break;
    }
  }

  function openEntry(dict) {
    if (!currentTerm) return;
    onOpen?.({ url: buildEntryUrl(baseUrl, { q: currentTerm, mode: 'exact', dict }), reuse: true });
  }

  function absolute(url) {
    try {
      return new URL(url, serverOrigin).href;
    } catch {
      return url;
    }
  }

  function scrollToId(id) {
    let target = null;
    try {
      target = panel.querySelector(`#${CSS.escape(id)}`);
    } catch {
      target = null;
    }
    if (!target) return;

    // Scroll the panel itself rather than scrollIntoView, which would also scroll
    // the host page, and offset by the sticky header so the target is not hidden.
    const top =
      target.getBoundingClientRect().top -
      panel.getBoundingClientRect().top +
      panel.scrollTop -
      (header?.offsetHeight ?? 0);
    panel.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  function isOwnElement(target) {
    return target === host;
  }

  function begin({ term, slots, base, anchorAt, fromCache }) {
    mount();
    baseUrl = base;
    serverOrigin = new URL(base).origin;
    currentTerm = term;
    anchor = anchorAt ?? anchor;
    groups = [];
    visibleSlots.clear();
    observer?.disconnect();
    observer = null;
    panel.replaceChildren();

    header = buildHeader(term, fromCache);
    panel.appendChild(header);

    addGroup(slots);
    show();
  }

  /**
   * The sticky toolbar: the word, the dictionary currently under the scroll
   * position, and the two link targets. Its contents are updated as the user
   * scrolls; only the dictionary name and the per-dictionary link change.
   */
  function buildHeader(term, fromCache) {
    const bar = document.createElement('div');
    bar.className = 'term';

    bar.append(text('span', term, 'word'));
    bar.append(text('span', '·', 'sep'));

    // Shortened by CSS ellipsis rather than by truncating the string: it adapts to
    // the actual width instead of guessing, and the full name stays in the tooltip.
    const name = text('span', '', 'dict-name');
    bar.append(name);

    if (fromCache) bar.append(text('span', 'cached', 'meta'));

    bar.append(actionLink('one', 'Open this dictionary’s full entry', ICON_ONE));
    bar.append(actionLink('all', 'Search all dictionaries', ICON_ALL));

    return bar;
  }

  function actionLink(act, label, icon) {
    const link = document.createElement('a');
    link.className = 'act';
    link.dataset.act = act;
    link.href = '#';
    link.title = label;
    link.setAttribute('role', 'button');
    link.setAttribute('aria-label', label);
    // Static, authored markup — never article HTML.
    link.innerHTML = icon;
    return link;
  }

  function setHeaderDict(dict, name) {
    if (!header) return;
    const label = header.querySelector('.dict-name');
    const one = header.querySelector('a[data-act="one"]');
    if (label) {
      label.textContent = name ?? '';
      label.title = name ?? '';
    }
    if (one) {
      one.dataset.dict = dict ?? 'all';
      one.hidden = !dict;
    }
  }

  /** A group is one request's worth of slots; "more" appends another. */
  function addGroup(slots) {
    const group = { slots, elements: new Map() };
    for (let i = 0; i < slots.length; i += 1) {
      const slot = document.createElement('div');
      slot.className = 'slot';
      // Every link inside this block resolves against the dictionary it came from.
      slot.dataset.dict = slots[i].dict;
      slot.dataset.name = slots[i].name;
      slot.append(text('div', slots[i].name, 'dict'));
      slot.append(text('div', 'searching…', 'pending'));
      panel.appendChild(slot);
      group.elements.set(i, slot);
      observe(slot);
    }
    groups.push(group);
    if (groups.length === 1 && slots.length > 0) setHeaderDict(slots[0].dict, slots[0].name);
    return groups.length - 1;
  }

  // ------------------------------------------------- scroll-tracked toolbar

  /**
   * Which dictionary the user is currently reading, without running JavaScript on
   * every scroll event.
   *
   * The observer's root is the scrolling panel and the margins collapse it to a
   * thin band just below the sticky header, so the only slot that intersects is
   * the one crossing that line. When nothing intersects — deep inside one long
   * entry — the previous value stays, which is the correct answer anyway.
   */
  function observe(slot) {
    if (typeof IntersectionObserver === 'undefined') return;
    if (!observer) {
      const headerHeight = header?.offsetHeight ?? 30;
      observer = new IntersectionObserver(onIntersect, {
        root: panel,
        rootMargin: `-${headerHeight}px 0px -88% 0px`,
        threshold: 0,
      });
    }
    observer.observe(slot);
  }

  function onIntersect(entries) {
    for (const entry of entries) {
      if (entry.isIntersecting) visibleSlots.add(entry.target);
      else visibleSlots.delete(entry.target);
    }
    if (visibleSlots.size === 0) return;

    // Deepest slot in the band wins, so scrolling down advances the label.
    let winner = null;
    for (const slot of visibleSlots) {
      if (!winner || slot.compareDocumentPosition(winner) & Node.DOCUMENT_POSITION_PRECEDING) {
        winner = slot;
      }
    }
    if (winner) setHeaderDict(winner.dataset.dict, winner.dataset.name);
  }

  function hit(groupIndex, { i, name, outcome, results, error }) {
    const group = groups[groupIndex];
    const slot = group?.elements.get(i);
    if (!slot) return;

    // The real name arrives on the hit; the placeholder carried the registry label.
    slot.dataset.name = name || group.slots[i]?.name || '';
    slot.replaceChildren();
    slot.append(text('div', slot.dataset.name, 'dict'));

    const shown = header?.querySelector('a[data-act="one"]')?.dataset.dict;
    if (shown === slot.dataset.dict) setHeaderDict(slot.dataset.dict, slot.dataset.name);

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
        observer?.unobserve(slot);
        visibleSlots.delete(slot);
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
    observer?.disconnect();
    observer = null;
    visibleSlots.clear();
    host?.remove();
    host = null;
    shadow = null;
    panel = null;
    header = null;
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
