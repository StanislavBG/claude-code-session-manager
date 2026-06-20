'use strict';

/**
 * kgLite.cjs — Heuristic knowledge-graph extraction (no LLM, no network).
 *
 * Exports `canonicalize` and `ENTITY_TYPES` as the shared vocabulary contract
 * (kg.cjs imports these so there is ONE definition for both paths), and
 * `liteExtract` which is the cheap alternative to the `claude -p` extractor.
 *
 * Precision vs LLM path:
 *   Higher precision on known-vocab entities (exact canonical-key match).
 *   Lower recall on novel entities — extracts capitalized phrases, quoted
 *   identifiers, CamelCase tokens, and tech keywords; misses entities stated
 *   only in plain lowercase prose. Relations are always generic `related_to`
 *   co-occurrences (no semantic labelling). A lite graph grows meaningfully
 *   but is sparser and less richly typed than the LLM path. Good for
 *   cost-sensitive setups where search/Q&A value matters but per-prompt
 *   claude -p cost does not.
 */

/** Canonical dedup key: lowercase, strip leading article, collapse whitespace.
 *  This function is the SINGLE definition shared with kg.cjs — any change here
 *  affects both extraction paths equally. */
function canonicalize(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?]+$/, '');
}

const ENTITY_TYPES = ['project', 'feature', 'tool', 'tech', 'concept', 'goal', 'person'];

// Tech terms that map directly to type 'tech' on first encounter.
const TECH_KEYWORDS = new Set([
  'react', 'electron', 'typescript', 'javascript', 'python', 'node', 'nodejs',
  'vite', 'tailwind', 'zustand', 'xterm', 'playwright', 'sqlite', 'postgres',
  'postgresql', 'redis', 'docker', 'kubernetes', 'webpack', 'esbuild', 'jest',
  'vitest', 'graphql', 'rest', 'api', 'http', 'https', 'websocket', 'pty',
  'ipc', 'mcp', 'git', 'npm', 'npx', 'pnpm', 'yarn', 'bash', 'zsh', 'curl',
  'json', 'yaml', 'tsx', 'jsx', 'cjs', 'esm', 'commonjs', 'llm', 'rag',
  'openai', 'anthropic', 'claude', 'oauth', 'jwt', 'cors',
]);

// File extensions that mark a quoted/path identifier as type 'tech'.
const TECH_EXTS = new Set([
  '.ts', '.tsx', '.cjs', '.mjs', '.js', '.jsx', '.py', '.go', '.rs', '.sh',
  '.md', '.json', '.yaml', '.yml', '.toml', '.env',
]);

// Common English words that appear capitalized at sentence start or as pronouns
// and are NOT meaningful developer-domain entities. Filter before adding.
const STOP_CAPS = new Set([
  'I', 'A', 'An', 'The', 'In', 'On', 'At', 'To', 'For', 'Of', 'With', 'By',
  'From', 'As', 'Is', 'Was', 'Are', 'Were', 'Be', 'Been', 'Have', 'Has', 'Had',
  'Do', 'Does', 'Did', 'Will', 'Would', 'Could', 'Should', 'May', 'Might',
  'Can', 'If', 'But', 'And', 'Or', 'Not', 'So', 'This', 'That', 'These',
  'Those', 'We', 'You', 'They', 'It', 'My', 'Your', 'Our', 'Its', 'Their',
  'When', 'Where', 'Who', 'What', 'How', 'Why', 'Which', 'Then', 'Just', 'Now',
  'Also', 'Here', 'There', 'Add', 'Get', 'Use', 'Run', 'Make', 'Fix', 'New',
  'Yes', 'No', 'Ok', 'Let', 'See', 'Set', 'Put', 'Try', 'Keep', 'Show', 'Go',
  'Tab', 'Now', 'Out', 'Up', 'Down', 'All', 'Any', 'Some', 'One', 'Two', 'Its',
]);

/** Infer entity type from surface form when not in known vocab. */
function inferType(raw) {
  const lower = raw.toLowerCase();
  if (TECH_KEYWORDS.has(lower)) return 'tech';
  const extM = raw.match(/(\.[a-zA-Z0-9]+)$/);
  if (extM && TECH_EXTS.has(extM[1].toLowerCase())) return 'tech';
  return 'concept';
}

/**
 * Heuristic entity/relation extraction — no network, no child_process.spawn.
 *
 * Algorithm per prompt (Time: O(W) for extraction, O(k²) for edges):
 *   1. Known-vocab scan: tokenize on whitespace/punctuation, look up each
 *      token and adjacent bigram in the vocab Map — O(W) with Map lookups.
 *   2. Multi-word capitalized phrases + acronyms (regex pass): "Knowledge
 *      Graph", "Session Manager", "PRD". Higher precision than singles.
 *   3. CamelCase identifiers (regex pass): `KnowledgeGraph`, `SchedulerDock`.
 *   4. Quoted identifiers (regex pass): `scheduler.cjs`, "lite mode".
 *   5. Single capitalized words (regex pass, STOP_CAPS filtered): "Scheduler".
 *   6. Co-occurrence edges among all entities found in the same prompt.
 *      O(k²) where k = distinct entities per prompt — typically < 10.
 *
 * Dedup: canonicalize() maps every surface form to the same key ("The
 * Scheduler" / "scheduler" / "Scheduler" all → key "scheduler"), so
 * entityMap never accumulates duplicates.
 *
 * @param {Array<{prompt:string,ts?:string}>} prompts
 * @param {Array<{key:string,name:string,type?:string}>} knownVocab  top-N nodes from the graph
 * @returns {{ entities: Array<{key,name,type,description}>, relations: Array<{src,dst,relation,description}> }}
 */
