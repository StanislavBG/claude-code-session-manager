'use strict';

/**
 * prdGateFiles.cjs — pure validate + render helpers for a PRD's `gate` and
 * `files` fields (gate-and-files-in-PRD-body unit).
 *
 * Why: 74% of parked jobs had no gate the scheduler could read. The planner
 * now declares the gate commands and the files list when it calls
 * scheduler_create_prd; prdCreate.cjs's createPrd() validates them with the
 * functions here, then renders them as two PRD body sections (`# Files`,
 * `# Gate`). `resolveGate`/`parseChain` in definitionOfDone.cjs already read
 * a fenced ```gate block back — renderGateSection's output must round-trip
 * through them unchanged (checked by createPrd(), not here).
 *
 * No I/O, no scheduler imports — pure string-in, string/array-out.
 */

const { parseChain } = require('./definitionOfDone.cjs');

const GATE_MIN_ENTRIES = 1;
const GATE_MAX_ENTRIES = 10;
const GATE_ENTRY_MAX_CHARS = 500;
const FILES_MIN_ENTRIES = 1;
const FILES_MAX_ENTRIES = 50;
const FILES_ENTRY_MAX_CHARS = 300;

const NONE_GATE_WARNING =
  'Gate is none: the scheduler cannot re-check this PRD. Use none only for docs or config with no runnable check.';

/** Cut a string to 80 chars for an error message, marking truncation with "…". */
function cut80(s) {
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

/** `<field> entry <n> ("<cut entry>"): <rule>` — the shared error-text shape. */
function entryError(field, index, entry, rule) {
  return `${field} entry ${index} ("${cut80(entry)}"): ${rule}`;
}

/**
 * True when `raw` (a parseChain step's original segment text) starts with
 * `timeout <seconds>` after the optional `TMPDIR=$(mktemp -d) ` prefix and
 * any leading `NAME=value` words — mirrors parseChain's own prefix-stripping
 * so the missing-timeout warning lines up with what parseChain actually ran.
 */
function stepStartsWithTimeout(raw) {
  let s = raw.trim().replace(/^TMPDIR=\$\(mktemp -d\)\s+/, '');
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(s)) {
    s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '');
  }
  return /^timeout\s+\d+(\s|$)/.test(s);
}

/**
 * Validate a PRD's `gate` field.
 *
 * @param {unknown} gate
 * @returns {{ok:true, commands:string[], warnings:string[]}|{ok:false, error:string}}
 *   commands is `['none']` for the opt-out, else the trimmed entries verbatim
 *   (one command chain per entry) — the exact strings renderGateSection and
 *   createPrd's read-back check both work from.
 */
function validateGate(gate) {
  if (!Array.isArray(gate) || gate.length < GATE_MIN_ENTRIES || gate.length > GATE_MAX_ENTRIES) {
    return {
      ok: false,
      error: `gate must have ${GATE_MIN_ENTRIES} to ${GATE_MAX_ENTRIES} entries (got ${Array.isArray(gate) ? gate.length : 0}).`,
    };
  }

  const trimmed = gate.map((e) => (typeof e === 'string' ? e.trim() : e));

  // Per-entry shape rules — run uniformly over every entry, including "none"
  // (it trivially satisfies all of them; the none/mixed semantics are a
  // separate check below).
  for (let i = 0; i < trimmed.length; i++) {
    const entry = trimmed[i];
    const idx = i + 1;
    if (typeof entry !== 'string' || entry.length === 0) {
      return { ok: false, error: `gate entry ${idx}: must be a non-empty string.` };
    }
    if (entry.length > GATE_ENTRY_MAX_CHARS) {
      return { ok: false, error: entryError('gate', idx, entry, `must be at most ${GATE_ENTRY_MAX_CHARS} chars.`) };
    }
    if (/[\r\n]/.test(entry)) {
      return { ok: false, error: entryError('gate', idx, entry, 'must not contain a newline.') };
    }
    if (entry.includes('```')) {
      return { ok: false, error: entryError('gate', idx, entry, 'must not contain a triple-backtick run (breaks the fence).') };
    }
    if (entry.startsWith('#')) {
      return { ok: false, error: entryError('gate', idx, entry, 'must not start with "#" — the fence parser drops lines starting with "#".') };
    }
    if (!parseChain(entry).length) {
      return {
        ok: false,
        error: entryError('gate', idx, entry, 'no pipes, redirects, ";", "&", backticks, "$(" or "${". Join steps with "&&".'),
      };
    }
  }

  // "none" semantics: alone it's the opt-out; mixed with anything else it's
  // an error (one PRD cannot be both "no gate" and "here is a gate").
  const noneIdx = trimmed.findIndex((e) => /^none$/i.test(e));
  if (noneIdx !== -1) {
    if (trimmed.length > 1) {
      return {
        ok: false,
        error: entryError(
          'gate', noneIdx + 1, trimmed[noneIdx],
          '"none" must be the only entry when used — remove the other entries or remove "none".',
        ),
      };
    }
    return { ok: true, commands: ['none'], warnings: [NONE_GATE_WARNING] };
  }

  // Missing-timeout warning (never rejects) — a step without one can hang
  // the run.
  const warnings = [];
  trimmed.forEach((entry, i) => {
    for (const step of parseChain(entry)) {
      if (!stepStartsWithTimeout(step.raw)) {
        warnings.push(
          `gate entry ${i + 1} step "${cut80(step.raw)}" does not start with "timeout <seconds>" — a step without a timeout can hang the run.`,
        );
      }
    }
  });

  return { ok: true, commands: trimmed, warnings };
}

