#!/usr/bin/env node
/**
 * readability.mjs — makes "easy to read for a high-school diploma" a checkable
 * gate instead of a vibe. Converts a chapter's HTML to prose, scores it with
 * the Flesch-Kincaid grade formula, and (as a CLI) fails the build when any
 * chapter reads above the configured grade ceiling.
 *
 * Usage:
 *   node web/manual/readability.mjs                  # every chapter in manual.json
 *   node web/manual/readability.mjs --file <path>     # one HTML file
 *   node web/manual/readability.mjs --max <grade>      # grade ceiling (default 9.0)
 */

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = join(REPO, 'session-manager-operations', 'manual');

// Tags whose content is verbatim (code samples, keystrokes) and must not be
// scored as prose — dropped entirely, tag and content.
const VERBATIM_TAGS = ['pre', 'code', 'kbd'];

// Tags whose closing boundary marks the end of a sentence for scoring
// purposes, even when the source HTML has no terminal punctuation (e.g. a
// list item, a heading, a table cell).
const SENTENCE_BOUNDARY_TAGS = ['p', 'li', 'h1', 'h2', 'h3', 'td', 'th', 'dt', 'dd', 'aside'];

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  mdash: '—',
  rsquo: '’',
  nbsp: ' ',
};

function decodeEntities(text) {
  return text.replace(/&(amp|lt|gt|mdash|rsquo|nbsp);/g, (_, name) => ENTITIES[name]);
}

/** Convert chapter HTML into plain prose, with sentence-ending punctuation
 * inserted at block boundaries so a Flesch-Kincaid sentence count is sane. */
export function htmlToProse(html) {
  if (!html) return '';

  let text = html;
  for (const tag of VERBATIM_TAGS) {
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
  }

  // An <aside> may open mid-sentence with no preceding block tag, so mark
  // both its opening and closing boundary.
  text = text.replace(/<aside\b[^>]*>/gi, '.\n');
  const boundaryClose = SENTENCE_BOUNDARY_TAGS.join('|');
  text = text.replace(new RegExp(`<\\/(?:${boundaryClose})\\s*>`, 'gi'), '.\n');

  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  text = text.replace(/[ \t]+/g, ' ').trim();
  return text;
}

/** Count syllables in one word: lowercase, strip non-letters, count vowel
 * groups, drop a trailing silent "e" (but not "le"), minimum 1. */
export function countSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  const groups = w.match(/[aeiouy]+/g) || [];
  let count = groups.length;
  if (w.endsWith('e') && !w.endsWith('le')) count -= 1;
  return Math.max(count, 1);
}

function textStats(text) {
  const words = text.match(/\S+/g) || [];
  const sentences = text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  return { wordCount: words.length, sentenceCount: sentences.length, syllables };
}

/** Flesch-Kincaid grade level for a block of prose text. */
export function fleschKincaidGrade(text) {
  const { wordCount, sentenceCount, syllables } = textStats(text);
  if (wordCount === 0) return 0;
  const sentences = sentenceCount || 1;
  return 0.39 * (wordCount / sentences) + 11.8 * (syllables / wordCount) - 15.59;
}

/** Full analysis of one chapter's HTML: grade, word count, sentence count. */
export function analyzeChapter(html) {
  const prose = htmlToProse(html);
  const { wordCount, sentenceCount } = textStats(prose);
  return { grade: fleschKincaidGrade(prose), words: wordCount, sentences: sentenceCount };
}

function loadManifestChapters() {
  const manualJsonPath = join(SOURCE, 'manual.json');
  const manifest = JSON.parse(readFileSync(manualJsonPath, 'utf-8'));
  return manifest.chapters.map((c) => ({ label: c.file, path: join(SOURCE, 'chapters', c.file) }));
}

function runCli() {
  const argv = process.argv.slice(2);
  const fileFlagIdx = argv.indexOf('--file');
  const maxFlagIdx = argv.indexOf('--max');
  const maxGrade = maxFlagIdx >= 0 ? parseFloat(argv[maxFlagIdx + 1]) : 9.0;

  const targets =
    fileFlagIdx >= 0
      ? [{ label: argv[fileFlagIdx + 1], path: resolve(argv[fileFlagIdx + 1]) }]
      : loadManifestChapters();

  let anyOverLimit = false;
  for (const target of targets) {
    const html = readFileSync(target.path, 'utf-8');
    const { grade, words } = analyzeChapter(html);
    console.log(`${target.label}: grade ${grade.toFixed(1)}, ${words} words`);
    if (grade > maxGrade) anyOverLimit = true;
  }

  if (anyOverLimit) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
