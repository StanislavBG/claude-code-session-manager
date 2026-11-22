# Validation: epic-receipt plan

Base: 1421acb0871e7f492b49adaf914fd454ff85f7a2. Landing commits: c24e0028 (parser), 128783be (job receipt), c5cbc342 (record), 3c317cf0 (route+tool).
Gates re-run: vitest on all six test files (286 passed), `npm run lint:readme` (rc 0), `npm run typecheck` (clean).

## transcript-usage-parser — VERIFIED
- Exports both functions: transcriptUsage.cjs:197. File streamed via readline (:175-195); null when missing/unreadable (:177-180, :191).
- Summary shape (:140-149). Dedup by message.id keeping the largest output_tokens (:62-66). Sidechain (:47) and `<synthetic>` (:61) skipped. A transcript with several rows per id is counted once per call.
- largestContext (:119); models counts per call (:120).
- bySource: model_output (:131), tool:NAME resolved from tool_use ids with `unknown` fallback (:123-129, chars/4 rounded :133), user_prompt excluding tool_result and isMeta (:71, :136); sorted largest first (:138).
- Malformed lines/rows skipped, no throw (:89-102, :160-166).
- Tests cover dedup, sidechain, synthetic, largestContext, tool attribution, unknown, user_prompt, malformed, missing file null (test.cjs:59-100).

## epic-job-receipt — VERIFIED
- `runIdToMs` exported: loopEfficiencyHandlers.cjs:160.
- gatherEpicJobReceipt async, runsRoot defaults to runsDir(): epicJobReceipt.cjs:27-30.
- Filters runIdToMs >= sinceMs (:43), reads SLUG.meta.json per slug, requires meta.cwd === cwd (:46-47). Slugs containing path separators are rejected (:34).
- Return shape and byPrd sorted by slug (:28, :73-75); non-numeric cost adds a run but not cost/costKnownRuns (:53-59).
- Never rejects, skips missing/unreadable/malformed (:29, :39, :17-19, :76).
- Tests: two attempts, other-project slug, pre-sinceMs, null cost, missing folder (test.cjs:27, :63).

## epic-receipt-in-record — VERIFIED
- Receipt only when `receipt === true`: epicOutsideRead.cjs:243; otherwise record is returned untouched, and no run folder or transcript is read (computed lazily, nothing before :243). Computed only when asked for.
- jobs: gatherEpicJobReceipt over the Epic's job slugs, sinceMs = createdAt (:156-171); zero result when no jobs.
- chat: summarizeTranscriptFile of resolveEpicTranscriptPath result, null when no path / existsAnywhere false (:175-185).
- Works for archived Epics (:236-244 shared path); each part wrapped in try/catch giving null.
- listOpenEpicRecords contains no receipt reference (grep clean).
- Tests: epicOutsideRead.test.cjs:230, :243, :272, :290, :313.

## epic-receipt-on-route-and-tool — VERIFIED
- adminGetEpicQuery receipt: true only for '1'/'true' (ipcSchemas.cjs:632).
- Route passes `receipt: input.receipt === true` (epicAdminRoutes.cjs:91); epic.receipt only present when asked.
- epic_get has optional boolean `receipt` (scheduler-mcp-server.cjs:422), sets receipt=1 (:1006); `required: ['cwd']` unchanged; lint:readme passes.
- Tests: epicAdminRoutes.test.cjs:201, :223.

## Review of the combined diff
`/code-review` and `/security-review` not run separately (self-review): slugs are validated against path traversal before building file paths; query input is schema-bound; no secrets; no duplicated helper (reuses runIdToMs, resolveEpicTranscriptPath).

## Findings
- Critical: none.
- Important: none.
- Minor: none. (Note: the epic-receipt-in-record test names are on one line each; no test for a slug with path separators in epicJobReceipt — optional hardening, not required by the PRD.)
