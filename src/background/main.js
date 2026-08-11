/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

// Background worker (Chrome) / event page (Firefox).
//
// Holds the host permission, so its fetches are not subject to the host page's CORS
// — which is the whole reason lookups route through here rather than being issued
// from the content script. Also the right place for the cache: one shared by every
// tab instead of one per tab.
//
// Verified in both browsers: Chrome grants the loopback host permission at install
// and Private Network Access does not block the fetch; Firefox MV3 does NOT grant
// host_permissions at install, and until the user grants it the fetch fails as a
// CORS error carrying "Status code: 200" — the server answered, the extension was
// not allowed to read it.

import { api } from '../common/api.js';
import {
  buildRegistry,
  defaultSelection,
  isForBaseUrl,
  labelFor,
  loadRegistry,
  saveRegistry,
} from '../common/dicts.js';
import {
  BEGIN,
  CANCEL,
  END,
  FAILED,
  HIT,
  LOOKUP,
  LOOKUP_DEFAULTS,
  OUTCOME,
  PORT_NAME,
} from '../common/protocol.js';
import { buildEntryUrl } from '../common/refs.js';
import { getSettings, setSettings, withSiteRule } from '../common/settings.js';
import { HEALTH, hostOf, toolbarState } from '../common/state.js';
import { cacheKey, createCache } from './cache.js';
import { droppedIds, fetchDicts, InvalidQueryError, search } from './client.js';
import { WudictHttpError } from './ndjson.js';

const cache = createCache();

let registry = null;
let registryFetch = null;

// ------------------------------------------------------------------- health

// Whether wudict is reachable. Not polled: a background timer would wake the worker
// forever to answer a question nobody is asking. It is set as a side effect of work
// that already happens — every lookup is a probe — and refreshed on demand when the
// popup opens.
const health = { status: HEALTH.UNKNOWN, message: '', at: 0 };

function setHealth(status, message = '') {
  const changed = health.status !== status;
  health.status = status;
  health.message = message;
  health.at = Date.now();
  if (changed) void paintAllTabs();
}

/** Force a real request. `maxAgeMs` reuses a recent verdict instead. */
async function probeHealth({ maxAgeMs = 0 } = {}) {
  if (maxAgeMs > 0 && health.status !== HEALTH.UNKNOWN && Date.now() - health.at < maxAgeMs) {
    return health;
  }
  const result = await smoke();
  setHealth(result.ok ? HEALTH.OK : HEALTH.DOWN, result.message);
  return health;
}

// ------------------------------------------------------------------- registry

/** Load from storage, fetching only if absent or fetched from a different origin. */
async function ensureRegistry(baseUrl) {
  if (isForBaseUrl(registry, baseUrl)) return registry;

  const stored = await loadRegistry();
  if (isForBaseUrl(stored, baseUrl)) {
    registry = stored;
    return registry;
  }
  return refreshRegistry(baseUrl);
}

/** Refresh from the server. Concurrent callers share one in-flight request. */
async function refreshRegistry(baseUrl) {
  if (registryFetch) return registryFetch;
  registryFetch = (async () => {
    const { total, dicts } = await fetchDicts(baseUrl);
    const next = buildRegistry({ baseUrl, total, dicts });
    await saveRegistry(next);
    registry = next;
    return next;
  })();
  try {
    return await registryFetch;
  } finally {
    registryFetch = null;
  }
}

// --------------------------------------------------------------------- lookups

api.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;

  const session = { controller: null };

  port.onMessage.addListener((message) => {
    switch (message?.type) {
      case LOOKUP:
        void runLookup(port, session, message);
        break;
      case CANCEL:
        session.controller?.abort();
        break;
      default:
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    session.controller?.abort();
    session.controller = null;
  });
});

