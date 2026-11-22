# Validation: outside-contract cleanup (PRDs 3357-3364)

Base: 9633e4aa0d2fea1ae70f670e48f6c1c036acf8fc. Combined branch diff is dominated by unrelated claude-config renderer work; only the PRDs' files were reviewed.
Gates re-run in the foreground: one vitest run over all gate test files (47 files, 571 tests, all pass), `npm run typecheck` (exit 0), `npm run lint:docs` (ok), `npm run lint:readme` (exit 0).

## epic-state-counts-finished-prds — VERIFIED
- `knownPrdSlugs` defined at src/main/lib/epic/epicOutsideState.cjs:112, exported at :233; union of live rows and check-ins.
- Tests (incl. 22-PRD verified case, live row wins, failed check-in blocks, re-run clears) in epicOutsideState.test.cjs; pass.
- external-contract.md rows for `verified` (line 198) and `in_review` now say finished PRDs come from check-in events too (diff checked).

## epic-receipt-slugs-from-events — VERIFIED
- src/main/lib/epic/epicOutsideRead.cjs:162 passes `knownPrdSlugs({ session, events, jobs })`; events passed from both the open path and the archive path (lines 230-248).
- Receipt tests in epicOutsideRead.test.cjs pass.

## contract-manifest-pins — VERIFIED
- externalContract.cjs:63 lists at, kind, cwd, epicId, from, to, blockedKind, externalRef; :55 epic_get has requiredOneOf [['id','externalRef']].
- Fingerprint replaced for v1 with comment at :84; CONTRACT_VERSION unchanged. Both test files pass.

## events-cursor-error-code-and-boundary-test — VERIFIED
- auditEvents.cjs:39,47,163 (constant, code, export); eventsAdminRoutes.cjs:34 decides on the code; `INVALID_CURSOR_PREFIX` has no remaining hit.
- Boundary and code tests present in auditEvents.test.cjs; route 400 test passes.

## external-ref-record-failure-consistent — VERIFIED
- crossProjectFeedback.cjs:672 and macroAdminRoutes.cjs:526 add `externalRefRecorded: false` only on failure after a retry; tests pass.

## admin-404-stable-app-version — VERIFIED
- localAdminHttp.cjs:160 `appVersion: appVersion ?? null`. scripts/scheduler-mcp-server.cjs has no diff since base.

## epic-job-receipt-slug-guard-test — VERIFIED
- Guard at epicJobReceipt.cjs:33-34; new escape-slug test passes; file has no diff since base.

## plugin-version-bump-for-develop-rule — VERIFIED
- plugin.json and marketplace.json both 0.4.3 → 0.4.4; diff shows no other field changed. Gate green.

## Outside-contract input review (whole files)
Files read: epicAdminRoutes.cjs, epicOutsideRead.cjs, epicJobReceipt.cjs, externalRefIndex.cjs, auditEvents.cjs, eventsAdminRoutes.cjs.
- Path from an id / externalRef / slug: epicId → `readArchived` requires ID_RE and refuses `active-index` before joining (promptSessionsIpc.cjs:118); query id is capped at 200 chars. externalRef is normalized by `normalizeExternalRef` and used only as an index key, never in a path. Receipt slugs (now derived from event payloads) are filtered for `/`, `\`, `.`, `..` (epicJobReceipt.cjs:33) and tested. cwd must be absolute, registered, and goes through `opsPath`. Archive file name in auditEvents is built from a fixed regex, not input.
- Unbounded reads: list limit capped at 200 and audit limit at 500; query strings are length-capped by schema. The live audit file is read in a doubling tail window that can grow to the whole file when the cursor is old; the rotated archive is gunzipped whole in memory; the Epic archive JSON, the index file and the run `*.meta.json` files are read with no size cap (see Minor).
- Bearer token: no `token`, `Bearer`, console or log call in any of the six files; error answers carry only fixed or schema messages.

## Findings
Critical: none
Important: none
Minor:
- src/main/lib/telemetry/auditEvents.cjs:94 gunzips the newest archive fully in memory with no size or output bound (a very large archive could spike memory).
- src/main/lib/telemetry/auditEvents.cjs:60-75 the live-file window can double up to the whole file for an old cursor, with no byte ceiling.
- src/main/lib/epic/epicJobReceipt.cjs:18 and src/main/promptSessionsIpc.cjs:120 read run metadata and Epic archive JSON with no size check (inputs are app-written, so low risk).
- src/main/lib/epic/epicJobReceipt.cjs:44-46 reads every run folder × every known slug, so cost grows with runs × PRDs on a receipt request.
