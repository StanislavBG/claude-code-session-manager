/**
 * prdCreate.cjs — PRD-body builder for the create-prd admin route (PRD 549,
 * gh-issue-6). Pure functions only: no filesystem writes, no NN allocation,
 * no HTTP. adminServer.cjs owns orchestration (auth, cwd validation via
 * config.cjs's validatePath, NN allocation via the injected remote,
 * writing via remote.writePrd -> config.cjs's writeTextAtomic) so this
 * module stays trivially unit-testable.
 *
 * Standards are read fresh from disk on every call (no in-process caching)
 * so a live edit to standards.md is picked up by the next create-prd call
 * without an app restart — same one-concept-one-implementation reasoning
 * that keeps the /develop skill re-reading it fresh per PRD (see SKILL.md).
 */
'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { PRD_CREATE_SLUG_RE } = require('../ipcSchemas.cjs');
const { kebabCase } = require('./kebabCase.cjs');

const STANDARDS_PATH = path.join(
  __dirname, '..', '..', '..',
  'plugins', 'session-manager-dev', 'skills', 'develop', 'standards.md',
);

async function readStandards() {
  return fsp.readFile(STANDARDS_PATH, 'utf8');
}

/** Lowercase, kebab-case, strip anything outside [a-z0-9-], cap at 60 chars. */
function deriveSlugFromTitle(title) {
  return kebabCase(String(title), { maxLen: 60 });
}

/**
 * Build the full PRD markdown body (frontmatter + required sections +
 * verbatim engineering standards), matching the structure `/develop`'s
 * SKILL.md documents: frontmatter, then Goal / Acceptance criteria /
 * Implementation notes / Out of scope / Engineering standards, in order.
 */
function buildPrdBody(input, standardsText) {
  const {
    title, cwd, estimateMinutes, goal, acceptanceCriteria,
    implementationNotes, outOfScope,
  } = input;

  // No `parallelGroup` frontmatter key by convention (SKILL.md) — the NN-
  // filename prefix is the single source of truth for grouping; adding a
  // second one here would let the two drift out of sync.
  const fmLines = ['---', `title: ${title}`, `cwd: ${cwd}`, `estimateMinutes: ${estimateMinutes}`, '---', ''];

  const acLines = acceptanceCriteria.map((line) => `- [ ] ${line}`).join('\n');
  const oosSource = outOfScope && outOfScope.length ? outOfScope : ['(none)'];
  const oosLines = oosSource.map((line) => `- ${line}`).join('\n');

  const bodyLines = [
    '# Goal', '', goal, '',
    '# Acceptance criteria', '', acLines, '',
    '# Implementation notes', '', implementationNotes, '',
    '# Out of scope', '', oosLines, '',
    '## Engineering standards', '', standardsText.trimEnd(), '',
  ];

  return `${fmLines.join('\n')}${bodyLines.join('\n')}`;
}

module.exports = {
  PRD_CREATE_SLUG_RE,
  STANDARDS_PATH,
  readStandards,
  deriveSlugFromTitle,
  buildPrdBody,
};
