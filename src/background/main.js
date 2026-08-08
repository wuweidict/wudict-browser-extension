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
//
// There is no content script yet, so nothing connects the port until session 3.

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
        // One lookup in flight per port: the previous one is aborted, and the
        // server stops streaming for an aborted request.
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
  session.controller?.abort();
  const controller = new AbortController();
  session.controller = controller;

  const { id } = message;
  const post = (payload) => {
    // The port may be gone (navigation, tab close) and posting then throws.
    if (controller.signal.aborted) return;
    try {
      port.postMessage(payload);
    } catch {
      controller.abort();
    }
  };

  try {
    const { baseUrl } = await getSettings();
    const current = await ensureRegistry(baseUrl);

    const query = {
      q: message.q,
      mode: message.mode ?? LOOKUP_DEFAULTS.mode,
      n: message.n ?? LOOKUP_DEFAULTS.n,
      format: message.format ?? LOOKUP_DEFAULTS.format,
    };

    const dicts =
      Array.isArray(message.dicts) && message.dicts.length > 0
        ? message.dicts
        : defaultSelection(current, { mode: query.mode });

    if (dicts.length === 0) {
      post({
        type: FAILED,
        id,
        reason: 'no-dictionaries',
        message: `no dictionary can answer mode=${query.mode}`,
      });
      return;
    }

    if (servedFromCache(post, id, dicts, query, current)) return;

    let slots = null;
    for await (const frame of search(baseUrl, { ...query, dicts }, { signal: controller.signal })) {
      if (frame.t === BEGIN) {
        slots = frame.slots;
        post({
          type: BEGIN,
          id,
          // The server repeats the id here; the real names come from the registry.
          slots: slots.map((slot) => ({ dict: slot.dict, name: labelFor(current, slot.dict) })),
        });

        const dropped = droppedIds(dicts, slots);
        if (dropped.length > 0) {
          // Ids derive from paths, so a dropped id means the registry is stale.
          // Refresh in the background; the next lookup uses current ids.
          void refreshRegistry(baseUrl).catch(() => {});
        }
        continue;
      }

      if (frame.t === HIT) {
        const entry = {
          name: frame.name,
          outcome: frame.outcome,
          results: frame.results,
          error: frame.error,
        };
        // Misses are cached too, so a word that finds nothing is not re-probed.
        cache.set(cacheKey(frame.dict, query), entry);
        post({ type: HIT, id, i: frame.i, dict: frame.dict, ...entry });
      }
    }

    post({ type: END, id, fromCache: false });
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
 * Serve the whole lookup from cache, or nothing. A partial hit refetches the full
 * list rather than merging a subset back in by slot index.
 */
function servedFromCache(post, id, dicts, query, current) {
  const keys = dicts.map((dictId) => cacheKey(dictId, query));
  if (!keys.every((key) => cache.has(key))) return false;

  post({
    type: BEGIN,
    id,
    slots: dicts.map((dictId) => ({ dict: dictId, name: labelFor(current, dictId) })),
  });
  dicts.forEach((dictId, i) => {
    post({ type: HIT, id, i, dict: dictId, ...cache.get(cacheKey(dictId, query)) });
  });
  post({ type: END, id, fromCache: true });
  return true;
}

function describeFetchFailure(error) {
  return (
    `could not reach wudict: ${error.message}. Either it is not running, or the ` +
    'host permission is not granted (Firefox MV3 does not grant host_permissions ' +
    'at install: about:addons > wudict Hover > Permissions).'
  );
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

// Kept for other contexts (the options page's "Test connection"): a context does not
// receive its own messages, so this is not what the background console uses.
api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'wudict:smoke') return false;
  smoke().then(sendResponse, (error) =>
    sendResponse({ ok: false, reason: 'exception', message: String(error) }),
  );
  return true;
});
