// @ts-check
/**
 * Canonical runtime schema for a PromptSession (Epic) record, mirroring the
 * TS `PromptSession` interface at src/renderer/state/promptSessions.ts:29-76
 * field-for-field. Two independent code paths hand-construct this same
 * record shape — the renderer's createPromptSession and this main-process
 * module's ensureEpic mint branch (epicMint.cjs) — kept in sync only by doc
 * comments today. This schema is the single source of truth to validate
 * against, closing that drift risk on the main-process/CLI/scheduler side.
 *
 * Plain CJS, no Electron dependency, so it's requirable from epicMint.cjs
 * and (in a later PRD) ipcSchemas.cjs's IPC boundary.
 */
'use strict';

const { z } = require('zod');
const { WorkTypeSchema, LEGACY_WORK_TYPES } = require('./prd/workTypeLibrary.cjs');

// Mirrors EpicTag (src/renderer/lib/tagLibrary.ts:10) — the Epic-level
// mission tag. Epic tag and PRD tag (ipcSchemas.cjs's scheduleRetagPrd `tag`
// field) are the same WorkType concept, so both validate against the shared
// WorkTypeSchema from workTypeLibrary.cjs rather than each declaring their
// own enum literal.
const EpicTagSchema = WorkTypeSchema;

// A legacy tag value (e.g. the retired 'bilko-host-publisher') must keep
// loading on an old on-disk Epic — dropped silently (treated as absent),
// never thrown. Any other unknown value still fails via EpicTagSchema.
const LegacyAwareEpicTagSchema = z.preprocess(
  (v) => (typeof v === 'string' && LEGACY_WORK_TYPES.includes(v) ? undefined : v),
  EpicTagSchema.optional(),
);

// Mirrors EpicSource (`export interface EpicSource` in src/renderer/state/promptSessions.ts).
const EpicSourceSchema = z.object({
  producer: z.enum(['new-epic-ui', 'scheduler-dispatch', 'cross-project-feedback']),
  prdSlug: z.string().optional(),
  runId: z.string().optional(),
  sourceTabId: z.string().optional(),
  // Cross-project provenance ('cross-project-feedback' only): which project,
  // and which Epic inside it, sent this proposal. Kept on the Epic itself so
  // the receiving human can see who is asking without a second lookup table —
  // there is no cross-project registry anywhere else.
  fromCwd: z.string().optional(),
  fromEpicId: z.string().optional(),
  // The macro that launched this Epic (new-epic-ui Epics only).
  macroId: z.string().optional(),
  // Zod strips undeclared keys on the merge path; a stricter shape could make dropInvalidSessions (ipcSchemas.cjs) drop a whole row holding an older or malformed value.
  proposal: z.unknown().optional(),
  autoApprove: z.unknown().optional(),
});

// Mirrors EpicIntakeSection (src/renderer/lib/epicIntake.ts) — the labeled
// slices composeEpicIntake emits alongside the flat `openingPrompt`, kept as
// data so the Epic's first turn can render a structured AIM briefing card
// instead of regex-parsing the flat string back apart.
const EpicIntakeSectionSchema = z.object({
  kind: z.enum(['actor', 'persona-body', 'injection', 'input', 'mission', 'goal', 'reference']),
  label: z.string(),
  text: z.string(),
  source: z.string().optional(),
  // Mirrors AimPart in src/renderer/lib/epicIntake.ts (main cannot import the
  // renderer module). Optional because Epics minted before AIM sections carry
  // none. NEVER narrow the kind enum above — dropInvalidSessions in
  // ipcSchemas.cjs drops a whole stored Epic whose record fails this schema.
  part: z.enum(['persona', 'grounding', 'injection', 'reference', 'job-type', 'goal']).optional(),
});

// Mirrors PromptSession's `worktree` field (src/renderer/state/
// promptSessions.ts) — this Epic's isolated `git worktree` checkout, when
// one exists. `baseCwd` is always the Epic's real owning-project cwd, never
// the worktree dir itself (see gitWorktree.cjs's "ops-root hazard" comment).
const EpicWorktreeSchema = z.object({
  dir: z.string(),
  branch: z.string(),
  baseCwd: z.string(),
  status: z.enum(['active', 'needs_merge_resolution', 'merged', 'disabled']),
});

// Mirrors PromptSession (src/renderer/state/promptSessions.ts:29-76).
const PromptSessionSchema = z.object({
  id: z.string(),
  cwd: z.string(),
  goalText: z.string(),
  claudeSessionId: z.string(),
  status: z.enum(['proposed', 'active', 'completed']),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  resumedFromId: z.string().nullable().optional(),
  tag: LegacyAwareEpicTagSchema,
  openingPrompt: z.string().nullable().optional(),
  source: EpicSourceSchema.optional(),
  agentType: z.string().optional(),
  // Per-Epic runtime overrides chosen on the New Session card; absent = the persona's own value.
  model: z.string().optional(),
  effort: z.string().optional(),
  // false = started with the develop loop (/develop skill, delegation guard, PRD queueing) switched off;
  // fixed for the life of its session; absent = on; only false is ever written.
  developLoop: z.boolean().optional(),
  // The agent CLI that runs this Epic's session; absent = Claude Code. Fixed for the life of the
  // session. Deliberately a bounded string, not an enum: a row written by a newer build naming a CLI
  // this build doesn't know must never be dropped by dropInvalidSessions (ipcSchemas.cjs).
  agentCli: z.string().max(32).optional(),
  // Optional model string passed to that CLI; absent = the CLI's own default.
  agentCliModel: z.string().max(128).optional(),
  // true = this Epic adopted an existing CLI session as its claudeSessionId
  // (ensureEpic's restoreSessionId) instead of a fresh one; absent otherwise.
  // Only true is ever written: a false would fail here, and dropInvalidSessions
  // (ipcSchemas.cjs) would then drop the whole stored row.
  restoredSession: z.literal(true).optional(),
  // Absent on Epics minted before this field existed — those fall back to
  // rendering the flat `openingPrompt` as a single block (see
  // ChatTranscriptTurn.tsx's EpicIntakeCard).
  sections: z.array(EpicIntakeSectionSchema).optional(),
  // Passthrough only as of PRD 1032 — nothing populates this yet; the next
  // PRD in this chain wires Epic worktree minting.
  worktree: EpicWorktreeSchema.optional(),
  // Status-mirror fields (epicStatusMirror.cjs) written onto prompt-sessions/
  // <id>.json alongside the active-index.json row — never onto the index row
  // itself, so a plain PromptSession read from active-index.json normally
  // omits them. Optional here only so activeIndexRebuild.cjs can validate a
  // mirrored file's reconstructed row against this same schema.
  archivedAt: z.string().nullable().optional(),
  indexedAt: z.string().optional(),
});

/**
 * Throws a clear, descriptive error (not a raw ZodError dump) when `session`
 * doesn't match PromptSessionSchema. Callers that want fail-closed
 * enforcement before persisting a session object call this immediately
 * before their write.
 * @param {unknown} session
 */
function assertValidPromptSession(session) {
  const result = PromptSessionSchema.safeParse(session);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`assertValidPromptSession: invalid PromptSession shape — ${issues}`);
  }
  return result.data;
}

module.exports = {
  PromptSessionSchema,
  EpicSourceSchema,
  EpicTagSchema,
  EpicIntakeSectionSchema,
  EpicWorktreeSchema,
  assertValidPromptSession,
};
