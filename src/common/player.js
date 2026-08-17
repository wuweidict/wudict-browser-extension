/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

// Pronunciation playback, in whichever extension context has a DOM: Chrome's
// offscreen document, Firefox's background event page.
//
// Not `new Audio(blobUrl)` and not in the page. An <audio> element in the popup makes
// the *host page* the client of the request (the Local Network Access prompt, D69),
// and a blob URL would have to be minted, tracked and revoked in a tree that can be
// torn down mid-load. Decoding bytes we already hold has neither problem, and it is
// what Google Translate does for the same reason.
//
// One voice at a time: a second play stops the first. Two overlapping pronunciations
// are never what a click meant.

let context = null;
let source = null;

function audioContext() {
  const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!Ctor) throw new Error('this context has no AudioContext');
  if (!context || context.state === 'closed') context = new Ctor();
  return context;
}

function bytesFromBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Decode and play. `mime` is not used to pick a decoder — decodeAudioData sniffs the
 * container itself — it only makes the failure message legible.
 */
export async function play(b64, mime) {
  stop();

  const ctx = audioContext();
  // An offscreen document created for AUDIO_PLAYBACK may still start suspended.
  if (ctx.state === 'suspended') await ctx.resume();

  let buffer;
  try {
    buffer = await ctx.decodeAudioData(bytesFromBase64(b64).buffer);
  } catch (error) {
    throw new Error(`could not decode ${mime || 'audio'}: ${error.message}`);
  }

  const node = ctx.createBufferSource();
  node.buffer = buffer;
  node.connect(ctx.destination);
  node.onended = () => {
    if (source === node) source = null;
    node.disconnect();
  };
  source = node;
  node.start();
}

/** Idempotent: called on every popup teardown, whether anything is playing or not. */
export function stop() {
  if (!source) return;
  const node = source;
  source = null;
  node.onended = null;
  try {
    node.stop();
  } catch {
    // Already finished; stopping a spent source throws in some engines.
  }
  node.disconnect();
}

export function isPlaying() {
  return source !== null;
}
