'use strict';
/**
 * mdDuplicates.cjs — dependency-free primitive that finds the same text written in two docs,
 * so a markdown-network scan can show where one fact lives more than once.
 *
 *   const { findDuplicates } = require('./mdDuplicates.cjs');
 *   findDuplicates([{ path, text }, ...], { runWords, minRuns, maxDocsPerRun })
 *     → [{ a, b, sharedRuns, samples, copy? }]   sorted by sharedRuns descending
 *
 * Method: each doc's text is normalized (fenced code blocks dropped, link/image targets dropped
 * with their visible text kept, markdown punctuation removed, lower-cased) into words. A "run"
 * is `runWords` consecutive words (default 8). A Map from run → doc indexes gives, per pair of
 * docs, the number of distinct runs they share. A pair is reported when sharedRuns >= `minRuns`
 * (default 10). Runs found in more than `maxDocsPerRun` docs (default 6) are boilerplate and
 * ignored. A pair whose shared runs cover >= 90% of the larger doc's runs is a full copy and
 * carries `copy: true`. `samples` holds up to 3 merged shared passages (the longest, in doc-a
 * order, from doc a's normalized words), each at most 200 chars.
 *
 * Bounds: at most LIMITS.maxDocs (2000) docs are read — extra docs are ignored; each doc's text
 * is truncated to LIMITS.maxDocBytes (256 KB, counted as 262144 UTF-16 chars) before
 * normalizing. Pure: no I/O, no globals mutated.
 */

const LIMITS = Object.freeze({ maxDocs: 2000, maxDocBytes: 256 * 1024 });
const DEFAULTS = Object.freeze({ runWords: 8, minRuns: 10, maxDocsPerRun: 6 });
const COPY_RATIO = 0.9;
const MAX_SAMPLES = 3;
const MAX_SAMPLE_CHARS = 200;

/**
 * @typedef {{ path: string, text: string }} Doc
 * @typedef {{ runWords?: number, minRuns?: number, maxDocsPerRun?: number }} DupOptions
 * @typedef {{ a: string, b: string, sharedRuns: number, samples: string[], copy?: true }} DupPair
 */

/**
 * Normalize markdown into lower-case words.
 * @param {string} text
 * @returns {string[]}
 */
function normalize(text) {
  const src = String(text == null ? '' : text).slice(0, LIMITS.maxDocBytes);
  const kept = [];
  /** @type {string|null} */
  let fence = null;
  for (const line of src.split(/\r?\n/)) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      continue;
    }
    if (m) { fence = m[1]; continue; }
    kept.push(line);
  }
  const body = kept
    .join('\n')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Inline links and images: keep the visible text, drop the target.
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Reference links: [text][ref] → text.
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    // Reference definitions: [ref]: target
    .replace(/^\s*\[[^\]]+\]:\s*\S.*$/gm, ' ')
    // Autolinks / bare URLs.
    .replace(/<[a-z][a-z0-9+.-]*:[^>\s]*>/gi, ' ')
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ');
  return body.split(' ').filter(Boolean);
}

/**
 * @param {unknown} v
 * @param {number} dflt
 * @param {string} name
 * @returns {number}
 */
function intOpt(v, dflt, name) {
  if (v === undefined || v === null) return dflt;
  if (!Number.isInteger(v) || /** @type {number} */ (v) < 1) {
    throw new TypeError(`findDuplicates: opts.${name} must be a positive integer`);
  }
  return /** @type {number} */ (v);
}

/**
 * Merge shared-run start positions into passages and render the longest few.
 * @param {string[]} words
 * @param {number[]} starts
 * @param {number} runWords
 * @returns {string[]}
 */
function samplesOf(words, starts, runWords) {
  const sorted = starts.slice().sort((x, y) => x - y);
  /** @type {Array<[number, number]>} */
  const spans = [];
  for (const s of sorted) {
    const last = spans[spans.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], s + runWords);
    else spans.push([s, s + runWords]);
  }
  return spans
    .map((sp, i) => ({ sp, i }))
    .sort((x, y) => (y.sp[1] - y.sp[0]) - (x.sp[1] - x.sp[0]) || x.i - y.i)
    .slice(0, MAX_SAMPLES)
    .sort((x, y) => x.i - y.i)
    .map(({ sp }) => {
      const s = words.slice(sp[0], sp[1]).join(' ');
      return s.length <= MAX_SAMPLE_CHARS ? s : s.slice(0, MAX_SAMPLE_CHARS);
    });
}

/**
 * Find pairs of docs that share the same text.
 * @param {Doc[]} docs
 * @param {DupOptions} [opts]
 * @returns {DupPair[]}
 */
function findDuplicates(docs, opts = {}) {
  const runWords = intOpt(opts.runWords, DEFAULTS.runWords, 'runWords');
  const minRuns = intOpt(opts.minRuns, DEFAULTS.minRuns, 'minRuns');
  const maxDocsPerRun = intOpt(opts.maxDocsPerRun, DEFAULTS.maxDocsPerRun, 'maxDocsPerRun');
  const list = Array.isArray(docs) ? docs.slice(0, LIMITS.maxDocs) : [];

  /** @type {string[][]} */
  const wordsOf = [];
  /** @type {number[]} distinct run count per doc */
  const runCount = [];
  /** @type {Map<string, Array<[number, number]>>} run → [docIndex, firstStart] */
  const runs = new Map();

  list.forEach((doc, di) => {
    const words = normalize(doc && doc.text);
    wordsOf.push(words);
    const seen = new Set();
    for (let i = 0; i + runWords <= words.length; i++) {
      const key = words.slice(i, i + runWords).join(' ');
      if (seen.has(key)) continue;
      seen.add(key);
      let hits = runs.get(key);
      if (!hits) runs.set(key, (hits = []));
      hits.push([di, i]);
    }
    runCount.push(seen.size);
  });

  /** @type {Map<string, { ai: number, bi: number, starts: number[] }>} */
  const pairs = new Map();
  for (const hits of runs.values()) {
    if (hits.length < 2 || hits.length > maxDocsPerRun) continue;
    for (let x = 0; x < hits.length; x++) {
      for (let y = x + 1; y < hits.length; y++) {
        const [ai, aStart] = hits[x];
        const [bi] = hits[y];
        const key = `${ai}:${bi}`;
        let p = pairs.get(key);
        if (!p) pairs.set(key, (p = { ai, bi, starts: [] }));
        p.starts.push(aStart);
      }
    }
  }

  /** @type {DupPair[]} */
  const out = [];
  for (const { ai, bi, starts } of pairs.values()) {
    const sharedRuns = starts.length;
    if (sharedRuns < minRuns) continue;
    /** @type {DupPair} */
    const pair = {
      a: String(list[ai].path),
      b: String(list[bi].path),
      sharedRuns,
      samples: samplesOf(wordsOf[ai], starts, runWords),
    };
    if (sharedRuns >= COPY_RATIO * Math.max(runCount[ai], runCount[bi])) pair.copy = true;
    out.push(pair);
  }
  out.sort((x, y) => y.sharedRuns - x.sharedRuns || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  return out;
}

module.exports = { findDuplicates, normalize, LIMITS, DEFAULTS };
