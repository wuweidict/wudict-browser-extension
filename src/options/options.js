/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

import { api } from '../common/api.js';
import { CAP_FOR_MODE, defaultSelection, labelFor } from '../common/dicts.js';
import {
  DEFAULTS,
  getSettings,
  normalizeBaseUrl,
  setSettings,
  withSiteRule,
} from '../common/settings.js';

const $ = (id) => document.getElementById(id);

const FIELDS = {
  enabled: 'checkbox',
  baseUrl: 'text',
  modifier: 'text',
  debounceMs: 'number',
  resultsPerDict: 'number',
  maxCandidates: 'number',
  dictLimit: 'number',
  searchTarget: 'text',
  contextMenu: 'checkbox',
};

let settings = null;
let registry = null;

// ------------------------------------------------------------------ permission

/**
 * Host permissions cannot be requested from the background — the prompt needs a
 * user gesture, which is exactly what this page has. On Firefox this is the only
 * way the extension ever gets to read a response, since MV3 does not grant
 * host_permissions at install.
 */
async function permissionOrigins(baseUrl) {
  return [`${new URL(baseUrl).origin}/*`];
}

async function hasPermission(baseUrl) {
  try {
    return await api.permissions.contains({ origins: await permissionOrigins(baseUrl) });
  } catch {
    return false;
  }
}

async function refreshGrantButton() {
  const button = $('grant');
  try {
    const granted = await hasPermission(settings.baseUrl);
    button.hidden = granted;
  } catch {
    button.hidden = true;
  }
}

$('grant').addEventListener('click', async () => {
  try {
    const granted = await api.permissions.request({
      origins: await permissionOrigins(settings.baseUrl),
    });
    setStatus($('status'), granted ? 'Access granted.' : 'Access denied.', granted);
    await refreshGrantButton();
    if (granted) await testConnection();
  } catch (error) {
    setStatus($('status'), error.message, false);
  }
});

// -------------------------------------------------------------------- settings

function readField(id) {
  const element = $(id);
  if (FIELDS[id] === 'checkbox') return element.checked;
  if (FIELDS[id] === 'number') return Number(element.value);
  return element.value;
}

function writeField(id, value) {
  const element = $(id);
  if (FIELDS[id] === 'checkbox') element.checked = Boolean(value);
  else element.value = value;
}

async function save(patch) {
  await setSettings(patch);
  settings = await getSettings();
}

for (const id of Object.keys(FIELDS)) {
  $(id).addEventListener('change', async () => {
    let value = readField(id);

    if (id === 'baseUrl') {
      try {
        value = normalizeBaseUrl(value);
      } catch (error) {
        setStatus($('status'), error.message, false);
        writeField('baseUrl', settings.baseUrl);
        return;
      }
    }

    await save({ [id]: value });
    // Normalisation may have clamped it; show what was actually stored.
    writeField(id, settings[id]);

    if (id === 'baseUrl') {
      // Ids derive from the server's paths, so a different server means a
      // different registry.
      registry = null;
      renderDicts();
      await refreshGrantButton();
      setStatus($('status'), 'Saved. Test the connection to load dictionaries.', null);
    }
  });
}

// ------------------------------------------------------------------ connection

async function testConnection() {
  setStatus($('status'), 'Testing…', null);
  const result = await api.runtime.sendMessage({ type: 'wudict:smoke' });
  if (result?.ok) {
    setStatus($('status'), result.message, true);
    await loadRegistry(false);
  } else {
    setStatus($('status'), result?.message ?? 'No response from the extension.', false);
  }
  await refreshGrantButton();
}

$('test').addEventListener('click', testConnection);

// ----------------------------------------------------------------- dictionaries

async function loadRegistry(refresh) {
  setStatus($('dictStatus'), refresh ? 'Refreshing…' : 'Loading…', null);
  const result = await api.runtime.sendMessage({ type: 'wudict:registry', refresh });
  if (!result?.ok) {
    setStatus($('dictStatus'), result?.message ?? 'Could not load the dictionary list.', false);
    return;
  }
  registry = result.registry;
  setStatus($('dictStatus'), `${registry.dicts.length} dictionaries`, true);
  renderDicts();
}

