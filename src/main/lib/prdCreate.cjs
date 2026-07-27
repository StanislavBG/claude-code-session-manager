/**
 * prdCreate.cjs — PRD-body builder + create-prd admin HTTP route (PRD 549,
 * gh-issue-6; route consolidated here from the former standalone admin HTTP
 * server module by PRD 689). buildPrdBody/deriveSlugFromTitle/readStandards are pure
 * functions: no filesystem writes, no NN allocation, no HTTP. registerAdminRoute
 * owns orchestration (auth is the injected transport's job, cwd validation
 * via config.cjs's validatePath, NN allocation via the injected remote,
 * writing via remote.writePrd -> config.cjs's writeTextAtomic).
 *
 * Standards are read fresh from disk on every call (no in-process caching)
 * so a live edit to standards.md is picked up by the next create-prd call
 * without an app restart — same one-concept-one-implementation reasoning
 * that keeps the /develop skill re-reading it fresh per PRD (see SKILL.md).
 */
'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { schemas, PRD_CREATE_SLUG_RE } = require('../ipcSchemas.cjs');
const { kebabCase } = require('./kebabCase.cjs');
const config = require('../config.cjs');
const { expandHome } = require('./expandHome.cjs');
const { readBody, sendJson } = require('./localAdminHttp.cjs');

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

/**
 * Registers the create-prd admin HTTP route (PRD 689 — moved verbatim out of
 * the former standalone admin HTTP server module's handleRequest, no behavior
 * change) against an injected localAdminHttp.cjs transport. `remote` is
 * scheduler.cjs's remote object, passed explicitly (not required directly) so
 * this stays testable without booting Electron, matching that former
 * module's original dependency-injection pattern.
 */
function registerAdminRoute(adminHttp, remote) {
  adminHttp.registerRoute('POST', '/admin/scheduler/create-prd', async (req, res) => {
    const raw = await readBody(req);
    let parsed;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
      return;
    }

    let input;
    try {
      input = schemas.schedulerCreatePrd.parse(parsed);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: 'invalid PRD payload', details: e?.issues ?? e?.message });
      return;
    }

    // cwd is untrusted: this is the first *creating* mutation on a
    // token-authed API whose product is "a command that will later run
    // with --dangerously-skip-permissions in a chosen cwd". Route it
    // through config.cjs's validatePath (allowedRoots = home dir) —
    // same boundary every other fs-touching IPC handler uses — never a
    // bespoke check here.
    try {
      config.validatePath(expandHome(input.cwd));
    } catch (e) {
      sendJson(res, 400, { ok: false, error: `cwd rejected: ${e?.message ?? 'outside allowed roots'}` });
      return;
    }

    const slug = input.slug || deriveSlugFromTitle(input.title);
    if (!slug || !PRD_CREATE_SLUG_RE.test(slug)) {
      sendJson(res, 400, { ok: false, error: 'could not derive a valid kebab-case slug from title; supply "slug" explicitly' });
      return;
    }

    // NN allocation is delegated to allocateParallelGroup() (PRD 548) via
    // the injected remote — never re-derived here — unless the caller
    // opted into an existing group explicitly.
    const nn = input.parallelGroup ?? await remote.allocateParallelGroup();
    const filenameSlug = `${nn}-${slug}`;

    // An explicit `parallelGroup` bypasses allocateParallelGroup()'s
    // collision-proof reservation, so re-check for an existing file at
    // this exact destination before writing — remote.writePrd itself has
    // no existence guard (by design, it doubles as the edit-in-place
    // path for Scheduler UI PRD edits), so "create" must not silently
    // clobber an existing job's PRD.
    const existing = await remote.readPrd(filenameSlug);
    if (existing?.ok) {
      sendJson(res, 409, { ok: false, error: `PRD already exists: ${filenameSlug}.md` });
      return;
    }

    let standardsText;
    try {
      standardsText = await readStandards();
    } catch (e) {
      sendJson(res, 500, { ok: false, error: `could not read engineering standards: ${e?.message}` });
      return;
    }

    const body = buildPrdBody(input, standardsText);
    const writeResult = await remote.writePrd(filenameSlug, body);
    if (!writeResult?.ok) {
      sendJson(res, 500, { ok: false, error: writeResult?.error ?? 'write failed' });
      return;
    }

    sendJson(res, 200, { nn, filename: `${filenameSlug}.md`, status: 'queued' });
  });
}

module.exports = {
  PRD_CREATE_SLUG_RE,
  STANDARDS_PATH,
  readStandards,
  deriveSlugFromTitle,
  buildPrdBody,
  registerAdminRoute,
};
