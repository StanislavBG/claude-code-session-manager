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
const { appendAuditEvent } = require('./auditLog.cjs');
const { resolveProjectContext } = require('./projectRootResolve.cjs');

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
  // Provenance stamp (PRD-authoring lockdown): every PRD written through this
  // function — the sole in-process implementation behind both the admin
  // HTTP create-prd route and the renderer's chat:create-prd IPC handler —
  // carries proof it was authored via the API, not a bare Write/Edit tool
  // call. scheduler.cjs's reconcile() refuses to run a discovered PRD with no
  // `createdVia` (quarantines it instead); this line is why every
  // API-created PRD is exempt. Stamped here, not left to a caller, so the
  // guarantee can't be forgotten by a future route.
  fmLines.push('createdVia: scheduler-api', `issuedAt: ${new Date().toISOString()}`);
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
  // cwd is untrusted AND, since this PRD, optional — a caller inside an
  // Epic's git worktree naturally passes its worktree pwd (or omits cwd
  // entirely and relies on originClaudeSessionId/sourcePromptId). Resolve the
  // real project + owning Epic server-side BEFORE any validation: a worktree
  // cwd currently PASSES config.validatePath and then reads the WRONG
  // active-index.json (a git-tracked snapshot frozen at branch time), which
  // is why "the Epic got lost" reports keep recurring even though the Epic
  // never left main's index. See projectRootResolve.cjs's header.
  const rawCwd = input.cwd ? expandHome(input.cwd) : null;
  const originProjectRoot = input.originProjectRoot ? expandHome(input.originProjectRoot) : null;
  const resolved = resolveProjectContext({
    cwd: rawCwd,
    originClaudeSessionId: input.originClaudeSessionId,
    // Only ask the resolver to hunt for the project BY Epic id when no cwd
    // (nor a trusted SM_PROJECT_ROOT hint) was supplied at all — an explicit
    // cwd that merely needs worktree/ops-path normalization is already fixed
    // by projectRootOf above, so the common already-correct-cwd call (cwd +
    // sourcePromptId both supplied) never pays for a cross-project scan.
    epicId: (rawCwd || originProjectRoot) ? undefined : input.sourcePromptId,
    originProjectRoot,
  });

  if (!resolved.cwd) {
    return {
      ok: false,
      status: 400,
      error: 'cwd is required — pass cwd explicitly, or originClaudeSessionId/sourcePromptId that resolves '
        + 'to an existing, already-approved Epic (create/approve an Epic first)',
    };
  }

  // A resolved Epic's own project cwd always wins over the supplied/hinted
  // one — see resolveProjectContext's header. `cwd` below is that final,
  // already-normalized (worktree -> main tree) value.
  const cwd = resolved.cwd;
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

  if (resolved.epicId) {
    input = { ...input, sourcePromptId: resolved.epicId };
  } else if (!input.sourcePromptId && input.originClaudeSessionId) {
    // Fallback kept for the narrow case a caller passes originClaudeSessionId
    // but resolveProjectContext (which also scans cross-project) somehow
    // missed it — resolveSourcePromptIdFromClaudeSession is the single-cwd
    // primitive resolveProjectContext itself is built from, so this can only
    // ever be a no-op in practice; kept for defense-in-depth, not duplicated logic.
    const fallback = resolveSourcePromptIdFromClaudeSession(cwd, input.originClaudeSessionId);
    if (fallback) input = { ...input, sourcePromptId: fallback };
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

  // Trace-back point for "who/what created this PRD" (auditLog.cjs) — every
  // PRD write, whether from the admin/MCP route or the renderer's chat:create-prd
  // IPC handler, lands one record here regardless of outcome path above.
  appendAuditEvent('prd_create', {
    cwd: input.cwd,
    slug: filenameSlug,
    title: input.title,
    sourcePromptId: input.sourcePromptId ?? null,
    sourceTabId: input.sourceTabId ?? null,
  });

  // No `status` field here, and never one named 'queued' — that string was
  // handed straight to callers as if it were a real ScheduleJob status, and
  // is exactly how the 1021/1022 incident's invalid `"status": "queued"`
  // rows got onto disk (this route's own response was the most likely
  // source). A PRD is a queue row's SOURCE, not the row itself: writePrd
  // only ever joins an Epic and writes the .md file — the queue row is
  // created separately, by the next reconcile() pass. `enqueued: false` is
  // true by construction (this function never touches queue.json), so no
  // caller can copy a fake job status out of this response again.
  return {
    ok: true,
    nn,
    filename: `${filenameSlug}.md`,
    prdPath: writeResult.path ?? null,
    epicId: writeResult.epicId ?? null,
    enqueued: false,
    note: 'PRD file written; the queue row is derived by the next scheduler reconcile pass, not created here',
  };
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

    // Mirror createPrd()'s own honest shape verbatim — never re-add a
    // 'status' field here. See createPrd's return above for why.
    sendJson(res, 200, {
      nn: result.nn,
      filename: result.filename,
      prdPath: result.prdPath ?? null,
      epicId: result.epicId ?? null,
      enqueued: false,
      note: result.note,
    });
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
