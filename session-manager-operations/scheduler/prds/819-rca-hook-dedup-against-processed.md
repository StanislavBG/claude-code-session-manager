---
title: rcaFeedbackHook idempotency check must also look in feedback/processed/
cwd: ~/Projects/session-manager
estimateMinutes: 15
---

# Goal

`src/main/lib/rcaFeedbackHook.cjs`'s `fileRcaFeedback()` is documented as idempotent per
`(slug, runId)` ("A second call for the same (slug, runId) with no investigationText is a
no-op") — but the check that implements this, `const alreadyFiled = fs.existsSync(destPath)`
(line 317), only tests the deterministic filename inside the **live** feedback inbox
(`dest.dir`, from `resolveDestination(job)`). It never checks
`session-manager-operations/feedback/processed/`. The `/process-feedback` skill's own contract
(this same repo's `session-manager-operations/feedback/README.md` process) requires archiving
every dispositioned item to `processed/` **immediately at disposition time**, not after its
execution verifies — so the moment a triaged RCA item is archived, `fs.existsSync(destPath)`
against the live dir goes false, and the *next* trigger for the identical `(slug, runId)` (e.g. a
periodic `needs_review` re-verify/self-heal pass touching the same still-parked job again) refiles
a duplicate. Confirmed live during a single `/process-feedback` pass on 2026-07-31: RCA items for
slugs `812-verifier-self-recovery-sleep-prefix-normalization`, `812-workbench-review-nits-cleanup`,
`812-rca-self-delegation-failure-class`, and `655-needs-review-rca-feedback-hook` were each
triaged, archived, and then reappeared as fresh duplicate files in the live inbox with the **same
runId** as the one already archived — this is the root cause of that entire recurring class, not
four independent incidents.

# Acceptance criteria

- [ ] `fileRcaFeedback()`'s `alreadyFiled` check also tests whether `fileName` already exists
      under `<feedback-dir>/processed/` (in addition to the existing live-dir check) before
      deciding to file a new RCA — a match in either location counts as "already filed"
- [ ] The `investigationText`-update path (folding an Opus investigation's `<RCA>` summary into
      an existing filed item) also needs to find and update the file wherever it actually lives
      (live dir OR `processed/`) rather than assuming it's always in the live dir — read the
      currently `updated: alreadyFiled` branch (~line 320-338) and adjust so an update targets the
      correct existing path
- [ ] A new unit test in `src/main/__tests__/rcaFeedbackHook.test.cjs` reproduces the confirmed
      incident: file an RCA for `(slug, runId)`, move/copy it to a `processed/` subdirectory (as
      `/process-feedback` does), then call `fileRcaFeedback()` again with the identical
      `(slug, runId)` and no `investigationText` → asserts `filed: false, reason: 'duplicate'` and
      that no new file was created in the live dir
- [ ] Existing "different runId files a new RCA" and "investigationText updates the existing file"
      test cases still pass unmodified
- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 300 npm run test:unit` passes including the new test

# Implementation notes

Read `src/main/lib/rcaFeedbackHook.cjs` in full (359 lines) — specifically `resolveDestination(job)`
(defines `dest.dir`, the live feedback inbox path) and `fileRcaFeedback()`'s existing-file check
around line 296-338. The `processed/` subdirectory is always `path.join(dest.dir, 'processed')` —
confirm this against how `/process-feedback`'s own convention names it (see this repo's
`session-manager-operations/feedback/README.md`). Existing tests are in
`src/main/__tests__/rcaFeedbackHook.test.cjs`.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).

# Out of scope

- Do not change `/process-feedback`'s archive-at-disposition-time contract — that behavior is
  correct and intentional; this PRD makes the hook's dedup check aware of it instead
- Do not touch PRD 817/818's separate verifier/commit-guard fixes
