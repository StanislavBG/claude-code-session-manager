# Validation: events and receipt bounds

Base: aa3cc78785339bb570b46656e634486da93fc2c3. Commits: 69540741 (audit archive), cd75a0af (receipt). Both PRD files found under prds-archived/. /code-review and /security-review were not run as separate commands; I self-reviewed the combined diff of the two PRDs' files (correctness, path traversal, input handling, helper duplication).

## audit-archive-read-bounded — VERIFIED
- MAX_ARCHIVE_GZ_BYTES = 16*1024*1024, exported: auditEvents.cjs (const near line 38, export on last line). loadArchive calls fs.statSync(file).size > maxGzBytes before any readFileSync and returns {rows:[], skipped:true}.
- readEventsAfter takes maxArchiveGzBytes, defaults to the constant (invalid or negative values fall back to it).
- Skipped archive → `gap = archive.skipped || ...`, live rows kept. The test with maxArchiveGzBytes:8 asserts gap true, events live1/live2 only.
- Tests in auditEvents.test.cjs: constant value, over-limit skip, under-limit unchanged. All pass.
- Gate: vitest (auditEvents, eventsAdminRoutes, externalContract.shape) 3 files / 37 tests passed; `npm run typecheck` exit 0.

## epic-job-receipt-one-listing-per-run — VERIFIED
- epicJobReceipt.cjs: one `fsp.readdir(runDir)` per run folder; keeps names ending `.meta.json`; slug taken from the filename and checked against the `wanted` Set; the slug guard (`/`, `\`, `.`, `..`) is unchanged. An unlistable folder is skipped.
- Existing tests, including the path-escaping slug test, still pass.
- New test: 3 run folders, 5 wanted slugs, 2 matching meta files; spies assert exactly 2 meta reads and one listing per run folder.
- Gate: vitest (epicJobReceipt, epicOutsideRead) 2 files / 17 tests passed; typecheck exit 0.

## Findings
Critical: none
Important: none
Minor: none
