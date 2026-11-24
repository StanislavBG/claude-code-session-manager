#!/usr/bin/env node
/**
 * residue-check.cjs — Stop-hook checker for the develop skill's rule 6
 * (No residue): a report hands back nothing an agent could do.
 *
 * findResidue(text) is a pure function returning at most MAX_LINES report
 * lines that hand work back without an outcome. Run as a script, it reads the
 * Stop hook JSON from stdin and, when residue is found in an Epic chat turn,
 * prints {"decision":"block","reason":...} once so the agent gives each line
 * an outcome. Every error fails open (exit 0, no output).
 *
 * Ships inside the plugin to other repos: CommonJS, Node built-ins only, no
 * dependency on src/main.
 */

'use strict';

const fs = require('node:fs');

const MAX_LINES = 5;
const DEADLINE_MS = 4500;
const TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;
// Mirrors chatRunner.cjs's STOP_SENTINEL (kept literal: no src/main dependency).
const NEEDS_INPUT_SENTINEL = '<<<SM_NEEDS_INPUT>>>';

// A label counts only when it is the WHOLE heading / bold label (optional trailing colon):
// '## Remaining budget' or '**Deferred to PRD 4100 (queued)**' are not residue labels.
const RESIDUE_LABEL_RE = /^(still open|open items|remaining|not covered|deferred|follow[- ]?ups?|left for later|gaps?|what happens next)\s*:?$/i;
const NEEDS_YOU_LABEL_RE = /^needs you\b/i;
// Quoted spans skipped by the phrase match: a report quoting a phrase is analysing it, not handing work back.
// A straight single quote opens only after a non-word char, so apostrophes (it's, haven't) never open one.
const QUOTED_SPAN_RES = [/"[^"\n]*"/g, /“[^”\n]*”/g, /‘[^’\n]*’/g, /`[^`\n]*`/g, /(^|[^\w'])'[^'\n]*'(?![\w])/g];
const RESIDUE_PHRASES = ['needs a new epic', 'say the word', "haven't queued", "didn't look into", 'follow-up for later',
  'one gap', 'left those to', 'i will add that', "i'll add that"];
// Each phrase as a whole-word, case-insensitive regex: 'one gap' must not fire on 'phone gap' / 'none gap'.
// An apostrophe counts as a word char at the bounds so "haven't" never matches inside a longer contraction.
const RESIDUE_PHRASE_RES = RESIDUE_PHRASES.map(
  (p) => new RegExp(`(?<![\\w'])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w'])`, 'i'));
// A line that names its own outcome (a PRD reference + an un-negated outcome verb) is not residue (rule 6).
// A PRD reference is 'PRD <n>' or an NNNN-kebab-slug (4300-fix-thing); a bare number, a year or a date
// (2026-11-23: a digit after the dash) is not one.
const PRD_REF_RES = [/\bPRD\s*#?\d+\b/i, /(?<![\w.-])\d{4}-[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?![\w-])/i];
const OUTCOME_VERB_RE = /\b(queued|closed|fixed|decided|scheduled)\b/gi;
// A negation anywhere before an outcome verb on the line ('not queued yet', "hasn't been fixed") voids the skip.
const NEGATION_RE = /(?<![\w'])(not|no|never|without|yet to|has not|hasn't|isn't)(?![\w'])/i;
const EMPTY_ENTRY_RE = /^(?:[-*+]\s*)?(?:none|nothing|n\/a)\.?$/i;

/** Lower-case and straighten curly apostrophes for phrase matching. */
function normalize(s) {
  return s.replace(/[‘’ʼ]/g, "'").toLowerCase();
}

/** True when a line carries its own outcome: a PRD reference and an outcome verb with no negation before it. */
function namesOwnOutcome(s) {
  const line = normalize(s);
  if (!PRD_REF_RES.some((re) => re.test(line))) return false;
  const verbs = [...line.matchAll(OUTCOME_VERB_RE)];
  if (!verbs.length) return false;
  // Strict: a negation before ANY outcome verb (so before the last one) leaves the line counted.
  const last = verbs[verbs.length - 1];
  return !NEGATION_RE.test(line.slice(0, last.index));
}

/** Remove quoted spans (double, curly, single, backtick) from a line before the phrase match. */
function stripQuoted(s) {
  let out = s;
  for (const re of QUOTED_SPAN_RES) out = out.replace(re, (m, lead) => (typeof lead === 'string' ? `${lead} ` : ' '));
  return out;
}

/** Strip markdown emphasis + trailing punctuation from a label. */
function cleanLabel(s) {
  return s.replace(/[*_`]/g, '').trim();
}

/** `**Label:** rest` / `__Label__ rest` at line start → { label, rest }; else null. */
function parseBoldLabel(trimmed) {
  const m = /^(?:[-*+]\s+)?(\*\*|__)(.+?)\1\s*:?\s*(.*)$/.exec(trimmed);
  if (!m) return null;
  return { label: cleanLabel(m[2]).replace(/:$/, '').trim(), rest: m[3].trim() };
}

/**
 * Find report lines that hand work back without an outcome.
 * @param {string} text
 * @returns {string[]} at most MAX_LINES trimmed lines
 */
function findResidue(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  const lines = text.split(/\r?\n/);
  let fence = null; // the fence marker while inside a code fence
  let section = null; // 'residue' | 'needs-you' | null
  let sectionKind = null; // 'heading' | 'bold'
  let prevBlank = false;

  for (const raw of lines) {
    if (out.length >= MAX_LINES) break;
    const trimmed = raw.trim();

    const fenceMatch = /^(```+|~~~+)/.exec(trimmed);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) { fence = fenceMatch[1]; continue; }
    if (trimmed.startsWith('>')) { prevBlank = false; continue; }
    if (!trimmed) { prevBlank = true; continue; }

    const heading = /^#{1,6}\s+(.*)$/.exec(trimmed);
    if (heading) {
      const label = cleanLabel(heading[1]);
      section = NEEDS_YOU_LABEL_RE.test(label) ? 'needs-you' : RESIDUE_LABEL_RE.test(label) ? 'residue' : null;
      sectionKind = 'heading';
      prevBlank = false;
      continue;
    }

    const bold = parseBoldLabel(trimmed);
    let lineCounts = false;
    let isLabelLine = false;
    if (bold && (NEEDS_YOU_LABEL_RE.test(bold.label) || RESIDUE_LABEL_RE.test(bold.label) || !bold.rest)) {
      section = NEEDS_YOU_LABEL_RE.test(bold.label) ? 'needs-you' : RESIDUE_LABEL_RE.test(bold.label) ? 'residue' : null;
      sectionKind = 'bold';
      isLabelLine = true;
      if (section === 'residue' && bold.rest && !EMPTY_ENTRY_RE.test(bold.rest)) lineCounts = true;
    } else if (sectionKind === 'bold' && prevBlank && !/^([-*+]|\d+[.)])\s/.test(trimmed) && !/^\s/.test(raw)) {
      // A bold-label section ends at a new, non-list paragraph.
      section = null;
      sectionKind = null;
    }
    prevBlank = false;

    if (section === 'needs-you') continue;
    if (!isLabelLine && section === 'residue' && !EMPTY_ENTRY_RE.test(trimmed)) lineCounts = true;
    if (!lineCounts && !trimmed.startsWith('|')) {
      // Markdown table rows and quoted spans are analysis, not hand-backs: skip them for the phrase match.
      const norm = normalize(stripQuoted(trimmed));
      if (RESIDUE_PHRASE_RES.some((re) => re.test(norm))) lineCounts = true;
    }
    if (lineCounts && namesOwnOutcome(trimmed)) lineCounts = false;
    if (lineCounts) out.push(trimmed);
  }
  return out;
}

