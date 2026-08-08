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
import { getSettings } from '../common/settings.js';
import { cacheKey, createCache } from './cache.js';
import { droppedIds, fetchDicts, InvalidQueryError, search } from './client.js';
import { WudictHttpError } from './ndjson.js';

const cache = createCache();

let registry = null;
let registryFetch = null;

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
        post({ type: END, id, term, matched: true, fromCache: committed.fromCache });
        return;
      }
    }

    post({ type: END, id, term: null, matched: false, fromCache: false });
  } catch (error) {
    if (controller.signal.aborted || error.name === 'AbortError') return;

    if (error instanceof InvalidQueryError) {
      post({ type: FAILED, id, reason: 'invalid', message: error.message });
    } else if (error instanceof WudictHttpError) {
      post({ type: FAILED, id, reason: 'http', status: error.status, message: error.message });
    } else {
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
});

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

// ------------------------------------------------------------------- lifecycle

api.action?.onClicked.addListener(() => api.runtime.openOptionsPage());

// Bootstrap the registry once, so the first hover does not pay for it. Never polled.
api.runtime.onInstalled.addListener(() => void bootstrap('onInstalled'));
api.runtime.onStartup.addListener(() => void bootstrap('onStartup'));

async function bootstrap(trigger) {
  try {
    const { baseUrl } = await getSettings();
    const next = await ensureRegistry(baseUrl);
    console.info(`[wudict] ${trigger}: registry ready, ${next.dicts.length} dictionaries`);
  } catch (error) {
    console.warn(`[wudict] ${trigger}: registry unavailable — ${error.message}`);
  }
}

// Used by the options page. A context does not receive its own messages, so this is
// not what the background console uses.
api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'wudict:smoke') {
    smoke().then(sendResponse, (error) =>
      sendResponse({ ok: false, reason: 'exception', message: String(error) }),
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