/**
 * Validate a PRD's `files` field.
 *
 * @param {unknown} files
 * @returns {{ok:true, files:string[]}|{ok:false, error:string}}
 *   files is deduped (exact match, order preserved) with one leading `./`
 *   stripped per entry.
 */
function validateFiles(files) {
  if (!Array.isArray(files) || files.length < FILES_MIN_ENTRIES || files.length > FILES_MAX_ENTRIES) {
    return {
      ok: false,
      error: `files must have ${FILES_MIN_ENTRIES} to ${FILES_MAX_ENTRIES} entries (got ${Array.isArray(files) ? files.length : 0}).`,
    };
  }

  const seen = new Set();
  const out = [];
  for (let i = 0; i < files.length; i++) {
    const idx = i + 1;
    const original = files[i];
    if (typeof original !== 'string') {
      return { ok: false, error: `files entry ${idx}: must be a string.` };
    }
    const entry = original.trim();
    if (entry.length === 0) {
      return { ok: false, error: `files entry ${idx}: must not be empty.` };
    }
    if (entry.length > FILES_ENTRY_MAX_CHARS) {
      return { ok: false, error: entryError('files', idx, entry, `must be at most ${FILES_ENTRY_MAX_CHARS} chars.`) };
    }
    if (/[\r\n]/.test(entry)) {
      return { ok: false, error: entryError('files', idx, entry, 'must not contain a newline.') };
    }
    if (entry.startsWith('/') || entry.startsWith('~') || entry.startsWith('\\') || /^[A-Za-z]:/.test(entry)) {
      return { ok: false, error: entryError('files', idx, entry, 'must be repo-relative — absolute paths are not allowed.') };
    }
    if (entry.split('/').includes('..')) {
      return { ok: false, error: entryError('files', idx, entry, 'must not contain a ".." path segment.') };
    }
    if (entry.includes('*') || entry.includes('?')) {
      return { ok: false, error: entryError('files', idx, entry, 'must not contain "*" or "?" (no globs).') };
    }

    const normalized = entry.startsWith('./') ? entry.slice(2) : entry;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }

  return { ok: true, files: out };
}

/**
 * Render the `# Files` body section as an array of lines (joinable with
 * '\n' alongside the rest of buildPrdBody's bodyLines). `files` must already
 * be validated/normalized (validateFiles's output).
 *
 * @param {string[]} files
 * @returns {string[]}
 */
function renderFilesSection(files) {
  return [
    '# Files', '',
    'Change only these files. If the work needs another file, change it and say why in your report.',
    '',
    ...files.map((f) => `- ${f}`),
    '',
  ];
}

/**
 * Render the `# Gate` body section as an array of lines. `commandsOrNone`
 * must already be validated (validateGate's `commands` output) — either
 * `['none']` or the ordered command-chain strings to fence verbatim.
 *
 * @param {string[]} commandsOrNone
 * @returns {string[]}
 */
function renderGateSection(commandsOrNone) {
  const isNone = commandsOrNone.length === 1 && /^none$/i.test(commandsOrNone[0]);
  if (isNone) {
    return [
      '# Gate', '',
      'This PRD has no runnable check. Check each acceptance criterion by reading the files.',
      '',
      '```gate',
      'none',
      '```',
      '',
    ];
  }
  return [
    '# Gate', '',
    'Run these commands last, in order. Each must exit 0.',
    '',
    '```gate',
    ...commandsOrNone,
    '```',
    '',
  ];
}

module.exports = {
  validateGate,
  validateFiles,
  renderFilesSection,
  renderGateSection,
};
