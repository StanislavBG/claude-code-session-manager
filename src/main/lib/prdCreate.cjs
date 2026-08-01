/**
 * prdCreate.cjs — PRD-body builder + create-prd admin HTTP route (PRD 549,
 * gh-issue-6; route consolidated here from the former standalone admin HTTP
 * server module by PRD 689). buildPrdBody/deriveSlugFromTitle/readStandards are pure
 * functions: no filesystem writes, no NN allocation, no HTTP. registerAdminRoute
 * owns orchestration (auth is the injected transport's job, cwd validation
 * via config.cjs's validatePath, NN allocation via the injected remote,
 * writing via remote.writePrd -> config.cjs's writeTextAtomic).
 *
 * Neither this route nor the /develop skill embeds standards.md's contents
 * anymore — both just point the headless executor at STANDARDS_PATH with an
 * instruction to read it before starting. There's nothing to go stale: the
 * executor always reads the live file at run time, same one-concept-one-
 * implementation reasoning that keeps the two PRD-creation paths in sync
 * (see SKILL.md).
 */
'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { schemas, PRD_CREATE_SLUG_RE } = require('../ipcSchemas.cjs');
const { kebabCase } = require('./kebabCase.cjs');
const config = require('../config.cjs');
const { expandHome } = require('./expandHome.cjs');
const { readBody, sendJson } = require('./localAdminHttp.cjs');
const { readActiveIndex } = require('./epicMint.cjs');

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
 * Build the full PRD markdown body (frontmatter + required sections + a
 * pointer at the engineering standards file), matching the structure
 * `/develop`'s SKILL.md documents: frontmatter, then Goal / Acceptance
 * criteria / Implementation notes / Out of scope / Engineering standards,
 * in order.
 */
function buildPrdBody(input) {
  const {
    title, cwd, estimateMinutes, goal, acceptanceCriteria,
    implementationNotes, outOfScope, sourcePromptId, sourceTabId, tag, dependsOn,
  } = input;

  // No `parallelGroup` frontmatter key by convention (SKILL.md) — the NN-
  // filename prefix is the single source of truth for grouping; adding a
  // second one here would let the two drift out of sync.
  const fmLines = ['---', `title: ${title}`, `cwd: ${cwd}`, `estimateMinutes: ${estimateMinutes}`];
  // Optional, additive: traces this PRD back to the PromptTicket (PRD 748)
  // that was classified 'develop' and spawned it (PRD 749).
  if (sourcePromptId) fmLines.push(`sourcePromptId: ${sourcePromptId}`);
  // Optional, additive: the tab that queued this PRD, read back by
  // scheduler.cjs at job completion (PRD 761) to route a status prompt.
  if (sourceTabId) fmLines.push(`sourceTabId: ${sourceTabId}`);
  // Optional, additive: the user-selected Feature/Bug tag (PRD 774) carried
  // through from the originating PromptTicket — deterministic, never LLM-classified.
  if (tag) fmLines.push(`tag: ${tag}`);
  // Explicit ordering (PRD 832): replaces the retired shared-NN convention.
  if (dependsOn && dependsOn.length) fmLines.push(`dependsOn: [${dependsOn.join(', ')}]`);
  fmLines.push('---', '');

  const acLines = acceptanceCriteria.map((line) => `- [ ] ${line}`).join('\n');
  const oosSource = outOfScope && outOfScope.length ? outOfScope : ['(none)'];
  const oosLines = oosSource.map((line) => `- ${line}`).join('\n');

  const standardsPointer = [
    `Before writing any code, read \`${STANDARDS_PATH}\` — it has the Performance, Debugging,`,
    'API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is',
    'mandatory, especially Execution discipline (bounded commands, verify before done, the',
    'finish-protocol sentinel).',
  ].join('\n');

  const bodyLines = [
    '# Goal', '', goal, '',
    '# Acceptance criteria', '', acLines, '',
    '# Implementation notes', '', implementationNotes, '',
    '# Out of scope', '', oosLines, '',
    '## Engineering standards', '', standardsPointer, '',
  ];

  return `${fmLines.join('\n')}${bodyLines.join('\n')}`;
}

/**
 * Best-effort fallback for a PRD queued via the scheduler_create_prd MCP tool
 * from inside an Epic's own headless chat session, when the model's tool
 * call omitted `sourcePromptId` — the exact gap that let PRDs 866/867 mint
 * two unrelated sibling Epics instead of joining the Epic that was actually
 * driving the conversation (2026-08-01). `claudeSessionId` is this process's
 * `originClaudeSessionId` input (chatRunner.cjs's SM_CHAT_SESSION_ID env var,
 * inherited down to the MCP server child); looked up against `cwd`'s
 * active-index.json for the Epic whose own claudeSessionId matches (domain
 * model: Epic:claude-session is 1:1). Returns null for a non-Epic tab (plain
 * SessionTab chat) or when the id is stale/unknown — never throws, since this
 * is strictly a convenience default and a miss must fall back to minting a
 * normal Epic exactly like today.
 */