async function runLookup(port, session, message) {
  // One lookup in flight per port. The server stops streaming for an aborted
  // request, so this saves work on both sides.
  session.controller?.abort();
  const controller = new AbortController();
  session.controller = controller;

  const { id } = message;
  const post = (payload) => {
    if (controller.signal.aborted) return;
    try {
      port.postMessage(payload);
    } catch {
      // The port is gone (navigation, tab close).
      controller.abort();
    }
  };

  try {
    const { baseUrl } = await getSettings();
    const current = await ensureRegistry(baseUrl);

    const base = {
      mode: message.mode ?? LOOKUP_DEFAULTS.mode,
      n: message.n ?? LOOKUP_DEFAULTS.n,
      format: message.format ?? LOOKUP_DEFAULTS.format,
    };

    const dicts = resolveDicts(message, current, base.mode);
    if (dicts.length === 0) {
      post({
        type: FAILED,
        id,
        reason: 'no-dictionaries',
        message: `no dictionary can answer mode=${base.mode}`,
      });
      return;
    }

    const terms = (message.candidates ?? []).filter((term) => typeof term === 'string');
    if (terms.length === 0) {
      post({ type: FAILED, id, reason: 'invalid', message: 'no candidate terms' });
      return;
    }

    // Walk the fallback chain, committing to the first candidate that actually
    // produces a result. Nothing is posted before then, so a fallback never paints
    // a popup that is immediately replaced.
    for (const term of terms) {
      if (controller.signal.aborted) return;
      const query = { ...base, q: term };
      const committed = await attemptCandidate({
        post,
        id,
        baseUrl,
        dicts,
        query,
        registry: current,
        signal: controller.signal,
        append: message.append === true,
      });
      if (committed) {
        // A result that came off the network proves the server answered; one served
        // from cache proves nothing about right now.
        if (!committed.fromCache) setHealth(HEALTH.OK);
        post({ type: END, id, term, matched: true, fromCache: committed.fromCache });
        return;
      }
    }

    setHealth(HEALTH.OK);
    post({ type: END, id, term: null, matched: false, fromCache: false });
  } catch (error) {
    if (controller.signal.aborted || error.name === 'AbortError') return;

    if (error instanceof InvalidQueryError) {
      post({ type: FAILED, id, reason: 'invalid', message: error.message });
    } else if (error instanceof WudictHttpError) {
      // The server answered, so it is up; this query was the problem.
      setHealth(HEALTH.OK);
      post({ type: FAILED, id, reason: 'http', status: error.status, message: error.message });
    } else {
      setHealth(HEALTH.DOWN, describeFetchFailure(error));
      post({ type: FAILED, id, reason: 'blocked', message: describeFetchFailure(error) });
    }
  } finally {
    if (session.controller === controller) session.controller = null;
  }
}

/**
 * Run one candidate. Returns `{ fromCache }` if it produced results and was
 * rendered, or false if it found nothing and the chain should continue.
 */
async function attemptCandidate({
  post,
  id,
  baseUrl,
  dicts,
  query,
  registry: current,
  signal,
  append,
}) {
  const slotsFor = (ids) => ids.map((dict) => ({ dict, name: labelFor(current, dict) }));

  // All-or-nothing: a partial hit refetches rather than merging a subset back in.
  const keys = dicts.map((dict) => cacheKey(dict, query));
  if (keys.every((key) => cache.has(key))) {
    const entries = dicts.map((dict) => cache.get(cacheKey(dict, query)));
    if (!entries.some((entry) => entry.outcome === OUTCOME.RESULTS)) return false;

    post({ type: BEGIN, id, term: query.q, slots: slotsFor(dicts), append, fromCache: true });
    entries.forEach((entry, i) => post({ type: HIT, id, i, dict: dicts[i], ...entry }));
    return { fromCache: true };
  }

  let committed = false;
  let slots = null;
  const buffered = [];

  for await (const frame of search(baseUrl, { ...query, dicts }, { signal })) {
    if (frame.t === 'begin') {
      slots = frame.slots;
      const dropped = droppedIds(dicts, slots);
      if (dropped.length > 0) {
        // Ids derive from paths, so a dropped id means the registry is stale.
        void refreshRegistry(baseUrl).catch(() => {});
      }
      continue;
    }

    if (frame.t !== 'hit') continue;

    const entry = {
      name: frame.name,
      outcome: frame.outcome,
      results: frame.results,
      error: frame.error,
    };
    // Misses are cached too: without that, a word whose chain ends in nothing
    // re-probes the server on every crossing.
    cache.set(cacheKey(frame.dict, query), entry);

    const payload = { type: HIT, id, i: frame.i, dict: frame.dict, ...entry };

    if (!committed && frame.outcome === OUTCOME.RESULTS) {
      committed = true;
      post({
        type: BEGIN,
        id,
        term: query.q,
        // The server repeats the id in slots[].name; real names come from the
        // registry.
        slots: slotsFor(slots.map((slot) => slot.dict)),
        append,
        fromCache: false,
      });
      for (const held of buffered) post(held);
      buffered.length = 0;
    }

    if (committed) post(payload);
    else buffered.push(payload);
  }

  return committed ? { fromCache: false } : false;
}

