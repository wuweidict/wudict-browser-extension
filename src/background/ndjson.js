/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

// NDJSON transport for /api/dicts and /api/search.
//
// The contract defines two unrelated failure shapes and warns that neither check
// subsumes the other:
//
//   * before the stream starts — an ordinary HTTP error whose body is *plain* JSON
//     ({"error":"missing q parameter"}), not NDJSON;
//   * after it starts — status is already 200, so a per-dictionary failure rides on
//     that dictionary's own frame as an `error` field.
//
// `assertStreamStarted` is the first check; the second belongs to whoever switches
// on `t`, since the frame vocabulary differs per endpoint (`dict` vs `hit`).

/** A pre-stream failure: HTTP status plus the server's plain-JSON message. */
export class WudictHttpError extends Error {
  constructor(status, detail, url) {
    super(detail ? `wudict ${status}: ${detail}` : `wudict ${status}`);
    this.name = 'WudictHttpError';
    this.status = status;
    this.detail = detail;
    this.url = url;
  }
}

/**
 * Throw if the response is a pre-stream failure, reading the plain-JSON error body.
 * Must be called before handing the response to `readFrames`.
 */
export async function assertStreamStarted(response) {
  if (response.ok) return;
  let detail = '';
  try {
    const body = await response.json();
    if (body && typeof body.error === 'string') detail = body.error;
  } catch {
    // A non-JSON error body is still a failure; the status carries the meaning.
  }
  throw new WudictHttpError(response.status, detail, response.url);
}

/**
 * Yield one parsed object per line as it arrives, so the first dictionary can
 * render before the slowest one has opened.
 */
export async function* readFrames(response) {
  if (!response.body) throw new Error('response has no body to stream');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const frame = parseLine(line);
        if (frame !== null) yield frame;
      }
    }
    buffer += decoder.decode();
    // A final line without a trailing newline is still a frame.
    const frame = parseLine(buffer);
    if (frame !== null) yield frame;
  } finally {
    // Releasing the lock lets an abort tear the stream down promptly; the server
    // stops producing for an aborted request.
    reader.releaseLock();
  }
}

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (cause) {
    throw new Error(`malformed NDJSON line: ${truncate(trimmed)}`, { cause });
  }
}

function truncate(text, limit = 120) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
