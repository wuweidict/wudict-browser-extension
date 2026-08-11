# wudict Hover

**wudict Hover** is a free browser extension — Chrome & Firefox — that shows dictionary definitions when you hover over a word. It reads from [**wudict**](https://github.com/wuweidict/wudict), a dictionary for MDict (.mdx), AARD2 (.slob), Babylon (.bgl), Stardict (.ifo), ABBYY Lingvo (.dsl) which must be running on your computer or another host on your local network.

- **Works with:** Chrome ≥ 116, Firefox ≥ 128 (MV3)
- **Needs:** a running [**wudict**](https://github.com/wuweidict/wudict server) — everything is fetched from **your machine, `http://127.0.0.1:6888`** (configurable). No cloud, no account, no tracking.
- **Free & open source:** no data collection, no analytics, no tracking, no profiling, no third-party cookies.
- **Also needs (Firefox only):** one manual permission grant after install — see below.
- **Current version:** v0.1.0

---

## Install
<p align="center">
  <a href="https://chromewebstore.google.com/">
    <img alt="Add to Chrome — Chrome Web Store" src="https://img.shields.io/badge/Add%20to%20Chrome-Chrome%20Web%20Store-1a73e8?style=for-the-badge&logo=googlechrome&logoColor=white" />
  </a>
  &nbsp;&nbsp;
  <a href="https://addons.mozilla.org/">
    <img alt="Add to Firefox — Firefox Add-ons" src="https://img.shields.io/badge/Add%20to%20Firefox-Firefox%20Add--ons-FF7139?style=for-the-badge&logo=firefox&logoColor=white" />
  </a>
</p>

> Store listing links are wired here at release — swap the `href`s and the badges keep rendering. Until then, everything in §Dev installs and runs identically.

**Before you click:** make sure wudict is running — the extension is a frontend, not a dictionary by itself.

| Step | What happens | Details |
|---|---|---|
| 1 | Install the extension | Chrome: unpacked self-host or Web Store · Firefox: `.xpi` or self-host |
| 2 | Firefox: grant access | `about:addons → wudict Hover → Permissions → http://127.0.0.1:6888/*`. Chrome grants it automatically. |
| 3 | Start wudict | `wudict --port 6888` (or your usual setup) |
| 4 | Done | Hover any word, hold **Alt/Option** (default) |

---

## Quick start

1. Start wudict.
2. Install the extension (above).
3. Hover any word, keep holding **Alt**. The popup opens.
4. Release Alt, move into the popup — it stays while your pointer is inside; leaving dismisses it after 400 ms. **Esc** dismisses instantly.

If not triggering: check the **Options** page → **Test connection**; and on Firefox, the permission grant in step 2.

---

## Three ways to look something up

Hover is the fast path, not the only one. Nothing here requires the others to be enabled.

| Entry point | How | Where the answer opens |
|---|---|---|
| **Hover** | point at a word, hold **Alt** (configurable, or no key at all) | the in-page popup |
| **Selection** | select text, right-click → **Look up "…" in wudict** — or **Alt+Shift+W** | the full wudict page, **all dictionaries** (configurable) |
| **Toolbar** | click the icon → type in the search box — or **Alt+W** | same as selection |

The selection menu exists for exactly the case where hover is unwanted: turn hover off entirely and the extension still works, with no key held and no pointer timing.

### The toolbar icon

Clicking the icon opens a panel, not the options page. It carries what changes often or is needed when something is wrong; everything else is one click away in its footer.

- **Connection** — live: connected · *n* dictionaries, or **Cannot reach …** with **Retry**, and on Firefox a **Grant access** button that requests the host permission in place (see step 2 of Install)
- **Search box** — opens the full wudict page for the word, all dictionaries
- **Hold key** — the setting people actually change
- **This site** — pause hover on this host without touching the master switch; the list of paused sites is on the options page

The icon itself reports state before you click it: **coloured** when hover is live here, **grey** when paused globally or on this site, with an amber **!** badge when wudict cannot be reached. Hover the icon for the whole sentence.

Right-clicking the icon adds **Pause on *host*** · **Test connection** · **Open wudict** · **Options** above the browser's own items.

### Keyboard

| Shortcut | Does |
|---|---|
| **Alt+W** | open the toolbar panel |
| **Alt+Shift+W** | look up the current selection |
| unassigned | pause/resume everywhere, pause/resume this site — bind in `chrome://extensions/shortcuts` or `about:addons → ⚙ → Manage Extension Shortcuts` |

---

## Using the hover popup

The popup shows one entry per dictionary (up to 3 by default), streamed in as dictionaries answer — the fastest result paints first.

| Action | How |
|---|---|
| Open full entry in wudict (this dictionary) | icon in the popup header |
| Search **all** dictionaries in wudict | header icon, right of the first |
| Load more dictionaries | **More dictionaries** button at the bottom |
| Play audio pronunciation | click the speaker link in an entry |
| Jump to a section anchor | any in-entry anchor scrolls inside the popup |
| Dismiss | Esc, click outside, or move the pointer away |

Lookups are cached in the service worker — crossing the same word again is instant, and the header shows **cached** when it was.

### Inflected words

wudict does **no morphology**: `running` is found only if a dictionary stores it. The extension compensates with a fallback chain — apostrophe, possessive, hyphen, suffix variants (4 attempts by default), each one request, only for words that would otherwise return nothing.

---

## Options

| Setting | Default | Notes |
|---|---|---|
| Base URL | `http://127.0.0.1:6888` | both host and port are configurable in wudict; **Test connection** verifies, **Grant access** (Firefox) requests the host permission |
| Enabled | on | master switch (also in the toolbar panel) |
| Hold key | Alt/Option | or none, ctrl, shift, cmd/win (also in the toolbar panel) |
| Hover delay | 200 ms | debounce before lookup fires |
| Search opens | full wudict page | where the toolbar search box, the right-click item and the shortcut land — the full page with **all dictionaries**, or the hover popup on the current page. Hover itself always uses the popup |
| Right-click menu | on | show **Look up "…" in wudict** on selected text |
| Paused sites | none | per-host opt-outs, added from the toolbar panel or the icon menu; resume them here once you have left the site |
| Dictionaries per lookup | 3 | 1–8 |
| Entries per dictionary | 1 | 1–10 (hover is glanceable; keep small) |
| Fallback attempts | 4 | 1–8 |
| Dictionaries | auto | unchecked = first capable dictionaries in server order; or pick explicitly |

---

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| Nothing happens on hover | Modifier not held · paused globally or on this site · wudict not running → **click the toolbar icon**: the panel says which |
| Grey icon | Paused — the panel's master switch or its **this site** switch |
| Amber **!** on the icon | wudict is not reachable → panel → **Retry**, and on Firefox **Grant access** |
| Right-click item missing | Turn it back on in **Options → Searching**; it never appears without a text selection |
| Firefox: connection fails | Host permission not granted → options **Grant access**, or `about:addons → Permissions` |
| Word shows nothing | Dictionary lacks the word (no morphology) → open the word in wudict to check |
| Popup closes immediately | Pointer left it; or you scrolled the page (by design — reposition and it reopens) |
| "does not support this search mode" | A dictionary that can't answer `exact` — expected, others still render |

---

## Privacy

Open source — the entire extension is readable and buildable by anyone.

**No data collection. No analytics. No tracking. No profiling. No third-party data.**

Nothing leaves your machine: the only network traffic is a dictionary lookup to the wudict server **you** run. Permissions are `storage` plus that loopback address.

---

## Dev

Requirements: `node ≥ 18`, `make`. Deps: `npm ci` (via `make deps`).

```sh
make deps          # install dev dependencies (eslint, prettier, web-ext)
make build         # dist/chrome + dist/firefox (version from VERSION)
make test          # unit tests (node:test, no server needed)
make lint          # eslint over src/ test/ tools/
make validate      # per-flavour checks + web-ext lint (Firefox's own validator)
make check         # preflight + lint + test + validate (CI equivalent)
make run-chrome    # launch Chrome with the extension, persistent profile
make run-firefox   # launch Firefox with the extension, persistent profile
make watch-firefox # rebuild dist/ on src/ change (pair with run-… in another shell)
```

`make release` produces everything in `dist/artifacts/`: store-format zips, a signed `.crx` (local key), checksums. Signing and publishing are separate, credential-gated steps:

```sh
make crx-chrome                 # self-hosted signed .crx
make sign-firefox               # AMO-signed .xpi (unlisted)
make publish-firefox CONFIRM=yes    # public AMO listing  (needs keys)
make publish-chrome CONFIRM=yes CWS_ITEM_ID=…   # Web Store  (needs keys)
```

Self-install a built extension: Chrome — `chrome://extensions → Developer mode → Load unpacked → dist/chrome`. Firefox — `about:debugging#/runtime/this-firefox → Load Temporary Add-on → dist/firefox/manifest.json` (temporary) or install the signed `.xpi`.

---

## How it works

The extension is a thin client for your local wudict server.

```
page ──mousemove──► content script ──port──► service worker ──HTTP/NDJSON──► wudict:6888
    (word detected,     (popup DOM,        (host permission, cache,     (dictionaries)
     popup rendered)     closed shadow root) registry)
```

- **No CORS problem:** the worker holds the host permission, so its fetches are not subject to the host page's origin. Content scripts never fetch wudict.
- **One request per lookup** (candidate + dictionary list), aborted cleanly on the next hover; the server streams newline-delimited JSON, so results render as they arrive.
- **Words are highlighted** in the page via the Custom Highlight API — no DOM rewriting.
- **Popup isolation:** closed shadow root + server-side `format=clean` (scripts and styles stripped at the source). An entry's dictionary CSS/JS never runs; anchors, tables and images stay.
- **Full entries** open in wudict's own page in one *reused* tab — a click on a cross-reference, the header icons, or the "open in app" prompts all route there, never through the popup.

---

<details>
<summary>Technical reference (for those who need it)</summary>

### Lookup pipeline

- Content script detects the word under the cursor (`caretPositionFromPoint`), debounces (default 200 ms), and sends `LOOKUP` over a named port; a new hover aborts the in-flight request — the server stops streaming on abort, so this saves work on both sides.
- Worker resolves dictionaries from a **registry** (fetched once from `/api/dicts`, cached per base URL, refreshed only on demand). Unchecked pick = first `exact`-capable dictionaries in server order, capped by `limit` (3; "more" appends up to 8 more, excluding what's on screen).
- The candidate chain walks until one term actually produces results; nothing is painted before that, so a fallback never flashes a popup that is immediately replaced.
- **Cache:** LRU per `dict|mode|n|format|q` (not per request), 400 entries / 8 MB bounded, misses cached too (a word whose chain ends in nothing re-probes the server on every crossing otherwise). Popup shows `cached` when served from it.

### The wudict contract in use

- `GET /api/search?q=…&mode=exact&n=1&format=clean&dict=<ids>` — comma-separated ids answered in **one** request, dictionaries opened concurrently (8 at a time). `n=1` and `clean` are deliberate: the raw article payload is often 100–190 KB, and `clean` is measured ~1.9× smaller with all stylesheet/script refs stripped.
- Framing: `begin` (slots) → one `hit` per slot (`results` / `skipped` / `error` — the three outcomes that don't abort the stream) → `end`. Hits arrive in completion order; the popup renders into slots by index, so display order is the requested order.
- Errors arrive in two shapes — HTTP status + JSON before the stream, per-frame `error` after — both handled, neither subsumes the other.
- `GET /res/{dict}/{name}` resources are fetched as-is; `.spx` audio arrives transcoded to WAV, `Content-Type` decides the decoder, never the URL. One module-scope `Audio` is reused per page (a per-click element can be GC'd before a slow first response plays).

### Link/ref classification (popup routing)

| href | kind | routed to |
|---|---|---|
| `bword://run`, `entry:run`, `d:run`, `x:run`, bare headword | lookup | wudict tab, scoped to the *source* dictionary |
| `@`-prefixed (`bword://@Examples`) | section headword | same as lookup |
| `#id` / `bword://#id` | anchor | scroll inside popup (`format=clean` keeps ids) |
| `…/x.mp3` etc. | audio | reused `Audio` element |
| `http(s)://…` | external | new tab |
| anything else | — | ignored, never searched |

`preventDefault` fires first on every click; a bare `<a href>` would otherwise resolve against the **host page** and navigate it.

### Build/release pipeline

- `src/` is copied verbatim per flavour except `manifest.{chrome,firefox}.json`, which are version-stamped from `VERSION`. MV3 content scripts can't be ES modules, so `tools/bundle-content.mjs` concatenates them in dependency order into one classic script.
- `make validate-firefox` runs web-ext lint (the authority for that flavour; it correctly rejects Chrome's `service_worker` key).
- Release flow: `make release` → `clean check package checksums`; signing/publishing are separate steps requiring env-sourced credentials (`WEB_EXT_API_KEY`/`WEB_EXT_API_SECRET`, `CWS_*`) — never make variables, and never on the command line.
- Browser notes baked into the worker: Chrome grants the loopback host permission at install; Firefox MV3 does **not**, and until granted the fetch fails as a CORS-shaped error carrying "Status code: 200" — the server answered, the extension was not allowed to read it. That is why the Firefox grant step exists.
</details>

---

**The 30-second summary:** install → grant (Firefox) → start wudict → hold Alt and hover. Everything else is tuning.