function liteExtract(prompts, knownVocab) {
  // O(V) build once; per-prompt lookups are O(1).
  const vocabByKey = new Map((knownVocab || []).map((n) => [n.key, n]));

  // Canonical key → entity — ensures no duplicates across the whole batch.
  const entityMap = new Map();

  function addEnt(raw, typeHint) {
    const key = canonicalize(raw);
    // Skip empty, pure-digit, or single-char keys.
    if (!key || key.length < 2 || /^\d+$/.test(key)) return null;
    if (!entityMap.has(key)) {
      const known = vocabByKey.get(key);
      const type = (known && ENTITY_TYPES.includes(known.type)) ? known.type
                 : ENTITY_TYPES.includes(typeHint) ? typeHint
                 : 'concept';
      entityMap.set(key, { key, name: known ? known.name : raw, type, description: '' });
    }
    return key;
  }

  const relationSet = new Set(); // "src relation dst" dedup key
  const relations = [];

  // Regexes used across prompts — reset lastIndex per prompt.
  // Multi-word capitalized phrase OR all-caps acronym (>=2 chars).
  const CAP_PHRASE_RE = /\b([A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)+|[A-Z]{2,})\b/g;
  // CamelCase: two or more capitalized segments joined without space.
  const CAMEL_RE = /\b([A-Z][a-z]+(?:[A-Z][a-z]*)+)\b/g;
  // Quoted identifier. Backreference \1 ensures the closing delimiter matches
  // the opening one — prevents "`foo` isn't" from closing the backtick-span
  // on the apostrophe in "isn't" and extracting a garbage entity.
  const QUOTED_RE = /([`"'])([^`"'\n]{2,40})\1/g;
  // Single capitalized word (Title Case, not an acronym — handled by CAP_PHRASE_RE).
  const CAP_WORD_RE = /\b([A-Z][a-z]{1,})\b/g;

  for (const p of prompts) {
    const text = String(p.prompt || '');
    const promptKeys = [];

    function record(key) {
      if (key && !promptKeys.includes(key)) promptKeys.push(key);
    }

    // 1. Known-vocab scan: split on whitespace + punctuation, check token and bigram.
    const tokens = text.split(/[\s,;:.!?()\[\]{}<>|/\\]+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      const k1 = canonicalize(tokens[i]);
      if (vocabByKey.has(k1)) record(addEnt(tokens[i], vocabByKey.get(k1).type));
      if (i + 1 < tokens.length) {
        const bigram = tokens[i] + ' ' + tokens[i + 1];
        const k2 = canonicalize(bigram);
        if (vocabByKey.has(k2)) record(addEnt(bigram, vocabByKey.get(k2).type));
      }
    }

    // 2. Multi-word capitalized phrases + acronyms — highest precision.
    let m;
    CAP_PHRASE_RE.lastIndex = 0;
    while ((m = CAP_PHRASE_RE.exec(text)) !== null) {
      if (!STOP_CAPS.has(m[1])) record(addEnt(m[1], inferType(m[1])));
    }

    // 3. CamelCase identifiers: KnowledgeGraph, SchedulerDock, etc.
    CAMEL_RE.lastIndex = 0;
    while ((m = CAMEL_RE.exec(text)) !== null) {
      record(addEnt(m[1], inferType(m[1])));
    }

    // 4. Quoted identifiers: `scheduler.cjs`, "lite mode", etc.
    QUOTED_RE.lastIndex = 0;
    while ((m = QUOTED_RE.exec(text)) !== null) {
      const raw = m[2].trim();
      if (raw.length >= 2) record(addEnt(raw, inferType(raw)));
    }

    // 5. Single capitalized words (mid-sentence entities like "Scheduler").
    //    STOP_CAPS filters common sentence-start words and English pronouns.
    CAP_WORD_RE.lastIndex = 0;
    while ((m = CAP_WORD_RE.exec(text)) !== null) {
      if (!STOP_CAPS.has(m[1])) record(addEnt(m[1], inferType(m[1])));
    }

    // Emit co-occurrence edges: O(k²) where k = promptKeys.length (typically <10).
    for (let i = 0; i < promptKeys.length; i++) {
      for (let j = i + 1; j < promptKeys.length; j++) {
        const ek = `${promptKeys[i]} related_to ${promptKeys[j]}`;
        if (!relationSet.has(ek)) {
          relationSet.add(ek);
          relations.push({ src: promptKeys[i], dst: promptKeys[j], relation: 'related_to', description: '' });
        }
      }
    }
  }

  return { entities: [...entityMap.values()], relations };
}

module.exports = { canonicalize, ENTITY_TYPES, liteExtract };
