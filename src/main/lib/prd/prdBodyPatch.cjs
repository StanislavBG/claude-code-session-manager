'use strict';
/**
 * prdBodyPatch.cjs — pure structured patch of a PRD body. Replaces only the
 * `# Gate`, `# Files` and/or `# Acceptance criteria` sections, validating and
 * rendering gate/files with the same prdGateFiles.cjs functions createPrd uses.
 * No I/O.
 */

const { validateGate, validateFiles, renderFilesSection, renderGateSection } = require('./prdGateFiles.cjs');
const { resolveGate, parseChain, isNoneGate } = require('../scheduler/definitionOfDone.cjs');

const H_AC = '# Acceptance criteria';
const H_FILES = '# Files';
const H_GATE = '# Gate';
const H_NOTES = '# Implementation notes';
const H_STANDARDS = '## Engineering standards';

/** Locate a heading's span [start, end) in lines, ignoring fenced code. */
function findSection(lines, heading) {
  let inFence = false;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (start === -1) {
      if (line === heading) start = i;
    } else if (/^#{1,2} /.test(line)) {
      return { start, end: i };
    }
  }
  return start === -1 ? null : { start, end: lines.length };
}

function findHeadingIndex(lines, heading) {
  const s = findSection(lines, heading);
  return s ? s.start : -1;
}

function replaceSection(lines, heading, rendered, insertBeforeHeadings) {
  const span = findSection(lines, heading);
  if (span) {
    lines.splice(span.start, span.end - span.start, ...rendered);
    return;
  }
  let at = lines.length;
  for (const h of insertBeforeHeadings) {
    const idx = findHeadingIndex(lines, h);
    if (idx !== -1) { at = idx; break; }
  }
  lines.splice(at, 0, ...rendered);
}

function gateSignature(body) {
  const r = resolveGate(body);
  return JSON.stringify([r.source, r.sequence]);
}

/**
 * @param {string} body
 * @param {{gate?: string[], files?: string[], acceptanceCriteria?: string[]}} patch
 * @returns {{ok:true, body:string, warnings:string[]}|{ok:false, error:string}}
 */
function applyStructuredPrdPatch(body, patch) {
  if (typeof body !== 'string') return { ok: false, error: 'body must be a string.' };
  if (!patch || typeof patch !== 'object') return { ok: false, error: 'patch must be an object.' };
  const hasGate = patch.gate !== undefined;
  const hasFiles = patch.files !== undefined;
  const hasAc = patch.acceptanceCriteria !== undefined;
  if (!hasGate && !hasFiles && !hasAc) {
    return { ok: false, error: 'patch must name at least one of gate, files, acceptanceCriteria.' };
  }

  let warnings = [];
  let gateCommands = null;
  let filesList = null;
  let acLines = null;

  if (hasGate) {
    const g = validateGate(patch.gate);
    if (!g.ok) return { ok: false, error: g.error };
    gateCommands = g.commands;
    warnings = warnings.concat(g.warnings || []);
  }
  if (hasFiles) {
    const f = validateFiles(patch.files);
    if (!f.ok) return { ok: false, error: f.error };
    filesList = f.files;
  }
  if (hasAc) {
    const ac = patch.acceptanceCriteria;
    if (!Array.isArray(ac) || ac.length === 0) {
      return { ok: false, error: 'acceptanceCriteria must be a non-empty array of strings.' };
    }
    acLines = [];
    for (let i = 0; i < ac.length; i++) {
      if (typeof ac[i] !== 'string' || ac[i].trim() === '') {
        return { ok: false, error: `acceptanceCriteria entry ${i + 1}: must be a non-empty string.` };
      }
      if (/[\r\n]/.test(ac[i])) {
        return { ok: false, error: `acceptanceCriteria entry ${i + 1}: must not contain a newline.` };
      }
      acLines.push(`- [ ] ${ac[i].trim()}`);
    }
  }

  const lines = body.split('\n');
  if (hasAc) {
    if (!findSection(lines, H_AC)) return { ok: false, error: `body has no "${H_AC}" section to patch.` };
    replaceSection(lines, H_AC, [H_AC, '', ...acLines, ''], []);
  }
  if (hasFiles) {
    replaceSection(lines, H_FILES, renderFilesSection(filesList), [H_NOTES, H_STANDARDS]);
  }
  if (hasGate) {
    replaceSection(lines, H_GATE, renderGateSection(gateCommands), [H_STANDARDS]);
  }
  const next = lines.join('\n');

  // Read-back with the scheduler's own reader, as createPrd does.
  if (hasGate) {
    const expectedSource = gateCommands.length === 1 && isNoneGate(gateCommands[0]) ? 'none' : 'explicit';
    const expectedSequence = expectedSource === 'none' ? [] : gateCommands.flatMap(parseChain);
    const resolved = resolveGate(next);
    if (resolved.source !== expectedSource || JSON.stringify(resolved.sequence) !== JSON.stringify(expectedSequence)) {
      return {
        ok: false,
        error: 'The PRD text holds another gate fence (three backticks + gate) outside the # Gate section, so the scheduler would read the wrong gate. Remove it and retry.',
      };
    }
  } else if (gateSignature(next) !== gateSignature(body)) {
    return { ok: false, error: 'The patch would change how the scheduler reads the PRD gate (stray gate fence in the new text).' };
  }

  return { ok: true, body: next, warnings };
}

module.exports = { applyStructuredPrdPatch };
