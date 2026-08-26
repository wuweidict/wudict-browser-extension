/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

// The toolbar panel — what a click on the icon opens.
//
// Its job is to answer four questions in the time it takes to read them: is it on,
// can it reach wudict, does it apply here, and can I look something up right now.
// Everything else belongs on the options page, which is one click away in the
// footer. The rule for what earns a place here is "changed often, or needed when
// something is wrong" — the base URL and the dictionary list are neither.
//
// Nothing is rendered from a stored guess: the panel asks the worker for the whole
// state in one message and paints that, so it cannot disagree with the icon.

import { api } from '../common/api.js';
import { detectOs, foreignNote, keyChoices, OS } from '../common/keys.js';
import { setSettings } from '../common/settings.js';
import { HEALTH } from '../common/state.js';

const $ = (id) => document.getElementById(id);

let state = null;
// Resolved once before the first paint. The key names are wrong on two platforms
// out of three without it, so it is worth the one await.
let os = OS.LINUX;

// ------------------------------------------------------------------- plumbing

async function ask(message) {
  try {
    return await api.runtime.sendMessage(message);
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

async function load({ probe = false } = {}) {
  const result = await ask({ type: 'wudict:state', probe });
  if (!result?.ok) {
    setHealth('down', result?.message ?? 'The extension is not responding.');
    return;
  }
  state = result;
  render();
}

async function patch(values) {
  await setSettings(values);
  // Re-read rather than mutating the local copy: normalisation is the worker's,
  // and a clamped value must be what the panel shows.
  await load();
}

// -------------------------------------------------------------------- render

function render() {
  const { settings, host, health, view } = state;

  $('enabled').checked = settings.enabled;

  renderHealth(health, settings.baseUrl);
  renderModifier(settings.modifier);
  renderSite(host, view.site, settings.enabled);
  renderSearchHint(settings.searchTarget);

  // The document title is what a screen reader announces when the panel opens, and
  // it is free to make it say something true.
  document.title = view.title;
}

function renderHealth(health, baseUrl) {
  if (health.status === HEALTH.OK) {
    const dicts = state.dicts === null ? '' : ` · ${state.dicts} dictionaries`;
    setHealth('ok', `Connected · ${short(baseUrl)}${dicts}`);
  } else if (health.status === HEALTH.DOWN) {
    setHealth('down', downText(health.reason, baseUrl));
  } else {
    setHealth('', `Not checked · ${short(baseUrl)}`);
  }
  $('healthText').title = health.message || '';
}

/**
 * Three failures, three different fixes — "cannot reach" is only one of them and
 * saying it for the other two sends the user to look at the wrong thing.
 * `no-cors-grant` means wudict answered and refused *us*: a server too old to allow
 * extension origins, or a `BROWSER_EXTENSIONS` list this extension is not on. Both
 * are fixed on the server — update it. The tooltip carries the long form; this line
 * has one row.
 */
function downText(reason, baseUrl) {
  if (reason === 'no-cors-grant') return `${short(baseUrl)} is not answering extensions`;
  if (reason === 'http') return `${short(baseUrl)} returned an error`;
  return `Cannot reach ${short(baseUrl)}`;
}

function setHealth(kind, text) {
  $('dot').className = `dot${kind ? ` ${kind}` : ''}`;
  const label = $('healthText');
  label.textContent = text;
  label.className = `health-text${kind === 'down' ? ' bad' : ''}`;
}

function renderModifier(current) {
  const group = $('modifier');
  group.replaceChildren();

  const choices = keyChoices(os, current);
  for (const choice of choices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.role = 'radio';
    // Symbols on macOS, words elsewhere — the label is short by platform, the
    // accessible name is always the full one.
    button.textContent = choice.short;
    button.setAttribute('aria-label', choice.name);
    button.title = choice.name;
    button.setAttribute('aria-checked', String(choice.value === current));
    if (choice.foreign) button.classList.add('foreign');
    button.addEventListener('click', () => patch({ modifier: choice.value }));
    group.append(button);
  }

  // A key this platform cannot deliver, arrived over storage.sync from another
  // machine. Explained rather than silently rewritten: the stored value is shared,
  // and whichever computer was opened last must not get to reconfigure the others.
  const note = choices.some((choice) => choice.foreign) ? foreignNote(os, current) : null;
  $('modifierNote').textContent = note ?? '';
  $('modifierNote').hidden = note === null;
}

function renderSite(host, enabled, masterEnabled) {
  const box = $('site');
  const label = $('siteLabel');

  if (host === null) {
    // Not a failure: browser pages and the store cannot host a content script at
    // all, and pretending there is a switch to flip would be a lie.
    label.textContent = 'Not available on this page';
    box.checked = false;
    box.disabled = true;
    return;
  }

  label.textContent = host;
  box.checked = enabled;
  box.disabled = !masterEnabled;
  $('siteRow').title = masterEnabled
    ? `Hover lookup on ${host}`
    : 'Hover lookup is paused everywhere';
}

function renderSearchHint(target) {
  $('searchHint').textContent =
    target === 'popup'
      ? 'Opens in the hover popup on the current page.'
      : 'Opens the full wudict page, all dictionaries.';
}

/** Trim the scheme; the panel has 340px and the user knows what http is. */
function short(baseUrl) {
  return baseUrl.replace(/^https?:\/\//, '');
}

// ------------------------------------------------------------------- actions

$('enabled').addEventListener('change', (event) => patch({ enabled: event.target.checked }));

$('site').addEventListener('change', async () => {
  await ask({ type: 'wudict:toggleSite', tabId: state.tabId });
  await load();
});

$('retry').addEventListener('click', async () => {
  setHealth('', 'Checking…');
  await ask({ type: 'wudict:probe' });
  await load();
});

$('searchForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const term = $('term').value.trim();
  if (!term) return;
  const result = await ask({ type: 'wudict:search', term, tabId: state.tabId });
  if (!result?.ok) {
    setHealth('down', result?.message ?? 'Could not open the search.');
    return;
  }
  // The panel has done its job and the answer is elsewhere; leaving it open would
  // just cover the thing the user asked for.
  window.close();
});

$('openWudict').addEventListener('click', async () => {
  await ask({ type: 'wudict:open', url: state.settings.baseUrl, reuse: true });
  window.close();
});

$('options').addEventListener('click', () => {
  api.runtime.openOptionsPage();
  window.close();
});

// A probe on open is the point of the panel: a verdict from ten minutes ago is not
// an answer to "does it work now".
(async () => {
  os = await detectOs(api);
  await load({ probe: true });
})();
