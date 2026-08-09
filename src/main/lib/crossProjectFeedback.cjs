'use strict';

/**
 * crossProjectFeedback.cjs — THE PROJECT-TO-PROJECT CONDUIT.
 *
 * Problem this solves. `/process-feedback`, `/my-feedback` and the
 * `session-manager-operations/feedback/` intake folder were retired
 * (2026-08-02), and the scheduler was correctly locked down so a PRD can only
 * ever JOIN an Epic that a human already approved. Both changes were right on
 * their own, and together they removed the last channel an agent working in
 * Project-A had for handing a finding to Project-B. The finding either died in
 * a transcript or the human relayed it by hand.
 *
 * What this restores, and what it deliberately does NOT restore. Session
 * Manager's main process is the ONE process that legitimately holds several
 * projects' operations roots open at once, so it — and only it — can perform
 * the cross-folder write. A session in Project-A calls `feedback_open_session`
 * (MCP) → this module mints a `proposed` Epic in **Project-B's own**
 * `session-manager-operations/prompt-sessions/active-index.json`, carrying the
 * report as its opening prompt and stamped with where it came from. It appears
 * in Project-B's Sessions queue exactly like a hand-filed proposal.
 *
 * It does NOT re-open the agent-facing proposal channel that was removed. That
 * channel let an agent file work into the project it was ALREADY running in,
 * which is what "run /develop inside the Epic you're already in" replaced and
 * which stays refused — `sameProject` below rejects toCwd === fromCwd outright
 * and names /develop in the error. The only new power is depositing a proposal
 * into a DIFFERENT project's inbox.
 *
 * Why that is safe. The part of the SINGLE-CREATOR LAW that actually guards
 * spend is not "a human typed it" — it's "every Epic is born 'proposed' and
 * nothing runs until a human presses Approve & start". A cross-project
 * feedback Epic is born 'proposed' like every other Epic (epicMint.cjs's
 * BORN-PROPOSED check applies to this mint authority verbatim), so the human
 * in the RECEIVING project is still the one who decides whether a single token
 * gets spent. An agent can ask; it cannot start.
 *
 * Guards, all fail-closed:
 *   - both cwds go through config.cjs's validatePath (allowedRoots = home)
 *   - both must be real, existing directories
 *   - toCwd !== fromCwd (see above)
 *   - toCwd must ALREADY be a Session Manager project — its
 *     `session-manager-operations/` must exist. This module never conjures an
 *     operations root in an arbitrary directory, so it can't be used to
 *     scatter app state across the filesystem.
 *   - title/body length caps, so one call can't write an unbounded blob into
 *     another project's active-index.json.
 *
 * Single-writer law: the actual write is `ensureEpic`'s, which already
 * declares writer 'scheduler' against prompt-sessions/'s narrow
 * active-index.json delegation (opsOwnership.cjs). No new namespace, no new
 * writer, no new delegation.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const config = require('../config.cjs');
const { readBody, sendJson } = require('./localAdminHttp.cjs');
const {
  ensureEpic,
  readActiveIndex,
  MINT_AUTHORITY_CROSS_PROJECT_FEEDBACK,
} = require('./epicMint.cjs');
const { appendAuditEvent } = require('./auditLog.cjs');
const { OPS_ROOT_DIR } = require('./opsOwnership.cjs');

/** Only these three Epic tags make sense for an inbound report — they are
 *  exactly the tags that route through /develop (tagLibrary.ts). 'build',
 *  'project-home-builder' and 'bilko-host-publisher' name dedicated local
 *  pipelines and are meaningless as a request from another project. */
const FEEDBACK_TAGS = Object.freeze(['bug', 'feature', 'discussion']);
const DEFAULT_FEEDBACK_TAG = 'discussion';

/** Default persona for the receiving session. 'architect' owns scope
 *  clarification and decomposition, which is precisely what a receiving human
 *  wants pointed at an incoming report. */
const DEFAULT_FEEDBACK_AGENT = 'architect';

const MAX_TITLE_CHARS = 200;
const MAX_BODY_CHARS = 20000;
const MAX_REFERENCES = 20;

