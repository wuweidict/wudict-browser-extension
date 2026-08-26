/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

const shared = {
  globalThis: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  Response: 'readonly',
  ReadableStream: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
};

const rules = {
  'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  'no-undef': 'error',
  eqeqeq: ['error', 'always'],
  'prefer-const': 'error',
  'no-var': 'error',
};

export default [
  {
    // Extension code: WebExtension APIs plus the DOM surface used by the content
    // script. No node globals — these files never run under node.
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...shared,
        chrome: 'readonly',
        browser: 'readonly',
        document: 'readonly',
        window: 'readonly',
        location: 'readonly',
        navigator: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        Blob: 'readonly',
        CSS: 'readonly',
        Highlight: 'readonly',
        Range: 'readonly',
        DOMParser: 'readonly',
        Node: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        Audio: 'readonly',
        IntersectionObserver: 'readonly',
      },
    },
    rules,
  },
  {
    // Tests run under node:test.
    files: ['test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...shared,
        process: 'readonly',
        Buffer: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
      },
    },
    rules,
  },
  {
    // Build tooling runs under node.
    files: ['tools/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...shared, process: 'readonly', Buffer: 'readonly' },
    },
    rules,
  },
];
