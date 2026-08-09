/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

// Importing article HTML into the popup.
//
// `format=clean` has already dropped scripts, styles, link/iframe/object/form, every
// on* handler, and javascript:/vbscript:/protocol-relative URLs — and absolutised
// root-absolute /res/ paths. This is the second layer: an allowlist walk that never
// touches innerHTML, so a server bug or a mis-sent `format` cannot inject script
// into every page the user visits. The extension runs on <all_urls>; that makes this
// proportionate rather than paranoid.
//
// The Sanitizer API is deliberately not used — it is not in Firefox stable.

const ALLOWED_ELEMENTS = new Set([
  'a',
  'abbr',
  'audio',
  'b',
  'bdi',
  'bdo',
  'blockquote',
  'br',
  'caption',
  'cite',
  'code',
  'col',
  'colgroup',
  'dd',
  'del',
  'dfn',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'ins',
  'kbd',
  'li',
  'mark',
  'ol',
  'p',
  'pre',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'small',
  'source',
  'span',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'time',
  'tr',
  'u',
  'ul',
  'var',
  'wbr',
]);

// Dropped with their content, rather than unwrapped: their text is not definition
// text. Everything else unknown is unwrapped so nothing can silently swallow a
// definition.
const DROPPED_ELEMENTS = new Set([
  'script',
  'style',
  'link',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'template',
  'noscript',
  'meta',
  'title',
  'base',
]);

// `id` is kept on everything: format=clean preserves ids, and an in-article
// fragment link is the one shape that must scroll within the popup rather than
// open a tab. Without ids there is nothing to scroll to.
const GLOBAL_ATTRIBUTES = ['id'];

const ALLOWED_ATTRIBUTES = {
  a: ['title'],
  abbr: ['title'],
  audio: ['controls', 'preload'],
  img: ['alt', 'width', 'height'],
  source: ['type'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan', 'scope'],
  time: ['datetime'],
};

// Resolved separately, because they decide what the page is allowed to fetch.
const URL_ATTRIBUTES = { a: 'href', img: 'src', audio: 'src', source: 'src' };

/**
 * Convert article HTML into a DocumentFragment safe to attach to the popup.
 *
 * `serverOrigin` is the origin the lookup was answered from; media is allowed only
 * from there, which both catches a server that did not absolutise /res/ and stops a
 * dictionary from beaconing to a third party.
 */
export function sanitizeArticle(html, serverOrigin) {
  // An inert document: no script runs, no subresource is fetched while parsing.
  const parsed = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
  const fragment = document.createDocumentFragment();
  for (const child of [...parsed.body.childNodes]) {
    appendImported(fragment, child, serverOrigin);
  }
  return fragment;
}

function appendImported(parent, node, serverOrigin) {
  if (node.nodeType === Node.TEXT_NODE) {
    parent.appendChild(document.createTextNode(node.data));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const tag = node.tagName.toLowerCase();
  if (DROPPED_ELEMENTS.has(tag)) return;

  if (!ALLOWED_ELEMENTS.has(tag)) {
    // Unwrap: the tag goes, the text stays.
    for (const child of [...node.childNodes]) appendImported(parent, child, serverOrigin);
    return;
  }

  const element = document.createElement(tag);
  copyAttributes(element, node, tag, serverOrigin);
  applyElementPolicy(element, tag);

  for (const child of [...node.childNodes]) appendImported(element, child, serverOrigin);
  parent.appendChild(element);
}

function copyAttributes(element, source, tag, serverOrigin) {
  for (const name of [...GLOBAL_ATTRIBUTES, ...(ALLOWED_ATTRIBUTES[tag] ?? [])]) {
    const value = source.getAttribute(name);
    if (value !== null) element.setAttribute(name, value);
  }

  if (tag === 'a') {
    copyAnchor(element, source, serverOrigin);
    return;
  }

  const urlAttribute = URL_ATTRIBUTES[tag];
  if (!urlAttribute) return;

  const raw = source.getAttribute(urlAttribute);
  if (raw === null) return;

  const resolved = resolveUrl(raw, serverOrigin, tag);
  if (resolved !== null) element.setAttribute(urlAttribute, resolved);
}

/**
 * An anchor's original href is preserved verbatim in `data-ref` and classified at
 * click time, because the interesting ones are not URLs at all: `bword://run`,
 * `d:run`, a bare `defendant`, `#sense2`.
 *
 * `href` itself is set only for real http(s) targets, so the link has a hover
 * target and middle-click works. A bare href is deliberately NOT copied: in a
 * popup injected into someone else's page it would resolve against *that page's*
 * URL, navigating the host site — the same base-URL trap as the /res/ one,
 * arriving through a different door. Every click is cancelled regardless.
 */
function copyAnchor(element, source, serverOrigin) {
  const raw = source.getAttribute('href');
  if (raw === null) return;

  element.setAttribute('data-ref', raw);

  const resolved = resolveUrl(raw, serverOrigin, 'a');
  if (resolved === null) return;

  element.setAttribute('href', resolved);
  if (!resolved.startsWith(serverOrigin)) {
    element.setAttribute('target', '_blank');
    element.setAttribute('rel', 'noopener noreferrer');
  }
}

/**
 * Decide what a URL is allowed to become.
 *
 * Media must come from the wudict origin (or be an inline image). Links may point
 * anywhere on http(s) but open in a new tab. Fragment links are dropped outright:
 * inside a shadow root they would navigate the *host page*, which is the same class
 * of bug the contract describes for srcdoc iframes.
 */
export function resolveUrl(raw, serverOrigin, tag) {
  const value = raw.trim();
  if (value === '' || value.startsWith('#')) return null;

  let url;
  try {
    url = new URL(value, serverOrigin);
  } catch {
    return null;
  }

  if (tag === 'a') {
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  }

  // Inline images are self-contained and cost no request.
  if (url.protocol === 'data:') return value.startsWith('data:image/') ? value : null;

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.origin === serverOrigin ? url.href : null;
}

function applyElementPolicy(element, tag) {
  if (tag === 'img') {
    // A hover that is glanced at and dismissed should cost one request, not many.
    element.setAttribute('loading', 'lazy');
    element.setAttribute('decoding', 'async');
    return;
  }
  if (tag === 'audio') {
    element.setAttribute('controls', '');
    element.setAttribute('preload', 'none');
  }
}
