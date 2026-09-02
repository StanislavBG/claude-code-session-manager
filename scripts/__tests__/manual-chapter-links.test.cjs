/**
 * manual-chapter-links.test.cjs — a chapter's in-document links must resolve.
 *
 * A chapter body is rendered in two very different places, and a bare
 * `href="#target"` has to work in both:
 *   · the offline HTML/PDF edition, where every chapter is one `<section
 *     id="<slug>">` on a single page (scripts/build-manual.mjs);
 *   · bilko.run/manual, where exactly ONE chapter is in the DOM at a time and
 *     the reader turns a `#<slug>` link into a chapter switch
 *     (~/Projects/Bilko/src/pages/ManualPage.tsx, handleArticleClick).
 * Both paths key off the chapter SLUG. A link to anything else — a heading id
 * that only exists in another chapter, a typo'd slug — is a dead click for a
 * paying reader in at least one of the two editions, and nothing else catches
 * it: the build validates files and slugs, never link targets.
 *
 * Run: timeout 120 npx vitest run scripts/__tests__/manual-chapter-links.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../..');
const MANUAL_DIR = path.join(REPO_ROOT, 'session-manager-operations/manual');
const CHAPTERS_DIR = path.join(MANUAL_DIR, 'chapters');

const MANIFEST = JSON.parse(fs.readFileSync(path.join(MANUAL_DIR, 'manual.json'), 'utf8'));
const SLUGS = new Set(MANIFEST.chapters.map((c) => c.slug));

/** Every `href="#..."` in every chapter, with the file it came from. */
const LINKS = [];
for (const chapter of MANIFEST.chapters) {
  const html = fs.readFileSync(path.join(CHAPTERS_DIR, chapter.file), 'utf8');
  const ownIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const m of html.matchAll(/href="#([^"]*)"/g)) {
    LINKS.push({ slug: chapter.slug, target: m[1], ownIds });
  }
}

test('every in-document chapter link points at a chapter slug (or an id in that same chapter)', () => {
  const dead = LINKS
    .filter((l) => !SLUGS.has(l.target) && !l.ownIds.has(l.target))
    .map((l) => `${l.slug}.html → #${l.target}`);
  expect(dead, `dead in-document link(s): ${dead.join(', ')}`).toEqual([]);
});

test('no chapter links to itself by slug — that scrolls nowhere in either edition', () => {
  const selfLinks = LINKS.filter((l) => l.target === l.slug).map((l) => `${l.slug}.html → #${l.target}`);
  expect(selfLinks, `self-referential chapter link(s): ${selfLinks.join(', ')}`).toEqual([]);
});