/**
 * Which dictionaries to query: an explicit list, or the next capable ones not
 * already on screen (the "more" flow).
 */
function resolveDicts(message, current, mode) {
  if (Array.isArray(message.dicts) && message.dicts.length > 0) return message.dicts;

  const exclude = new Set(message.exclude ?? []);
  const capable = defaultSelection(current, { mode, limit: Infinity });
  // The server opens at most 8 concurrently; past that latency grows with the queue.
  const limit = Math.min(message.limit ?? 3, 8);
  return capable.filter((id) => !exclude.has(id)).slice(0, limit);
}

function describeFetchFailure(error) {
  return (
    `could not reach wudict: ${error.message}. Either it is not running, or the ` +
    'host permission is not granted (Firefox MV3 does not grant host_permissions ' +
    'at install: about:addons > wudict Hover > Permissions).'
  );
}

// ----------------------------------------------------------------------- tabs

// One wudict tab that keeps being reused is far less annoying than twenty.
let wudictTabId = null;

async function openTab(url, reuse) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`refusing to open ${parsed.protocol}`);
  }

  if (reuse && wudictTabId !== null) {
    try {
      await api.tabs.update(wudictTabId, { url, active: true });
      return;
    } catch {
      // Closed since we remembered it.
      wudictTabId = null;
    }
  }

  const tab = await api.tabs.create({ url });
  if (reuse) wudictTabId = tab.id;
}

api.tabs?.onRemoved.addListener((tabId) => {
  if (tabId === wudictTabId) wudictTabId = null;
  tabHosts.delete(tabId);
});

// ------------------------------------------------------------- per-tab state

// tabId -> hostname, reported by the content script at document_idle.
//
// Reading `tab.url` instead would work and be simpler, and it is exactly what the
// "tabs" permission exists to gate — an install-time warning about reading browsing
// history, for a feature that only needs the host of the page the user is looking
// at *right now*. The content script already runs there and already knows. This
// costs one message and no permission.
//
// A tab with no entry is a page no content script could run on (browser settings,
// the add-ons manager, the web store, a PDF viewer). That is a real state the UI
// must show, not a lookup failure.
const tabHosts = new Map();

async function paintTab(tabId, host) {
  if (!api.action?.setIcon) return;
  const settings = await getSettings();
  const view = toolbarState({
    settings,
    host: host === undefined ? (tabHosts.get(tabId) ?? null) : host,
    health: health.status,
    baseUrl: settings.baseUrl,
  });

  const path = {
    16: `icons/${view.icon}-16.png`,
    32: `icons/${view.icon}-32.png`,
    48: `icons/${view.icon}-48.png`,
    128: `icons/${view.icon}-128.png`,
  };

  // Every one of these rejects on a tab that closed mid-await, which is routine.
  await Promise.all([
    api.action.setIcon({ tabId, path }).catch(() => {}),
    api.action.setTitle({ tabId, title: view.title }).catch(() => {}),
    api.action.setBadgeText({ tabId, text: view.badge }).catch(() => {}),
    view.badge
      ? api.action
          .setBadgeBackgroundColor({ tabId, color: view.badgeColour })
          .catch(() => {})
      : Promise.resolve(),
  ]);
}

/** Repaint every tab we know about, plus whatever is on screen. */
async function paintAllTabs() {
  if (!api.tabs?.query) return;
  try {
    const tabs = await api.tabs.query({});
    await Promise.all(tabs.map((tab) => (tab.id === undefined ? null : paintTab(tab.id))));
  } catch {
    // No tabs API access in this context; the icon simply keeps its last state.
  }
}

async function activeTab() {
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    return tab ?? null;
  } catch {
    return null;
  }
}

api.tabs?.onUpdated.addListener((tabId, changeInfo) => {
  // A navigation invalidates the host until the new page's content script says
  // otherwise. Without this, the icon keeps claiming the previous site's state.
  if (changeInfo.status === 'loading') {
    tabHosts.delete(tabId);
    void paintTab(tabId, null);
  }
});

api.tabs?.onActivated.addListener(({ tabId }) => void paintTab(tabId));

