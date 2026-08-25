/**
 * Canonical runtime schema for an Agent persona WRITE payload, mirroring the
 * TS `AgentPersonaSaveInput` interface at src/preload/api.d.ts:229-246
 * field-for-field.
 *
 * Modelled on promptSessionSchema.cjs / scheduleJobSchema.cjs's "zod schema
 * asserted at the main-process boundary" pattern: Epic and Job each got this
 * guarantee only after a production incident (see scheduleJobSchema.cjs's
 * header for the Job one). Agent is the third ERD entity
 * (Agent/WorkType/Epic/PRD/Job) and, until this schema, the only one with
 * zero validation between the renderer and disk — `savePersona`
 * (agentLibrary.cjs) checked only that `name` was kebab-case.
 *
 * This schema covers the WRITE path only (`agents.savePersona`). The READ
 * path (`listPersonas`) stays permissive on purpose — personas on disk may be
 * hand-written or authored by Claude Code itself and must keep loading even
 * if they carry fields this app doesn't recognize.
 *
 * Plain CJS, no Electron dependency, so it's requirable from ipcSchemas.cjs
 * the same way promptSessionSchema.cjs and scheduleJobSchema.cjs already are.
 */
'use strict';

const { z } = require('zod');
const { WorkTypeSchema } = require('./workTypeLibrary.cjs');
const { PERSONA_NAME_RE, ALL_PROJECTS } = require('../agentLibrary.cjs');

// Bounded free-text fields — generous for legitimate persona authoring while
// still blocking a renderer from writing an effectively-unbounded frontmatter
// value (mirrors ipcSchemas.cjs's title/description caps elsewhere).
const PersonaNameSchema = z.string().regex(PERSONA_NAME_RE, 'agent name must be lowercase, hyphenated (e.g. "my-agent")');
const BoundedString = z.string().max(2000);

// `projects` entries are either the `'*'` sentinel (every project) or an
// absolute path — agentLibrary.cjs's openProjects always deals in absolute
// cwds, and a relative entry could never match one.
const ProjectEntrySchema = z.string().refine(
  (v) => v === ALL_PROJECTS || v.startsWith('/'),
  `must be "${ALL_PROJECTS}" or an absolute path`,
);

// Mirrors AgentPersonaSaveInput (src/preload/api.d.ts:229-246). `tags` is the
// Epic-mission WorkType union, NOT a free-form string list — the same
// concept as PromptSessionSchema's `tag` / scheduleRetagPrd's `tag`, just
// plural here since a persona can be associated with more than one mission.
const AgentPersonaSaveSchema = z.object({
  name: PersonaNameSchema,
  // Previous filename, when renaming an existing persona. Omit when creating.
  originalName: PersonaNameSchema.optional(),
  description: BoundedString,
  tools: z.array(BoundedString),
  model: BoundedString,
  color: BoundedString,
  tags: z.array(WorkTypeSchema),
  projects: z.array(ProjectEntrySchema).optional(),
  action: z.string().max(20000).optional(),
  actionLabel: BoundedString.optional(),
  title: BoundedString.optional(),
  // Unbounded — a persona's body is arbitrary system-prompt prose.
  body: z.string(),
});

/**
 * Throws a clear, descriptive error (not a raw ZodError dump) when `persona`
 * doesn't match AgentPersonaSaveSchema. Mirrors assertValidPromptSession /
 * assertValidScheduleJob's shape and message format exactly.
 */
function assertValidAgentPersonaSave(persona) {
  const result = AgentPersonaSaveSchema.safeParse(persona);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`assertValidAgentPersonaSave: invalid AgentPersonaSave shape — ${issues}`);
  }
  return result.data;
}

module.exports = {
  AgentPersonaSaveSchema,
  assertValidAgentPersonaSave,
};
