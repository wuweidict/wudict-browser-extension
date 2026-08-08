// Firefox exposes the promise-based `browser`; Chrome 121+ returns promises from
// `chrome` too. One alias covers both without pulling in webextension-polyfill.
export const api = globalThis.browser ?? globalThis.chrome;