$('refresh').addEventListener('click', () => loadRegistry(true));

$('auto').addEventListener('click', async () => {
  await save({ dicts: [] });
  renderDicts();
});

// ----------------------------------------------------------------- site rules

/**
 * The paused-sites list is the only place an opt-out can be undone once the user
 * has left that site — the toolbar switch can only reach the tab in front of them.
 */
function renderSites() {
  const list = $('sites');
  list.replaceChildren();

  const hosts = Object.keys(settings.siteRules ?? {}).sort();
  if (hosts.length === 0) {
    list.append(note('No paused sites.'));
    return;
  }

  for (const host of hosts) {
    const item = document.createElement('li');
    const row = document.createElement('label');

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = host;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Resume';
    remove.addEventListener('click', async () => {
      await save(withSiteRule(settings, host, true));
      renderSites();
    });

    row.append(name, remove);
    item.append(row);
    list.append(item);
  }
}

function renderDicts() {
  const list = $('dicts');
  list.replaceChildren();

  if (!registry) {
    list.append(note('Test the connection to load the dictionary list.'));
    return;
  }

  const chosen = new Set(settings.dicts);
  const auto = new Set(
    chosen.size === 0
      ? defaultSelection(registry, { mode: 'exact', limit: settings.dictLimit })
      : [],
  );
  const cap = CAP_FOR_MODE.exact;

  for (const dict of registry.dicts) {
    const capable = dict.caps?.[cap] === true;
    const item = document.createElement('li');
    if (!capable) item.className = 'incapable';

    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = chosen.has(dict.id);
    box.disabled = !capable;
    box.addEventListener('change', () => toggleDict(dict.id, box.checked));

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = labelFor(registry, dict.id);

    const caps = document.createElement('span');
    caps.className = 'caps';
    caps.textContent = capable
      ? auto.has(dict.id)
        ? 'auto-selected'
        : `${formatEntries(dict.entries)} entries`
      : 'no exact lookup';

    label.append(box, name, caps);
    item.append(label);
    list.append(item);
  }
}

async function toggleDict(id, checked) {
  const chosen = new Set(settings.dicts);
  if (checked) chosen.add(id);
  else chosen.delete(id);

  // Persist in server order, which is also the order slots are rendered in.
  const ordered = registry.dicts.map((dict) => dict.id).filter((dictId) => chosen.has(dictId));
  await save({ dicts: ordered });
  renderDicts();
}

function formatEntries(count) {
  return typeof count === 'number' ? count.toLocaleString() : '—';
}

function note(message) {
  const item = document.createElement('li');
  const span = document.createElement('span');
  span.className = 'status';
  span.textContent = message;
  span.style.display = 'block';
  span.style.padding = '10px';
  item.append(span);
  return item;
}

function setStatus(element, message, ok) {
  element.textContent = message;
  element.className = `status${ok === true ? ' ok' : ok === false ? ' bad' : ''}`;
}

// ------------------------------------------------------------------- lifecycle

async function init() {
  settings = await getSettings();
  for (const id of Object.keys(FIELDS)) writeField(id, settings[id] ?? DEFAULTS[id]);
  await refreshGrantButton();
  renderSites();
  renderDicts();

  // The toolbar panel and the icon menu write the same settings; a page left open
  // must not keep showing what was true when it loaded.
  api.storage.onChanged.addListener(async (_changes, areaName) => {
    if (areaName !== 'sync') return;
    settings = await getSettings();
    for (const id of Object.keys(FIELDS)) writeField(id, settings[id] ?? DEFAULTS[id]);
    renderSites();
  });
  // Populate the list without forcing a network round trip if it is already stored.
  await loadRegistry(false);
}

init();
