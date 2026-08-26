# Privacy Policy — wudict Hover

**Effective:** 26 August 2026 · **Applies to:** wuDict Hover browser extension for Chrome and
Firefox, all versions · **Contact:** https://github.com/wuweidict/wudict-browser-extension/issues

## Summary

wudict Hover collects nothing, transmits nothing to its developer, and contacts no third party.
It has no server, no account system, no analytics and no advertising. The only network request
it makes goes to a dictionary server that you install and run yourself, at an address you
configure — by default `http://127.0.0.1:6888`, your own computer.

## What the extension does with data

**The word you look up.** When you hover a word with the modifier key held, select text and use
the right-click item, or type in the toolbar search box, that text is sent — only — to the
wudict server address configured in the extension's options. That server is software you
installed and control. The developer of this extension operates no server and receives no copy.

**Page content.** The extension does not read, collect, store or transmit the content of the
pages you visit. Its content script reads the single word at the pointer position while you are
hovering with the modifier held, and renders a popup. It does not access form fields,
credentials, cookies or page text beyond that word.

**Settings.** Your preferences — server address, on/off state, modifier key, hover delay, where
search results open, whether the context-menu item is shown, the list of sites you have paused,
and the per-lookup limits — are stored by the browser's extension storage. On Chrome and
Firefox, settings stored in `storage.sync` are synchronised by **your browser**, under **your
browser account**, to your own devices. They are never sent anywhere else.

**Caches.** Lookup results, the server's dictionary list, and entry images and audio are cached
in memory and in the browser's local extension storage to avoid repeating requests. These caches
are bounded, live on your machine, and are removed when the extension is uninstalled.

## What the extension never does

- No analytics, telemetry, crash reporting, usage statistics or update pings.
- No advertising, no ad networks, no tracking pixels, no third-party scripts, no cookies set by
  the extension.
- No user accounts, no logins, no identifiers — the extension assigns no user ID, device ID or
  installation ID of any kind.
- No sale, rental or transfer of data to anyone. There is no data to transfer.
- No profiling, and no use of any information to determine creditworthiness or for lending.
- No remotely hosted code: everything the extension executes ships inside the package.

## Permissions and why they exist

| Permission | Use |
|---|---|
| `storage` | Save your settings and the bounded caches described above. |
| `contextMenus` | Add the "Look up … in wudict" item to the selection menu, and two items to the extension's own toolbar icon. |
| `offscreen` (Chrome) | Play pronunciation audio outside the visited page, so audio never enters the page's DOM. |
| Content script on all sites | Detect the word under your pointer wherever you read. Bounded as described above; pausable globally or per site. |
| Host permissions | **None.** The extension declares no host permission, optional or otherwise, and never asks for one. It reaches your wudict server because that server allows the extension by name, on read-only routes. |

## Children

The extension is not directed at children and collects no information from anyone, including
children under 13 (or the equivalent age in your jurisdiction).

## Your control

- Pause hover globally or per site from the toolbar panel at any time.
- Change or clear all settings from the options page.
- Uninstalling removes all stored settings and caches.
- Because nothing is collected, there is no data for the developer to access, export, correct or
  delete on your behalf; requests of that kind should be directed at your own wudict server,
  which stores your dictionaries locally.

## Third parties

None. The extension embeds no third-party service, SDK, font, script or endpoint. The wudict
server is separate open-source software that you run; it is covered by its own documentation at
https://github.com/wuweidict/wudict.

## Source

The extension is open source under the AGPL-3.0 licence. Every claim above is verifiable in the
code: https://github.com/wuweidict/wudict-browser-extension

## Changes

Any change to this policy will be published in the repository and reflected in the store
listings before the version it applies to is released. Material changes — in particular any
future transmission of data — will be stated in the extension's release notes and, on Firefox,
in the manifest's data-collection declaration.
