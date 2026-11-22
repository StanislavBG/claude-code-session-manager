# Validation: external-contract-doc + external-contract-shape-test

Base: 1421acb0871e7f492b49adaf914fd454ff85f7a2. Commits: 0abe51b6 (doc, README, conventions), d2f9305f (manifest + shape test).
Method: read PRDs 3334/3335, read the doc against the code, re-ran every gate. Self-review of the diff (docs + one manifest, no new input handling or secrets).

## external-contract-doc — VERIFIED

- File exists; README.md index row `external-contract.md … REFERENCE` added (0abe51b6). Gate `npm run lint:docs`: "doc-hierarchy: ok (21 junctions, 36 files linted)", exit 0.
- Discovery: admin-api.json fields port/token/appVersion/contractVersion, 0600 and `.dev`/`.e2e` file names match localAdminHttp.cjs (lines 15-28, 111); 404 `unknownRoute` + versions at localAdminHttp.cjs:152-160; version rule and "stop loudly" advice present (§1).
- Handoff: externalRef regex/1–200/trim at epic/externalRef.cjs:13-34; open-session `status:'existing'`, `existing:true`, note text at crossProjectFeedback.cjs:655-660; macro run repeat answer `{ok,epicId,existing,alreadyRunning,externalRef}` at macroAdminRoutes.cjs:442, first-run answer :520, 409 at :456, 503 at :412. One request and answer example each present.
- Reads: routes, query limits and answer shapes match epicAdminRoutes.cjs:6-11,75-81; tools epic_list/epic_get at scheduler-mcp-server.cjs:400,414; record fields equal CONTRACT.epicRecordFields (all 17 documented); eight states table equals CONTRACT.epicStates; blocked kinds refuted/failed/needs_review/quarantined at epicOutsideState.cjs:62,145-148; REASON_MAX 300 at :30; receipt fields match epicJobReceipt.cjs:23-75 and transcriptUsage.cjs; refuted-until-same-PRD-verified rule documented.
- Events: epic_state_changed row fields from epicStateWatcher.cjs:70-73 plus `at`/`kind` from auditLog.cjs:138-139; `gone` at watcher :80-82; first run seeds only (:116); `/admin/events` answer `{ok,events,next,more,gap}` at eventsAdminRoutes.cjs:44; caller stripped at auditEvents.cjs:149; OUTSIDE_EVENT_KINDS = epic_state_changed, job_transition (:30). Gap handling documented.
- Not-contract section present (§5). conventions.md gained the one-line versioned-contract convention (0abe51b6).
- Manifest-vs-doc: every CONTRACT route, tool, state, record/receipt/row field, event kind and admin-api field appears in the doc. No doc name was found missing from the tree.

## external-contract-shape-test — VERIFIED

- CONTRACT frozen (deepFreeze) with routes, tools+required, epicStates, epicRecordFields, receiptFields, epicStateChangedFields, eventKinds, adminApiFields (externalContract.cjs:38-60).
- contractFingerprint() sha256 of stable-key JSON (:62-72); CONTRACT_FINGERPRINTS has one entry, version 1 (:74-77).
- Shape test exists (162 lines) and checks fingerprint, routes on a fake adminHttp, tools vs TOOLS, states, event kinds, record/receipt keys.
- Gate: `npx vitest run …shape.test.cjs …externalContract.test.cjs` → 2 files, 9 tests passed. `npm run typecheck` → exit 0.

## Findings

Critical: none. Important: none.

Minor:
- src/main/lib/externalContract.cjs:57 — `epicStateChangedFields` omits `at` and `kind`, which the doc (§4) lists; the doc is a superset, so no drift, but the fingerprint does not pin them (they come from auditLog.cjs:138-139).
- src/main/lib/externalContract.cjs:51 — `epic_get` required is `['cwd']` only; the "exactly one of id/externalRef" rule is not pinned by the manifest.
