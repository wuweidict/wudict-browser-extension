/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

// The offscreen document's whole job: decode base64 audio the background already
// fetched, and play it. It holds no state the background does not, so the background
// closing it once playback has been idle for a while costs nothing.

import { api } from '../common/api.js';
import { play, stop } from '../common/player.js';
import { OFFSCREEN_PLAY, OFFSCREEN_STOP, OFFSCREEN_TARGET } from '../common/protocol.js';

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Every extension page receives every runtime message, so the target check is what
  // keeps the options page and the toolbar panel from answering for us.
  if (message?.target !== OFFSCREEN_TARGET) return false;

  if (message.type === OFFSCREEN_PLAY) {
    play(message.b64, message.mime).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, message: error.message }),
    );
    return true;
  }

  if (message.type === OFFSCREEN_STOP) {
    stop();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
