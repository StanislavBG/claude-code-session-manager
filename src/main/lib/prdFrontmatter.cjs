/**
 * prdFrontmatter.cjs — minimal YAML frontmatter parser for scheduled PRD files.
 *
 * PRDs at `~/.claude/session-manager/scheduled-plans/prds/<NN>-<slug>.md` use
 * a small documented frontmatter subset (title, cwd, estimateMinutes,
 * parallelGroup, …). Two callers used to roll their own parser:
 *   - scheduler.cjs::parsePrdRaw — typed extraction of the known keys
 *   - queueOps.cjs::splitFrontmatter — linting; needs the raw map plus the
 *     line-count of the frontmatter region so warnings point at the right line
 *
 * This module owns the parse. Callers transform the raw map into whatever
 * typed shape they need.
 *
 * Format:
 *   ---
 *   key: value
 *   ---
 *   body…
 *
 * - Keys must match /^[A-Za-z][A-Za-z0-9_]*$/ (alpha first; alphanum + _).
 * - Values are read as strings; surrounding ' or " quotes are stripped.
 * - Missing or malformed frontmatter → { fm: {}, body: raw, fmLineCount: 0 }.
 */
'use strict';

function splitFrontmatter(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('---\n')) {
    return { fm: {}, body: raw, fmLineCount: 0 };
  }
  const end = raw.indexOf('\n---', 4);
  if (end === -1) return { fm: {}, body: raw, fmLineCount: 0 };
  const fmRaw = raw.slice(4, end);
  const fm = {};
  for (const line of fmRaw.split('\n')) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    fm[m[1]] = v;
  }
  return {
    fm,
    body: raw.slice(end + 4).replace(/^\n/, ''),
    // +2 for the two `---` fences themselves
    fmLineCount: fmRaw.split('\n').length + 2,
  };
}

module.exports = { splitFrontmatter };
