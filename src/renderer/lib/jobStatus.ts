// Mirrors ScheduleJobStatus (src/preload/api.d.ts), itself derived from
// JOB_STATUSES (src/main/lib/scheduleJobSchema.cjs) — the renderer can't
// import that .cjs directly, so this union is a manually-kept mirror. Drift
// is caught by src/main/__tests__/scheduleJobStatusDrift.test.cjs.
export type JobStatus = 'pending' | 'running' | 'investigating' | 'completed' | 'skipped' | 'failed' | 'needs_review' | 'quarantined'