// ------------------------------------------------------------------- searching

/**
 * A deliberate lookup: the toolbar search box, the selection context menu, or the
 * keyboard command.
 *
 * `all` and the full page by default — a deliberate search is not a hover. The user
 * has stopped reading and wants the entry, so the answer is the real wudict page
 * with every dictionary, not three slots in a 380px panel. `searchTarget: 'popup'`
 * opts into the hover renderer instead, which needs a live content script and so
 * falls back to the page whenever there isn't one.
 */
async function runSearch(rawTerm, { tabId = null, frameId = 0, target = null } = {}) {
  const term = normalizeTerm(rawTerm);
  if (!term) return { ok: false, message: 'nothing to look up' };

  const settings = await getSettings();
  const where = target ?? settings.searchTarget;

  if (where === 'popup' && tabId !== null) {
    try {
      // Addressed to one frame: broadcasting would open the popup in every iframe
      // on the page at once.
      const reply = await api.tabs.sendMessage(
        tabId,
        { type: 'wudict:showFor', term },
        { frameId },
      );
      if (reply?.ok) return { ok: true, where: 'popup' };
    } catch {
      // No content script on this page (or it is still loading) — fall through.
    }
  }

  await openTab(buildEntryUrl(settings.baseUrl, { q: term, mode: 'exact', dict: 'all' }), true);
  return { ok: true, where: 'page' };
}

/**
 * A selection can be a paragraph. wudict matches a headword, and a URL is not a
 * transport for prose, so this collapses whitespace and caps the length well above
 * any real headword and well below anything that would bloat the URL.
 */
function normalizeTerm(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, 200);
}

// ----------------------------------------------------------------- diagnostics

/** `await wudictSmoke()` in the background console. */
async function smoke() {
  const { baseUrl } = await getSettings();
  const started = Date.now();
  const permission = await hostPermissionState(baseUrl);

  try {
    const next = await refreshRegistry(baseUrl);
    return {
      ok: true,
      baseUrl,
      permission,
      message: `${next.dicts.length} dictionaries (begin.total ${next.total}) in ${
        Date.now() - started
      } ms`,
      // `total` is an upper bound: dictionaries that cannot be described are omitted.
      omitted: next.total === null ? null : next.total - next.dicts.length,
      exactCapable: next.dicts.filter((dict) => dict.caps?.Exact).length,
      defaultSelection: defaultSelection(next).map((id) => labelFor(next, id)),
    };
  } catch (error) {
    if (error instanceof WudictHttpError) {
      return { ok: false, baseUrl, permission, reason: 'http', message: error.message };
    }
    return {
      ok: false,
      baseUrl,
      permission,
      reason: 'blocked',
      message: describeFetchFailure(error),
    };
  }
}

async function hostPermissionState(baseUrl) {
  // Advisory only: on Firefox 128 this reports true for a host permission the user
  // has not granted, and the fetch is then blocked by CORS anyway.
  try {
    const origins = [`${new URL(baseUrl).origin}/*`];
    return (await api.permissions.contains({ origins })) ? 'reported-granted' : 'not-granted';
  } catch (error) {
    return `unknown (${error.message})`;
  }
}

globalThis.wudictSmoke = smoke;
globalThis.wudictStats = () => ({
  cache: cache.stats(),
  registry: registry
    ? { baseUrl: registry.baseUrl, dicts: registry.dicts.length, fetchedAt: registry.fetchedAt }
    : null,
});
globalThis.wudictClearCache = () => cache.clear();

// --------------------------------------------------------------- context menus

// The selection menu is the third entry point, and the only one that needs neither
// hover nor a held key: select, right-click, look up. It is what makes the
// extension usable for someone who turns hover off entirely.
const MENU = {
  SELECTION: 'wudict-lookup-selection',
  SITE: 'wudict-toggle-site',
  TEST: 'wudict-test',
  OPEN: 'wudict-open',
  OPTIONS: 'wudict-options',
};

// Firefox exposes `menus`; both expose `contextMenus` under the contextMenus
// permission.
const menus = api.contextMenus ?? api.menus;