function resolveSourcePromptIdFromClaudeSession(cwd, claudeSessionId) {
  if (!claudeSessionId) return null;
  const { sessions } = readActiveIndex(cwd);
  for (const session of Object.values(sessions)) {
    if (session && session.claudeSessionId === claudeSessionId) return session.id;
  }
  return null;
}

/**
 * Core create-PRD orchestration: cwd validation, slug derivation, NN
 * allocation, existing-file collision check, body build, write. Shared by
 * both the admin HTTP route (registerAdminRoute, used by the MCP tool) and
 * the renderer-facing IPC handler (chat:create-prd, index.cjs) so the
 * validation/write logic lives in exactly one place (API-reuse standard).
 * `input` must already be schema-validated by the caller (schemas.schedulerCreatePrd).
 * `remote` is scheduler.cjs's remote object (allocateParallelGroup/readPrd/writePrd).
 *
 * Returns `{ ok: true, nn, filename }` on success, or `{ ok: false, status, error }`
 * on failure — `status` is the HTTP status code the caller should map errors to
 * (400/409/500), left to the caller since only the HTTP route needs it.
 */
async function createPrd(input, remote) {
  // cwd is untrusted: this is the first *creating* mutation on a
  // token-authed API whose product is "a command that will later run
  // with --dangerously-skip-permissions in a chosen cwd". Route it
  // through config.cjs's validatePath (allowedRoots = home dir) —
  // same boundary every other fs-touching IPC handler uses — never a
  // bespoke check here.
  // Normalize a `~`-prefixed cwd BEFORE it reaches allocateParallelGroup/
  // readPrd/writePrd — those pass cwd through to safeSlugPathIn-adjacent path
  // joins that treat it as a literal path segment, so an unexpanded `~/...`
  // fails downstream as a bare "invalid slug" instead of a clear cwd error.
  const cwd = expandHome(input.cwd);
  let realCwd;
  try {
    realCwd = config.validatePath(cwd);
  } catch (e) {
    return { ok: false, status: 400, error: `cwd rejected: ${e?.message ?? 'outside allowed roots'}` };
  }
  // Register this project's cwd as a write-allowed root (config.cjs's
  // validateWrite gate). Chat-only Epics (headless claude -p, no Terminal
  // PTY ever spawned for this cwd) reach this code path without pty.cjs's
  // addAllowedRoot call ever having run — without this, every PRD write for
  // such a project fails with "Write outside allowed write boundaries" even
  // though validatePath (the read boundary) just passed above.
  config.addAllowedRoot(realCwd);
  input = { ...input, cwd };

  if (!input.sourcePromptId && input.originClaudeSessionId) {
    const resolved = resolveSourcePromptIdFromClaudeSession(cwd, input.originClaudeSessionId);
    if (resolved) input = { ...input, sourcePromptId: resolved };
  }

  const slug = input.slug || deriveSlugFromTitle(input.title);
  if (!slug || !PRD_CREATE_SLUG_RE.test(slug)) {
    return { ok: false, status: 400, error: 'could not derive a valid kebab-case slug from title; supply "slug" explicitly' };
  }

  // NN allocation is delegated to allocateParallelGroup() (PRD 548) via the
  // injected remote — never re-derived here. `parallelGroup` input is
  // DEPRECATED (PRD 832, user decision 2026-07-31): numbers are strictly
  // unique per project; ordering is expressed via `dependsOn` frontmatter,
  // never by sharing a number. An explicit parallelGroup is ignored.
  if (input.parallelGroup != null) {
    console.warn(`[prdCreate] parallelGroup input is deprecated and ignored (got ${input.parallelGroup}) — numbers are unique per project; use dependsOn for ordering`);
  }
  const nn = await remote.allocateParallelGroup(input.cwd);
  const filenameSlug = `${nn}-${slug}`;

  // An explicit `parallelGroup` bypasses allocateParallelGroup()'s
  // collision-proof reservation, so re-check for an existing file at
  // this exact destination before writing — remote.writePrd itself has
  // no existence guard (by design, it doubles as the edit-in-place
  // path for Scheduler UI PRD edits), so "create" must not silently
  // clobber an existing job's PRD.
  const existing = await remote.readPrd(filenameSlug, input.cwd);
  if (existing?.ok) {
    return { ok: false, status: 409, error: `PRD already exists: ${filenameSlug}.md` };
  }

  const body = buildPrdBody(input);
  const writeResult = await remote.writePrd(filenameSlug, body, input.cwd);
  if (!writeResult?.ok) {
    return { ok: false, status: 500, error: writeResult?.error ?? 'write failed' };
  }

  return { ok: true, nn, filename: `${filenameSlug}.md` };
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

    const result = await createPrd(input, remote);
    if (!result.ok) {
      sendJson(res, result.status, { ok: false, error: result.error });
      return;
    }

    sendJson(res, 200, { nn: result.nn, filename: result.filename, status: 'queued' });
  });
}

module.exports = {
  PRD_CREATE_SLUG_RE,
  STANDARDS_PATH,
  readStandards,
  deriveSlugFromTitle,
  buildPrdBody,
  resolveSourcePromptIdFromClaudeSession,
  createPrd,
  registerAdminRoute,
};
