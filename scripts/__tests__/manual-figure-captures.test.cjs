/**
 * manual-figure-captures.test.cjs — cross-file consistency tests for the
 * Field Manual's figure-capture pipeline (scripts/capture-manual-figures.mjs
 * + session-manager-operations/manual/figure-captures.json). The recipes
 * JSON and chapter HTML are read as text rather than imported (there's
 * nothing to import — they're data), but NAV_ITEMS is imported directly from
 * navGroups.ts, same as src/renderer/lib/__tests__/navGroupsHome.test.ts
 * does under this same vitest config — no need to regex-scrape it. Modelled
 * on src/main/__tests__/workTypeLibrary.test.cjs's cross-file text-assertion
 * technique.
 *
 * Run: timeout 120 npx vitest run scripts/__tests__/manual-figure-captures.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
import { NAV_ITEMS } from '../../src/renderer/lib/navGroups';
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../..');
const CHAPTERS_DIR = path.join(REPO_ROOT, 'session-manager-operations/manual/chapters');
const RECIPES_PATH = path.join(REPO_ROOT, 'session-manager-operations/manual/figure-captures.json');

/**
 * Figures whose surface the capture script (as written, with its fixed
 * Playwright launch args and no test-only state-injection hooks) cannot
 * currently produce, verified by reading the relevant source rather than
 * guessed:
 *   - simple-mode-cockpit: gated on `process.argv.includes('--simple')`
 *     (src/main/index.cjs, `app:launch-mode` handler) — the capture script's
 *     launchApp() passes a fixed args array with no `--simple`, and recipes
 *     have no field to inject launch flags.
 *   - voice-modal: two of its three callouts require `isRecording` to be
 *     true (MicActivityPanel's transcript line, SubmitCountdown's bar —
 *     src/renderer/components/layout/VoiceModal.tsx / SubmitCountdown.tsx),
 *     which only becomes true via a real getUserMedia() capture. There is
 *     no fake-audio device flag or test-mode bypass in this script or the
 *     app's IPC surface.
 *   - voice-recording-banner: RecordingStatus (src/renderer/components/
 *     RecordingStatus.tsx) is mounted only while `isRecording === true` —
 *     same real-microphone requirement as voice-modal, with no bypass.
 * Each one was deliberately left out of figure-captures.json rather than
 * given a recipe known to fail at capture time (a real run would still fail
 * loudly and safely — the script never fabricates a placement — but writing
 * a recipe we already know can't succeed serves no one). If the script ever
 * grows a way to launch with extra args or fake a recording, delete the
 * matching entry here and add a real recipe.
 */
const KNOWN_UNREACHABLE = new Set(['simple-mode-cockpit', 'voice-modal', 'voice-recording-banner']);

// Read once, reused by every test below.
const RECIPES = JSON.parse(fs.readFileSync(RECIPES_PATH, 'utf8'));
const RECIPE_KEYS = Object.keys(RECIPES).filter((k) => k !== '$comment');

const CHAPTER_FIGURES = []; // { figureId, arrows: string[] }
for (const file of fs.readdirSync(CHAPTERS_DIR)) {
  if (!file.endsWith('.html')) continue;
  const html = fs.readFileSync(path.join(CHAPTERS_DIR, file), 'utf8');
  for (const fm of html.matchAll(/<figure class="manual-figure" data-figure="([^"]+)">([\s\S]*?)<\/figure>/g)) {
    const [, figureId, inner] = fm;
    const arrows = [...inner.matchAll(/<span class="callout" data-arrow="(left|right|up|down)">(\d+)<\/span>/g)]
      .sort((a, b) => Number(a[2]) - Number(b[2]))
      .map((m) => m[1]);
    CHAPTER_FIGURES.push({ figureId, arrows });
  }
}
const DECLARED_IDS = new Set(CHAPTER_FIGURES.map((f) => f.figureId));

test('every declared <figure data-figure> has a recipe, or is documented as known-unreachable', () => {
  const missingRecipe = [...DECLARED_IDS].filter((id) => !RECIPE_KEYS.includes(id) && !KNOWN_UNREACHABLE.has(id));
  expect(missingRecipe, `figure(s) declared in a chapter but with no recipe and no KNOWN_UNREACHABLE entry: ${missingRecipe.join(', ')}`).toEqual([]);

  const staleUnreachable = [...KNOWN_UNREACHABLE].filter((id) => !DECLARED_IDS.has(id));
  expect(staleUnreachable, `KNOWN_UNREACHABLE entr(y/ies) for a figure no chapter declares any more: ${staleUnreachable.join(', ')}`).toEqual([]);
});

test('every recipe key corresponds to a declared <figure data-figure> (no orphan recipes)', () => {
  const orphanRecipes = RECIPE_KEYS.filter((k) => !DECLARED_IDS.has(k));
  expect(orphanRecipes, `recipe key(s) with no matching chapter figure: ${orphanRecipes.join(', ')}`).toEqual([]);
});

test('KNOWN_UNREACHABLE figures do not also have a recipe', () => {
  const overlap = [...KNOWN_UNREACHABLE].filter((id) => RECIPE_KEYS.includes(id));
  expect(overlap, `figure(s) both recipe'd and marked known-unreachable: ${overlap.join(', ')}`).toEqual([]);
});

test("every recipe's navKey (when present) is a real NAV_ITEMS key", () => {
  const validKeys = new Set(NAV_ITEMS.map((item) => item.key));
  expect(validKeys.size, 'sanity: NAV_ITEMS should be non-trivial').toBeGreaterThan(10);

  const bad = [];
  for (const [figureId, recipe] of Object.entries(RECIPES)) {
    if (figureId === '$comment') continue;
    if (recipe.navKey && !validKeys.has(recipe.navKey)) bad.push(`${figureId} -> navKey "${recipe.navKey}"`);
  }
  expect(bad, `recipe(s) with a navKey absent from NAV_ITEMS: ${bad.join(', ')}`).toEqual([]);
});

test('every recipe declares at least one callout', () => {
  const bad = [];
  for (const [figureId, recipe] of Object.entries(RECIPES)) {
    if (figureId === '$comment') continue;
    if (!Array.isArray(recipe.callouts) || recipe.callouts.length === 0) bad.push(figureId);
  }
  expect(bad, `recipe(s) with no callouts: ${bad.join(', ')}`).toEqual([]);
});

test("every recipe's callout count matches its chapter's <span class=\"callout\"> count, in order", () => {
  const bad = [];
  for (const { figureId, arrows } of CHAPTER_FIGURES) {
    const recipe = RECIPES[figureId];
    if (!recipe) continue; // covered by the coverage test above
    const recipeArrows = recipe.callouts.map((c) => c.arrow);
    if (JSON.stringify(arrows) !== JSON.stringify(recipeArrows)) {
      bad.push(`${figureId}: chapter arrows [${arrows.join(',')}] vs recipe arrows [${recipeArrows.join(',')}]`);
    }
  }
  expect(bad, bad.join('\n')).toEqual([]);
});