async function buildMenus() {
  if (!menus) return;

  // Chrome calls the callback; Firefox ignores it and resolves a promise instead.
  // Waiting on only one of the two hangs on the other browser, and the menu is
  // never built.
  await new Promise((resolve) => {
    const pending = menus.removeAll(resolve);
    if (pending?.then) pending.then(resolve, resolve);
  });

  const settings = await getSettings();

  if (settings.contextMenu) {
    // %s is the selection, substituted by the browser.
    create({
      id: MENU.SELECTION,
      title: 'Look up "%s" in wudict',
      contexts: ['selection'],
    });
  }

  // The toolbar icon's own menu. The browser's items (Options, Pin, Manage) stay;
  // these are added above them, and are the two or three things worth reaching
  // without opening the panel first.
  create({ id: MENU.SITE, title: 'Pause on this site', contexts: ['action'] });
  create({ id: MENU.TEST, title: 'Test connection', contexts: ['action'] });
  create({ id: MENU.OPEN, title: 'Open wudict', contexts: ['action'] });
  create({ id: MENU.OPTIONS, title: 'Options', contexts: ['action'] });

  await refreshSiteMenuItem();
}

/**
 * Create one item, tolerating a context this browser does not know.
 *
 * `action` as a context is MV3-era; on a browser that rejects it the rest of the
 * menu must still appear rather than the whole build aborting on the first item.
 */
function create(properties) {
  try {
    menus.create(properties, () => void api.runtime.lastError);
  } catch (error) {
    console.debug('[wudict] menu item skipped:', properties.id, error.message);
  }
}

/** The site item is a verb, so its label has to track what it would do. */
async function refreshSiteMenuItem() {
  if (!menus) return;
  const settings = await getSettings();
  const tab = await activeTab();
  const host = tab?.id === undefined ? null : (tabHosts.get(tab.id) ?? null);
  const paused = host !== null && settings.siteRules?.[host] === false;

  const title =
    host === null ? 'Pause on this site' : paused ? `Resume on ${host}` : `Pause on ${host}`;

  try {
    await menus.update(MENU.SITE, { title, enabled: host !== null });
  } catch {
    // The item does not exist yet, or this browser refused the action context.
  }
}

menus?.onClicked.addListener((info, tab) => {
  void handleMenuClick(info, tab);
});

async function handleMenuClick(info, tab) {
  switch (info.menuItemId) {
    case MENU.SELECTION:
      // info.frameId is the frame the selection is in, which is the frame the popup
      // has to open in if the user chose the popup target.
      await runSearch(info.selectionText, {
        tabId: tab?.id ?? null,
        frameId: info.frameId ?? 0,
      });
      break;
    case MENU.SITE:
      await toggleSite(tab?.id ?? null);
      break;
    case MENU.TEST:
      await probeHealth();
      break;
    case MENU.OPEN: {
      const { baseUrl } = await getSettings();
      await openTab(baseUrl, true);
      break;
    }
    case MENU.OPTIONS:
      api.runtime.openOptionsPage();
      break;
    default:
      break;
  }
}

async function toggleSite(tabId) {
  const host = tabId === null ? null : (tabHosts.get(tabId) ?? null);
  if (host === null) return { ok: false, message: 'this page has no host' };

  const settings = await getSettings();
  const paused = settings.siteRules?.[host] === false;
  await setSettings(withSiteRule(settings, host, paused));
  return { ok: true, host, enabled: paused };
}

// ------------------------------------------------------------------- commands

api.commands?.onCommand.addListener((command) => {
  void handleCommand(command);
});

async function handleCommand(command) {
  const tab = await activeTab();
  switch (command) {
    case 'toggle-enabled': {
      const settings = await getSettings();
      await setSettings({ enabled: !settings.enabled });
      break;
    }
    case 'toggle-site':
      await toggleSite(tab?.id ?? null);
      break;
    case 'lookup-selection': {
      // The selection lives in the page, so the content script has to hand it over.
      if (tab?.id === undefined) break;
      try {
        const reply = await api.tabs.sendMessage(tab.id, { type: 'wudict:selection' });
        if (reply?.term) await runSearch(reply.term, { tabId: tab.id });
      } catch {
        // No content script here; nothing to look up.
      }
      break;
    }
    default:
      break;
  }
}

// ------------------------------------------------------------------- lifecycle

// Bootstrap the registry once, so the first hover does not pay for it. Never polled.
api.runtime.onInstalled.addListener(() => void bootstrap('onInstalled'));
api.runtime.onStartup.addListener(() => void bootstrap('onStartup'));

