'use strict';

/**
 * prdDeclaredPaths.cjs — derive the file paths a PRD declares it touches, for
 * the reverify self-heal pass's widened evidence window (PRD 1102).
 *
 * Reuses definitionOfDone.cjs's existing `extractSection` (already the PRD
 * markdown section parser used by flagRiskySurfaces) rather than
 * re-implementing one — see standards.md's API-reuse rule.
 */

const fs = require('node:fs');
const { splitFrontmatter } = require('./prdFrontmatter.cjs');
const { extractSection } = require('./definitionOfDone.cjs');

// Backtick-quoted, extension-bearing relative paths, e.g. `src/main/scheduler.cjs`
// or `src/main/scheduler.cjs:490` (trailing :line dropped). Requires at least
// one `/` so bare identifiers like `npm` or `RESCANNABLE_VERDICTS` never match.
const PATH_RE = /`([a-zA-Z0-9_][\w.-]*(?:\/[\w.-]+)+\.[a-zA-Z0-9]+)(?::\d+)?`/g;

/**
 * Extract declared file paths from a PRD body (frontmatter already
 * stripped). Scans the `# Implementation notes` and `# Acceptance criteria`
 * sections only — the same sections flagRiskySurfaces and the PRD-authoring
 * convention already treat as where files-touched are named. Returns `[]`
 * (never fabricates a path) when neither section names one.
 *
 * @param {string} prdBody
 * @returns {string[]} deduped, in first-seen order
 */
function extractDeclaredPaths(prdBody) {
  if (!prdBody || typeof prdBody !== 'string') return [];
  const text = [
    extractSection(prdBody, 'Implementation notes'),
    extractSection(prdBody, 'Acceptance criteria'),
  ].join('\n');

  const paths = [];
  const seen = new Set();
  let m;
  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(text))) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      paths.push(m[1]);
    }
  }
  return paths;
}

/**
 * Read a PRD file and extract its declared paths. Never throws — a missing
 * or unreadable PRD (e.g. archived and swept) resolves to `[]`.
 *
 * @param {string|null} prdPath
 * @returns {string[]}
 */
function declaredPathsForPrd(prdPath) {
  if (!prdPath) return [];
  let raw;
  try {
    raw = fs.readFileSync(prdPath, 'utf8');
  } catch {
    return [];
  }
  const { body } = splitFrontmatter(raw);
  return extractDeclaredPaths(body);
}

module.exports = { extractDeclaredPaths, declaredPathsForPrd };
