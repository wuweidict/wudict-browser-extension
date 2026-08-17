/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: agpl
 */

// Verify that every relative import in a built extension resolves to a real file,
// and that manifest-referenced entry points exist.
//
// A mistyped relative path makes an MV3 service worker fail to register with an
// error that names neither the file nor the specifier, so this is worth catching at
// build time rather than in a browser console.
//
// Usage: node tools/check-imports.mjs dist/chrome

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('usage: check-imports.mjs <built-extension-dir>');
  process.exit(2);
}

const IMPORT_RE = /(?:^|[\s;{}(])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /(?:^|[\s;{}(])import\s*['"]([^'"]+)['"]/g;

async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else if (entry.name.endsWith('.js')) found.push(path);
  }
  return found;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const problems = [];

// Entry points named by the manifest must exist.
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const entryPoints = [
  manifest.background?.service_worker,
  ...(manifest.background?.scripts ?? []),
  ...(manifest.content_scripts ?? []).flatMap((cs) => [...(cs.js ?? []), ...(cs.css ?? [])]),
  manifest.options_ui?.page,
  manifest.action?.default_popup,
  // Named by no manifest field: the background opens it through
  // `offscreen.createDocument({url})`, so a rename would fail only at the moment a
  // user clicks the speaker button. Checked here on the Chrome build alone —
  // Firefox's background is a real page and plays the audio itself.
  manifest.permissions?.includes('offscreen') ? 'offscreen/offscreen.html' : null,
].filter(Boolean);

for (const entry of entryPoints) {
  if (!(await exists(join(root, entry)))) {
    problems.push(`manifest.json references a missing file: ${entry}`);
  }
}

// Every relative specifier must resolve. Bare specifiers would need a bundler, so
// they are a hard error in a no-bundler build.
for (const file of await walk(root)) {
  const source = await readFile(file, 'utf8');
  const specifiers = [
    ...[...source.matchAll(IMPORT_RE)].map((m) => m[1]),
    ...[...source.matchAll(BARE_IMPORT_RE)].map((m) => m[1]),
  ];

  for (const specifier of specifiers) {
    const where = relative(root, file);
    if (specifier.startsWith('.')) {
      const target = resolve(dirname(file), specifier);
      if (!(await exists(target))) {
        problems.push(`${where}: unresolved import '${specifier}'`);
      }
    } else if (!specifier.startsWith('/')) {
      problems.push(
        `${where}: bare import '${specifier}' cannot resolve without a bundler`,
      );
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(`  ${problems.length} import problem(s) in ${root}`);
  process.exit(1);
}

console.log(`  imports ok (${entryPoints.length} entry point(s))`);
