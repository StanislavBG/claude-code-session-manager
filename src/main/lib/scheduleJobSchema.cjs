/**
 * Canonical runtime schema for a ScheduleJob record, mirroring the TS
 * `ScheduleJob` interface at src/preload/api.d.ts:375-422 field-for-field.
 *
 * Modelled directly on promptSessionSchema.cjs's "zod schema asserted at the
 * main-process boundary" pattern: the Epic entity has had this guarantee
 * since epicMint.cjs:243, but the Job entity had none — `shapeJobs` in
 * queueStore.cjs was `JSON.parse` + `Array.isArray` with zero field checks,
 * which is how two PRDs sat invisible for 4+ hours on 2026-08-07 with
 * `"status": "queued"`, a value outside `ScheduleJobStatus`, silently
 * skipped by every picker that filters on `status === 'pending'` exactly.
 *
 * `JOB_STATUSES` is the single source of truth for the status enum. The
 * renderer can't import this .cjs file directly, so
 * src/preload/api.d.ts's `ScheduleJobStatus` union and the renderer's
 * `JobStatus`/`FilterStatus` mirrors are kept in sync against this array by
 * src/main/__tests__/scheduleJobSchema.test.cjs.
 *
 * Plain CJS, no Electron dependency, so it's requirable from queueStore.cjs
 * (which itself must load outside the Electron app, e.g. from watchdog
 * scripts).
 */
'use strict';

const { z } = require('zod');

const JOB_STATUSES = ['pending', 'running', 'investigating', 'completed', 'skipped', 'failed', 'needs_review', 'quarantined'];

const ScheduleJobStatusSchema = z.enum(JOB_STATUSES);

const ScheduleJobRuntimeSchema = z
  .object({
    pid: z.number().optional(),
    runId: z.string().optional(),
    startedAt: z.string().nullable().optional(),
    sessionId: z.string().optional(),
    cwd: z.string().optional(),
  })
  .passthrough();

// One entry per accepted status transition (scheduleJobTransitions.cjs).
// Bounded to STATUS_HISTORY_CAP entries there; this schema just validates
// shape, not length, since the cap is enforced at write time.
const ScheduleJobStatusHistoryEntrySchema = z
  .object({
    from: z.string().nullable(),
    to: z.string(),
    reason: z.string().nullable(),
    source: z.string().nullable(),
    at: z.string(),
  })
  .passthrough();

// Only `slug` and `status` are required. Every other ScheduleJob field
// (src/preload/api.d.ts:375-422) is declared here for documentation and type
// checking when present, but kept optional: a job row moves through several
// legitimate partial shapes across its life (freshly minted with nulls,
// mid-run with runtime fields, terminal with exitCode/error) and plenty of
// call sites — including this repo's own test fixtures — construct a row
// with only the fields relevant to what they're exercising. The 2026-08-07
// incident this schema exists to catch was an invalid `status` value, not a
// missing optional field, so `status` is where the strictness belongs.
// Unknown extra fields are preserved (.passthrough()) rather than stripped —
// this schema's job is to gate on shape/status validity, not to be the sole
// place new ScheduleJob fields get declared before they're usable.
const ScheduleJobSchema = z
  .object({
    slug: z.string(),
    title: z.string().optional(),
    cwd: z.string().nullable().optional(),
    parallelGroup: z.number().optional(),
    estimateMinutes: z.number().nullable().optional(),
    bodyPreview: z.string().optional(),
    status: ScheduleJobStatusSchema,
    runId: z.string().nullable().optional(),
    startedAt: z.string().nullable().optional(),
    finishedAt: z.string().nullable().optional(),
    exitCode: z.number().nullable().optional(),
    error: z.string().nullable().optional(),
    sessionId: z.string().optional(),
    runtime: ScheduleJobRuntimeSchema.optional(),
    verifierVerdict: z.string().optional(),
    dependsOn: z.array(z.string()).optional(),
    originSessionId: z.string().nullable().optional(),
    sourceTabId: z.string().nullable().optional(),
    sourcePromptId: z.string().nullable().optional(),
    epicId: z.string().nullable().optional(),
    statusHistory: z.array(ScheduleJobStatusHistoryEntrySchema).optional(),
  })
  .passthrough();

/**
 * Throws a clear, descriptive error (not a raw ZodError dump) when `job`
 * doesn't match ScheduleJobSchema. Mirrors assertValidPromptSession's shape.
 */
function assertValidScheduleJob(job) {
  const result = ScheduleJobSchema.safeParse(job);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`assertValidScheduleJob: invalid ScheduleJob shape — ${issues}`);
  }
  return result.data;
}

module.exports = {
  ScheduleJobSchema,
  ScheduleJobRuntimeSchema,
  ScheduleJobStatusSchema,
  ScheduleJobStatusHistoryEntrySchema,
  JOB_STATUSES,
  assertValidScheduleJob,
};
