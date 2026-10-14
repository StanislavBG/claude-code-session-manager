'use strict';

/**
 * Gathers the project's markdown network (root CLAUDE.md, the docs it links to,
 * every tracked scoped CLAUDE.md) and reports which docs already mention the
 * backticked terms a memory uses. Top-level in lib/ (sibling of memoryStale):
 * no domain subfolder fits. Pure apart from the injected `readFile`.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT_MAX_BYTES = 16 * 1024;
const MAX_DOCS = 60;
const MAX_SEARCH_BYTES = 200 * 1024;
const MAX_TERMS = 25;
const HITS_PER_DOC = 3;
const HITS_TOTAL = 8;
const MAX_LINE_CHARS = 200;

const MD_LINK_RE = /\]\(([^)\s]+\.md)(#[^)]*)?\)/g;
const TERM_RE = /`([^`\n]{4,80})`/g;
const ROOT_DOC = 'CLAUDE.md';

function defaultReadFile(p) {
  return fs.readFileSync(p, 'utf8');
}

function safeRead(readFile, abs) {
  try {
    const out = readFile(abs);
    return typeof out === 'string' ? out : null;
  } catch {
    return null;
  }
}

function extractLinkedDocs(rootText) {
  const out = [];
  let m;
  MD_LINK_RE.lastIndex = 0;
  while ((m = MD_LINK_RE.exec(rootText)) !== null) {
    const target = m[1];
    if (/^(?:https?|file):\/\//i.test(target)) continue;
    const norm = path.posix.normalize(target);
    if (norm.startsWith('..') || norm.startsWith('/')) continue;
    out.push(norm);
  }
  return out;
}

function extractTerms(body) {
  const seen = new Set();
  const out = [];
  let m;
  TERM_RE.lastIndex = 0;
  while ((m = TERM_RE.exec(body || '')) !== null) {
    if (out.length >= MAX_TERMS) break;
    const term = m[1].trim();
    if (term.length < 4 || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
  }
  return out;
}

function titleOf(text, fallback) {
  const m = /^# (.+?)\s*$/m.exec(text);
  return m ? m[1] : fallback;
}

/**
 * @param {{ cwd: string, memoryBody: string, trackedFiles: string[], readFile?: (p: string) => string }} args
 */
function collectMdNetwork({ cwd, memoryBody, trackedFiles, readFile = defaultReadFile }) {
  const tracked = new Set((trackedFiles || []).map((f) => path.posix.normalize(f)));
  const abs = (rel) => path.join(cwd, rel);

  const rootFull = safeRead(readFile, abs(ROOT_DOC)) ?? '';
  const rootClaudeMd = Buffer.byteLength(rootFull) > ROOT_MAX_BYTES
    ? Buffer.from(rootFull).subarray(0, ROOT_MAX_BYTES).toString('utf8')
    : rootFull;

  const paths = [];
  const add = (p) => {
    if (p !== ROOT_DOC && !paths.includes(p)) paths.push(p);
  };
  for (const p of extractLinkedDocs(rootFull)) if (tracked.has(p)) add(p);
  for (const p of tracked) if (path.posix.basename(p) === ROOT_DOC) add(p);

  const searchable = [{ path: ROOT_DOC, text: rootFull }];
  const docs = [];
  for (const rel of paths) {
    if (docs.length >= MAX_DOCS) break;
    const text = safeRead(readFile, abs(rel));
    if (text === null) continue;
    const bytes = Buffer.byteLength(text);
    docs.push({ path: rel, title: titleOf(text, rel), bytes });
    if (bytes <= MAX_SEARCH_BYTES) searchable.push({ path: rel, text });
  }

  const coverage = extractTerms(memoryBody).map((term) => {
    const hits = [];
    for (const doc of searchable) {
      if (hits.length >= HITS_TOTAL) break;
      let perDoc = 0;
      const lines = doc.text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (perDoc >= HITS_PER_DOC || hits.length >= HITS_TOTAL) break;
        if (!lines[i].includes(term)) continue;
        hits.push({ path: doc.path, line: i + 1, text: lines[i].trim().slice(0, MAX_LINE_CHARS) });
        perDoc++;
      }
    }
    return { term, hits };
  });

  return { rootClaudeMd, docs, coverage };
}

module.exports = { collectMdNetwork };