/** Bound on how many `~/.claude/projects/` folders listFeedbackTargets will
 *  resolve. That directory accumulates one folder per path the CLI was ever
 *  launched from (thousands here — see CLAUDE.md's knownProjectAggregate
 *  note), so the scan is capped at the most recently active folders and
 *  reports the truncation rather than silently covering a subset. */
const TARGET_SCAN_LIMIT = 300;

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

function singleLine(s) {
  return String(s ?? '').replace(/\r?\n/g, ' ').trim();
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** True when `cwd` is a Session Manager project — i.e. it already has an
 *  operations root. Deliberately the ONLY definition of "can receive
 *  feedback": it needs no registry, can't go stale, and refuses to create the
 *  folder it is checking for. */
function isSessionManagerProject(cwd) {
  return isDirectory(path.join(cwd, OPS_ROOT_DIR));
}

/**
 * composeFeedbackIntake({ fromCwd, fromEpicId, title, body, referencePaths })
 *   → { goalText, openingPrompt, sections }
 *
 * Pure. Mirrors the renderer's `composeEpicIntake` (lib/epicIntake.ts) —
 * same `EpicIntakeSection` shape, same emission order, same '\n\n' joins — so
 * the receiving Epic's first turn renders the identical AIM briefing card as a
 * hand-created one. It cannot import that module (TS, renderer-side), so it
 * deliberately emits only the section kinds whose text it OWNS:
 *
 *   actor  — the persona line, same sentence template as composeEpicIntake
 *   input  — AIM's Input axis: what grounds this session. For an inbound
 *            report that is literally "an external report from Project-A",
 *            which is this module's own fact to state.
 *   goal   — the report itself.
 *   reference — attached paths.
 *
 * There is NO `mission` section, on purpose. A mission section's text is the
 * tag's `initialPromptTemplate`, which lives in agentTagDefs.ts; re-typing it
 * here would be a second, drifting copy of a tag's meaning — the exact thing
 * CLAUDE.md forbids. The Epic still carries its `tag` field, so every surface
 * that renders a tag's meaning keeps reading it through `agentTagDef(tag)`.
 *
 * Complexity: O(n) in the number of references.
 */
function composeFeedbackIntake({
  fromCwd,
  fromEpicId = null,
  title,
  body,
  agentName = DEFAULT_FEEDBACK_AGENT,
  agentDescription = null,
  referencePaths = [],
} = {}) {
  const trimmedTitle = singleLine(title);
  const trimmedBody = String(body ?? '').trim();
  const sections = [];

  if (agentName && agentDescription) {
    sections.push({
      kind: 'actor',
      label: 'Actor',
      text: `You are acting as the "${singleLine(agentName)}" agent: ${singleLine(agentDescription)}`,
      source: agentName,
    });
  }

  const origin = fromEpicId
    ? `${singleLine(fromCwd)} (session ${singleLine(fromEpicId)})`
    : singleLine(fromCwd);
  sections.push({
    kind: 'input',
    label: 'Input',
    text:
      `This session is INBOUND FEEDBACK from another project: ${origin}. `
      + 'Nobody in this project wrote the report below — an agent working in that project did, and it '
      + 'may be wrong about this codebase. Verify the claim against the code here before acting on it, '
      + 'and if it does not hold, say so and close the session rather than building against it.',
    source: fromCwd,
  });

  const goalBody = trimmedTitle ? `Goal: ${trimmedTitle}\n\n${trimmedBody}` : trimmedBody;
  sections.push({ kind: 'goal', label: 'Goal', text: goalBody });

  for (const p of referencePaths) {
    sections.push({ kind: 'reference', label: 'Reference', text: `Reference: ${singleLine(p)}`, source: p });
  }

  // Same join rule as epicIntake.ts's joinSections: '\n\n' everywhere except
  // between two consecutive reference lines, which stay one visual block.
  const openingPrompt = sections.reduce((out, s, i) => {
    if (i === 0) return s.text;
    const sep = s.kind === 'reference' && sections[i - 1].kind === 'reference' ? '\n' : '\n\n';
    return out + sep + s.text;
  }, '');

  const bodyText = trimmedTitle ? `${trimmedTitle}\n\n${trimmedBody}` : trimmedBody;
  const refLines = referencePaths.map((p) => `Reference: ${singleLine(p)}`);
  const goalText = refLines.length ? `${bodyText}\n\n${refLines.join('\n')}` : bodyText;

  return { goalText, openingPrompt, sections };
}

/**
 * validateFeedbackInput(input) → { ok: true, value } | { ok: false, status, error }
 *
 * Pure apart from filesystem existence checks. Split out from
 * openFeedbackSession so every refusal is unit-testable without minting
 * anything.
 */
function validateFeedbackInput(input = {}) {
  const bad = (status, error) => ({ ok: false, status, error });

  const title = singleLine(input.title);
  if (!title) return bad(400, 'title is required');
  if (title.length > MAX_TITLE_CHARS) {
    return bad(400, `title is ${title.length} chars; cap is ${MAX_TITLE_CHARS}`);
  }

  const body = String(input.body ?? '').trim();
  if (!body) return bad(400, 'body is required — the feedback report itself');
  if (body.length > MAX_BODY_CHARS) {
    return bad(400, `body is ${body.length} chars; cap is ${MAX_BODY_CHARS}. Summarize, and attach detail as a reference path.`);
  }

  const tag = input.tag ?? DEFAULT_FEEDBACK_TAG;
  if (!FEEDBACK_TAGS.includes(tag)) {
    return bad(400, `tag must be one of ${FEEDBACK_TAGS.join(' | ')} (got ${JSON.stringify(tag)})`);
  }

  const referencePaths = Array.isArray(input.referencePaths) ? input.referencePaths : [];
  if (referencePaths.length > MAX_REFERENCES) {
    return bad(400, `too many referencePaths (${referencePaths.length}); cap is ${MAX_REFERENCES}`);
  }

  if (!input.toCwd || typeof input.toCwd !== 'string') return bad(400, 'toCwd is required');
  if (!input.fromCwd || typeof input.fromCwd !== 'string') return bad(400, 'fromCwd is required');

  let toCwd;
  let fromCwd;
  try {
    toCwd = config.validatePath(path.resolve(input.toCwd));
  } catch (e) {
    return bad(400, `toCwd rejected: ${e.message}`);
  }
  try {
    fromCwd = config.validatePath(path.resolve(input.fromCwd));
  } catch (e) {
    return bad(400, `fromCwd rejected: ${e.message}`);
  }

  if (!isDirectory(toCwd)) return bad(400, `toCwd is not an existing directory: ${toCwd}`);
  if (!isDirectory(fromCwd)) return bad(400, `fromCwd is not an existing directory: ${fromCwd}`);

  if (toCwd === fromCwd) {
    return bad(
      400,
      'toCwd and fromCwd are the same project — this tool is only for handing a finding to a DIFFERENT '
      + 'project. Work you want done in the project you are already in goes through /develop inside the '
      + 'Epic you are already in, which is what replaced the retired feedback folder.',
    );
  }

  if (!isSessionManagerProject(toCwd)) {
    return bad(
      400,
      `${toCwd} is not a Session Manager project — it has no ${OPS_ROOT_DIR}/ directory, so it has no `
      + 'Sessions queue to deliver a proposal into. Open it as a project in Session Manager once (which '
      + 'creates that directory), then send the feedback again.',
    );
  }

  return {
    ok: true,
    value: {
      toCwd,
      fromCwd,
      title,
      body,
      tag,
      referencePaths: referencePaths.map((p) => String(p)),
      fromEpicId: input.fromEpicId ? String(input.fromEpicId) : null,
      agentType: input.agentType ? String(input.agentType) : DEFAULT_FEEDBACK_AGENT,
      agentDescription: input.agentDescription ? String(input.agentDescription) : null,
    },
  };
}

/**
 * openFeedbackSession(input, deps?) → { ok, status?, error?, epicId, toCwd, ... }
 *
 * Mints the `proposed` Epic in the RECEIVING project and, when the sending
 * Epic is known and still active, chains a receipt onto its event chain so the
 * sender's own transcript records where the finding went. The receipt is
 * best-effort: a failure there never invalidates a delivered proposal, it just
 * reports `receiptOnOriginEpic: false`.
 *
 * `deps` exists so tests can inject the two side-effecting collaborators
 * without an Electron/main-process boot.
 */
async function openFeedbackSession(input, deps = {}) {
  const mint = deps.ensureEpic || ensureEpic;
  const appendReceipt =
    deps.appendResponseEventIfKnown
    // Required lazily: promptSessionEvents.cjs pulls in config.cjs's watcher
    // machinery, and this module is also required from unit tests that never
    // boot the main process.
    || ((...args) => require('../promptSessionEvents.cjs').appendResponseEventIfKnown(...args));

  const checked = validateFeedbackInput(input);
  if (!checked.ok) return checked;
  const v = checked.value;

  // The MCP client can't know its own Epic id — it only inherits the claude
  // session id chatRunner.cjs stamps on the `claude -p` child. Resolve it
  // through prdCreate.cjs's existing resolver rather than a second copy of
  // the same lookup (required lazily: prdCreate pulls in ipcSchemas/config).
  if (!v.fromEpicId && input.originClaudeSessionId) {
    try {
      const { resolveSourcePromptIdFromClaudeSession } = require('./prdCreate.cjs');
      v.fromEpicId = resolveSourcePromptIdFromClaudeSession(v.fromCwd, String(input.originClaudeSessionId)) || null;
    } catch { /* unresolvable — the proposal still delivers, just without a receipt */ }
  }

  const { goalText, openingPrompt, sections } = composeFeedbackIntake({
    fromCwd: v.fromCwd,
    fromEpicId: v.fromEpicId,
    title: v.title,
    body: v.body,
    agentName: v.agentType,
    agentDescription: v.agentDescription,
    referencePaths: v.referencePaths,
  });

  // The Epic's stored identity is the one-line title, not the whole report —
  // that's what the receiving queue row shows. The report travels in
  // openingPrompt, which is what Approve & start sends.
  let minted;
  try {
    minted = await mint(v.toCwd, {
      goalText: v.title,
      tag: v.tag,
      agentType: v.agentType,
      status: 'proposed',
      openingPrompt,
      sections,
      source: {
        producer: 'cross-project-feedback',
        fromCwd: v.fromCwd,
        ...(v.fromEpicId ? { fromEpicId: v.fromEpicId } : {}),
      },
      mintAuthority: MINT_AUTHORITY_CROSS_PROJECT_FEEDBACK,
    });
  } catch (e) {
    return { ok: false, status: 500, error: `could not open the feedback session: ${e.message}` };
  }

  appendAuditEvent('epic_cross_project_feedback', {
    cwd: v.toCwd,
    epicId: minted.epicId,
    fromCwd: v.fromCwd,
    fromEpicId: v.fromEpicId,
    tag: v.tag,
    title: v.title,
  });

  let receiptOnOriginEpic = false;
  if (v.fromEpicId) {
    try {
      receiptOnOriginEpic = await appendReceipt(
        v.fromCwd,
        v.fromEpicId,
        `Feedback delivered to ${v.toCwd} as a proposed session (${minted.epicId}): "${v.title}". `
        + 'It will not run until a human in that project approves it.',
      );
    } catch {
      receiptOnOriginEpic = false;
    }
  }

  return {
    ok: true,
    epicId: minted.epicId,
    toCwd: v.toCwd,
    fromCwd: v.fromCwd,
    tag: v.tag,
    status: 'proposed',
    receiptOnOriginEpic,
    // Say plainly what did NOT happen, same posture as create-prd's
    // `enqueued: false` — never let a caller report this as "work started".
    note:
      'Delivered as a PROPOSED session in the receiving project\'s Sessions queue. Nothing runs and no '
      + 'tokens are spent until a human in that project presses Approve & start. There is no callback: '
      + 'if you need an answer, ask the human to follow up.',
    goalText,
  };
}

/**
 * listFeedbackTargets() → { projects: [{ cwd, lastActivity }], scanned, truncated }
 *
 * Which projects can receive feedback. Resolved the same way CLAUDE.md
 * requires everywhere else: a PROJECT IS A CWD, resolved from transcript
 * CONTENT, never by naively decoding a `~/.claude/projects/` folder name back
 * into a path. A folder whose cwd cannot be resolved is DROPPED, not guessed.
 * Results are then filtered to directories that still exist AND already carry
 * an operations root — exactly `openFeedbackSession`'s own precondition, so
 * this list can't offer a target that would then be refused.
 */
async function listFeedbackTargets({ limit = TARGET_SCAN_LIMIT } = {}) {
  let entries;
  try {
    entries = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return { projects: [], scanned: 0, truncated: 0 };
  }
  const dirs = entries.filter((e) => e.isDirectory());

  // Newest-first by folder mtime, so the cap keeps the projects actually in
  // use rather than an arbitrary alphabetical slice.
  const stamped = [];
  for (const d of dirs) {
    const full = path.join(PROJECTS_DIR, d.name);
    try {
      stamped.push({ full, mtimeMs: (await fsp.stat(full)).mtimeMs });
    } catch { /* raced away */ }
  }
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const scanned = stamped.slice(0, limit);

  const byCwd = new Map();
  for (const { full, mtimeMs } of scanned) {
    const cwd = await resolveCwdFromTranscriptDir(full);
    if (!cwd) continue;
    const prior = byCwd.get(cwd);
    if (!prior || prior.lastActivity < mtimeMs) byCwd.set(cwd, { cwd, lastActivity: mtimeMs });
  }

  const projects = [...byCwd.values()]
    .filter((p) => isDirectory(p.cwd) && isSessionManagerProject(p.cwd))
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .map((p) => ({ cwd: p.cwd, lastActivity: new Date(p.lastActivity).toISOString() }));

  return { projects, scanned: scanned.length, truncated: Math.max(0, stamped.length - scanned.length) };
}

/** Read the `cwd` field off the first JSON line of the newest .jsonl in a
 *  `~/.claude/projects/<encoded>/` folder. Returns null when the folder holds
 *  no transcript or no line carries a cwd — the caller drops it rather than
 *  falling back to decoding the folder name. */
async function resolveCwdFromTranscriptDir(dir) {
  let files;
  try {
    files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return null;
  }
  if (!files.length) return null;
  const stamped = [];
  for (const f of files) {
    try {
      stamped.push({ f, mtimeMs: (await fsp.stat(path.join(dir, f))).mtimeMs });
    } catch { /* raced away */ }
  }
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { f } of stamped.slice(0, 3)) {
    try {
      // Transcripts can be large; only the head is needed — the cwd is
      // stamped on the very first records.
      const handle = await fsp.open(path.join(dir, f), 'r');
      try {
        const buf = Buffer.alloc(64 * 1024);
        const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
        const head = buf.subarray(0, bytesRead).toString('utf8');
        for (const line of head.split('\n')) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed.cwd === 'string' && parsed.cwd) return path.resolve(parsed.cwd);
          } catch { /* partial trailing line */ }
        }
      } finally {
        await handle.close();
      }
    } catch { /* unreadable */ }
  }
  return null;
}

/** Registers both routes on the injected loopback admin transport. Mirrors
 *  prdCreate.cjs's registerAdminRoute — auth is the transport's job. */
function registerAdminRoute(adminHttp) {
  adminHttp.registerRoute('POST', '/admin/feedback/open-session', async (req, res) => {
    const raw = await readBody(req);
    let parsed;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
      return;
    }
    const result = await openFeedbackSession(parsed);
    if (!result.ok) {
      sendJson(res, result.status ?? 400, { ok: false, error: result.error });
      return;
    }
    sendJson(res, 200, result);
  });

  adminHttp.registerRoute('GET', '/admin/feedback/targets', async (req, res) => {
    const result = await listFeedbackTargets();
    sendJson(res, 200, { ok: true, ...result });
  });
}

module.exports = {
  FEEDBACK_TAGS,
  DEFAULT_FEEDBACK_TAG,
  DEFAULT_FEEDBACK_AGENT,
  MAX_TITLE_CHARS,
  MAX_BODY_CHARS,
  MAX_REFERENCES,
  isSessionManagerProject,
  composeFeedbackIntake,
  validateFeedbackInput,
  openFeedbackSession,
  listFeedbackTargets,
  registerAdminRoute,
};
