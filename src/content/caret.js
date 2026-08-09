/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

// Locating the text node and offset under the pointer.
//
// Two APIs with the same job: `caretPositionFromPoint` is the standard (Firefox,
// Chrome 128+), `caretRangeFromPoint` the older WebKit/Blink spelling.

import { extractTerm } from './words.js';

/** Deepest open shadow root under the point, so text inside components resolves. */
function deepestRoot(x, y) {
  let root = document;
  for (let depth = 0; depth < 10; depth += 1) {
    const element = root.elementFromPoint?.(x, y);
    // A closed shadow root is not reachable, and that is an accepted limitation.
    if (!element?.shadowRoot) return root;
    root = element.shadowRoot;
  }
  return root;
}

function rawCaret(root, x, y) {
  if (typeof root.caretPositionFromPoint === 'function') {
    const position = root.caretPositionFromPoint(x, y);
    if (position) return { node: position.offsetNode, offset: position.offset };
  }
  if (typeof root.caretRangeFromPoint === 'function') {
    const range = root.caretRangeFromPoint(x, y);
    if (range) return { node: range.startContainer, offset: range.startOffset };
  }
  return null;
}

function isFormField(node) {
  const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  const tag = element?.tagName;
  // caretPositionFromPoint returns the input itself rather than its internal text,
  // and caretRangeFromPoint does not descend into one at all. Skipped rather than
  // mirrored.
  return tag === 'INPUT' || tag === 'TEXTAREA' || element?.isContentEditable === true;
}

/**
 * The word under the point, with a Range covering exactly its characters.
 *
 * Returns null when the point is not over text. The rect check matters: both caret
 * APIs snap to the *nearest* position, so without it, hovering a page margin far
 * from any text still resolves to whatever word is closest.
 */
export function wordAtPoint(x, y) {
  const root = deepestRoot(x, y);
  const caret = rawCaret(root, x, y);
  if (!caret || caret.node?.nodeType !== Node.TEXT_NODE) return null;
  if (isFormField(caret.node)) return null;

  const found = extractTerm(caret.node.data, caret.offset);
  if (!found) return null;

  const range = document.createRange();
  try {
    range.setStart(caret.node, found.start);
    range.setEnd(caret.node, found.end);
  } catch {
    return null;
  }

  if (!rangeContainsPoint(range, x, y)) return null;

  return { term: found.term, range, node: caret.node, start: found.start, end: found.end };
}

function rangeContainsPoint(range, x, y) {
  for (const rect of range.getClientRects()) {
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true;
  }
  return false;
}

/** True when the point still falls inside a previously matched word. */
export function samePosition(previous, node, start, end) {
  return (
    previous !== null && previous.node === node && previous.start === start && previous.end === end
  );
}