async function bootstrap(trigger) {
  await buildMenus();
  try {
    const { baseUrl } = await getSettings();
    const next = await ensureRegistry(baseUrl);
    setHealth(HEALTH.OK);
    console.info(`[wudict] ${trigger}: registry ready, ${next.dicts.length} dictionaries`);
  } catch (error) {
    setHealth(HEALTH.DOWN, describeFetchFailure(error));
    console.warn(`[wudict] ${trigger}: registry unavailable — ${error.message}`);
  }
  await paintAllTabs();
}

// A settings change can flip every one of the three facts the icon reports, and the
// menu label with them.
api.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;
  if (changes.contextMenu) void buildMenus();
  else void refreshSiteMenuItem();
  void paintAllTabs();
  // A new base URL says nothing about whether the old one was reachable.
  if (changes.baseUrl) setHealth(HEALTH.UNKNOWN);
});

// The worker is torn down when idle and rebuilt on the next event, at which point
// the menus it created are gone in Chrome but its module scope is fresh. Building
// them here rather than only in onInstalled is what keeps them from disappearing.
void buildMenus();

// Used by the options page, the toolbar panel and the content script. A context
// does not receive its own messages, so this is not what the background console
// uses.
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // The content script announcing where it is running. Top frame only: an ad iframe
  // must not get to claim the tab's identity.
  if (message?.type === 'wudict:hello') {
    const tabId = sender?.tab?.id;
    if (tabId !== undefined && (sender.frameId ?? 0) === 0) {
      const host = hostOf(message.url) ?? hostOf(sender.tab?.url ?? '');
      if (host) tabHosts.set(tabId, host);
      else tabHosts.delete(tabId);
      void paintTab(tabId, host);
      void refreshSiteMenuItem();
    }
    sendResponse({ ok: true });
    return false;
  }

  // Everything the toolbar panel paints, in one round trip: it opens, renders, and
  // has nothing to chase.
  if (message?.type === 'wudict:state') {
    (async () => {
      const settings = await getSettings();
      const tab = await activeTab();
      const host = tab?.id === undefined ? null : (tabHosts.get(tab.id) ?? null);
      // A stale verdict from minutes ago is worse than none: the panel exists to
      // tell the user whether it works *now*.
      if (message.probe) await probeHealth({ maxAgeMs: 15000 });
      return {
        ok: true,
        settings,
        host,
        tabId: tab?.id ?? null,
        health: { status: health.status, message: health.message, at: health.at },
        dicts: registry?.dicts?.length ?? null,
        view: toolbarState({
          settings,
          host,
          health: health.status,
          baseUrl: settings.baseUrl,
        }),
      };
    })().then(sendResponse, (error) => sendResponse({ ok: false, message: String(error) }));
    return true;
  }

  if (message?.type === 'wudict:search') {
    runSearch(message.term, { tabId: message.tabId ?? null, target: message.target ?? null }).then(
      sendResponse,
      (error) => sendResponse({ ok: false, message: error.message }),
    );
    return true;
  }

  if (message?.type === 'wudict:toggleSite') {
    toggleSite(message.tabId ?? null).then(sendResponse, (error) =>
      sendResponse({ ok: false, message: error.message }),
    );
    return true;
  }

  if (message?.type === 'wudict:probe') {
    probeHealth()
      .then((result) => sendResponse({ ok: result.status === HEALTH.OK, ...result }))
      .catch((error) => sendResponse({ ok: false, message: String(error) }));
    return true;
  }

  if (message?.type === 'wudict:smoke') {
    smoke().then(
      (result) => {
        setHealth(result.ok ? HEALTH.OK : HEALTH.DOWN, result.message);
        sendResponse(result);
      },
      (error) => sendResponse({ ok: false, reason: 'exception', message: String(error) }),
    );
    return true;
  }
  if (message?.type === 'wudict:open') {
    openTab(message.url, message.reuse === true).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, message: error.message }),
    );
    return true;
  }
  if (message?.type === 'wudict:registry') {
    (async () => {
      const { baseUrl } = await getSettings();
      return message.refresh ? refreshRegistry(baseUrl) : ensureRegistry(baseUrl);
    })().then(
      (value) => sendResponse({ ok: true, registry: value }),
      (error) => sendResponse({ ok: false, message: error.message }),
    );
    return true;
  }
  return false;
});
