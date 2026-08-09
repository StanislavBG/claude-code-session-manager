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

// Mirrors EpicTag (src/renderer/lib/tagLibrary.ts:10) — the Epic-level
// mission tag, NOT the same value set as ipcSchemas.cjs's scheduleRetagPrd
// tag enum (~line 349), which only covers 5 of these 6 values ('feature',
// 'bug', 'discussion', 'build', 'project-home-builder') and is missing
// 'bilko-host-publisher' — the two enums describe related but distinct
// concepts (PRD-scheduling tag vs. Epic-mission tag), so this is its own
// definition rather than an import of that one.
const EpicTagSchema = z.enum([
  'feature',
  'bug',
  'discussion',
  'build',
  'project-home-builder',
  'bilko-host-publisher',
]);

// Mirrors EpicSource (src/renderer/state/promptSessions.ts:22-27).
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
});

// Mirrors EpicIntakeSection (src/renderer/lib/epicIntake.ts) — the labeled
// slices composeEpicIntake emits alongside the flat `openingPrompt`, kept as
// data so the Epic's first turn can render a structured AIM briefing card
// instead of regex-parsing the flat string back apart.
const EpicIntakeSectionSchema = z.object({
  kind: z.enum(['actor', 'injection', 'input', 'mission', 'goal', 'reference']),
  label: z.string(),
  text: z.string(),
  source: z.string().optional(),
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
  tag: EpicTagSchema.optional(),
  openingPrompt: z.string().nullable().optional(),
  source: EpicSourceSchema.optional(),
  agentType: z.string().optional(),
  // Absent on Epics minted before this field existed — those fall back to
  // rendering the flat `openingPrompt` as a single block (see
  // ChatTranscriptTurn.tsx's EpicIntakeCard).
  sections: z.array(EpicIntakeSectionSchema).optional(),
});

/**
 * Throws a clear, descriptive error (not a raw ZodError dump) when `session`
 * doesn't match PromptSessionSchema. Callers that want fail-closed
 * enforcement before persisting a session object call this immediately
 * before their write.
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
  assertValidPromptSession,
};