/** True when the message ends with the needs-input sentinel followed by its JSON line. */
function endsWithNeedsInput(text) {
  if (typeof text !== 'string') return false;
  const idx = text.lastIndexOf(NEEDS_INPUT_SENTINEL);
  if (idx < 0) return false;
  const after = text.slice(idx + NEEDS_INPUT_SENTINEL.length).trim()
    .replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim();
  if (!after) return true;
  try {
    const v = JSON.parse(after);
    return v !== null && typeof v === 'object';
  } catch {
    return false;
  }
}

/** Text of the last assistant entry with text content in a JSONL transcript. */
function lastAssistantTextFromTranscript(file) {
  if (typeof file !== 'string' || !file) return '';
  const fd = fs.openSync(file, 'r');
  let buf;
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
  } finally {
    fs.closeSync(fd);
  }
  const lines = buf.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || entry.type !== 'assistant' || !entry.message) continue;
    const content = entry.message.content;
    if (typeof content === 'string') { if (content.trim()) return content; continue; }
    if (!Array.isArray(content)) continue;
    const text = content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
    if (text.trim()) return text;
  }
  return '';
}

function buildReason(found) {
  return [
    'No residue: this report hands back work without an outcome:',
    ...found.map((l) => `  > ${l}`),
    'Give each one an outcome: queue a PRD (name its slug), decide it with a one-line revert, '
      + 'schedule it with its trigger (a dependsOn, a preflight hold or a date), or close it with a reason. '
      + "Put a step only the human can do under 'Needs you' as one exact action. Then end the turn again.",
  ].join('\n');
}

/** Decide from the parsed Stop input + env. Returns the JSON to print, or null. */
function evaluate(input, env) {
  if (!env.SM_CHAT_SESSION_ID) return null;
  // Scheduled claude -p jobs (scheduler.cjs childEnv) set SM_SCHEDULER_JOB_SLUG; they never set SM_CHAT_SESSION_ID
  // themselves but may inherit it, so the job marker wins.
  if (env.SM_SCHEDULER_JOB_SLUG || env.SM_SCHEDULER_JOB_EPIC_ID) return null;
  if (env.SM_RESIDUE_CHECK === '0') return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (input.stop_hook_active === true) return null;
  let text = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
  if (!text.trim()) text = lastAssistantTextFromTranscript(input.transcript_path);
  if (!text.trim() || endsWithNeedsInput(text)) return null;
  const found = findResidue(text);
  if (!found.length) return null;
  return { decision: 'block', reason: buildReason(found) };
}

function main() {
  const timer = setTimeout(() => process.exit(0), DEADLINE_MS);
  timer.unref();
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    try {
      const raw = Buffer.concat(chunks).toString('utf8');
      const result = evaluate(JSON.parse(raw), process.env);
      if (result) process.stdout.write(JSON.stringify(result) + '\n');
    } catch {
      // fail open
    }
    process.exitCode = 0;
  });
}

module.exports = { findResidue, endsWithNeedsInput, lastAssistantTextFromTranscript, evaluate, MAX_LINES };

if (require.main === module) {
  try { main(); } catch { process.exit(0); }
}
