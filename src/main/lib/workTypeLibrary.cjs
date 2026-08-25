/**
 * Single source of truth for the WorkType id list — the Epic-mission tag
 * (`PromptSession['tag']`, src/renderer/state/promptSessions.ts) and the PRD
 * tag (`scheduleRetagPrd`'s `tag` field, ipcSchemas.cjs) are ONE concept, not
 * two: a domain decision confirmed by the project owner. Both now validate
 * against this same enum.
 *
 * `WORK_TYPES` mirrors the tag ids in src/renderer/lib/tagLibrary.ts's
 * `TAG_LIBRARY`, in the same order — that file stays the human-facing SoT for
 * labels/descriptions/developEagerness; this one is only the id list + zod
 * enum, kept in sync with tagLibrary.ts by
 * src/main/__tests__/workTypeLibrary.test.cjs (tagLibrary.ts is a renderer
 * .ts module main-process .cjs can't import — see CLAUDE.md "no CommonJS in
 * renderer, no ES modules in main").
 *
 * Plain CJS, no Electron dependency, so it's requirable from scheduler/CLI
 * contexts — same constraint promptSessionSchema.cjs and scheduleJobSchema.cjs
 * already satisfy.
 */
'use strict';

const { z } = require('zod');

const WORK_TYPES = Object.freeze([
  'feature',
  'bug',
  'discussion',
  'build',
  'project-home-builder',
  'bilko-host-publisher',
]);

const WorkTypeSchema = z.enum(WORK_TYPES);

// A 'discussion'-tagged ticket never reaches PRD authoring (a domain
// invariant unrelated to the Epic/PRD tag unification above), so the PRD
// frontmatter `tag` field — parsed in prdFrontmatter.cjs/.ts and patched via
// ipcSchemas.cjs's adminPrdFrontmatterPatch — excludes it even though
// WorkTypeSchema itself (used at PRD-create time) does not.
const PRD_WORK_TYPES = Object.freeze(WORK_TYPES.filter((t) => t !== 'discussion'));
const PrdWorkTypeSchema = z.enum(PRD_WORK_TYPES);

module.exports = {
  WORK_TYPES,
  WorkTypeSchema,
  PRD_WORK_TYPES,
  PrdWorkTypeSchema,
};
