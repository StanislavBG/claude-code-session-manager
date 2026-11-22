# Validation: external-ref handoffs (PRDs 3309–3313)

Base: 385d8b21. Commits: 6251931c (schema), 44a23502 (index), 1bc9a8f8 (feedback), a449a739 (renderer), d1cb9a82 (macro-run).
All PRD files found under prds-archived/. Gates re-run in the foreground: one vitest run over all ten gate test files: 10 files, 490 tests passed; `npm run typecheck` exit 0.

## external-ref-schema — VERIFIED
- promptSessionSchema.cjs:51 `externalRef: z.string().optional()` (no length/char rule, comment at :49).
- promptSessions.ts:42-43 `externalRef?: string` with doc comment.
- api.d.ts:2884 and :3000 both declare `externalRef?: string` (create payload source + onExternalNewSession event).
- epic/externalRef.cjs: EXTERNAL_REF_MAX=200, PATTERN `[A-Za-z0-9._:/@-]{1,200}`, normalizeExternalRef: null/undefined→ok undefined, non-string→error, trim, never throws. Test file passed.

## external-ref-index — VERIFIED
- schedulerPaths.cjs:111 `externalRefIndexPath()` = schedulerHome()/external-refs.json via assertNotLiveRoot; exported :203.
- externalRefIndex.cjs: key `cwd\0ref`; `{version:1, refs}`; optional fields omitted (cleanEntry); writes via writeJsonAtomic on a serialized promise chain; lookup returns entry/null per cwd.
- findEpicByExternalRef: open flag from readActiveIndex(cwd).sessions; miss scans sessions' source.externalRef, records with producer/fromCwd/macroId, returns open:true; else null.
- withExternalRefLock: per-key promise queue, different keys concurrent, passthrough of result/rejection, `finally` releases.
- Corrupt/missing file → empty (readIndexFile); no-throw on bad file (record rejects only on invalid arguments, by design).

## external-ref-feedback-handoff — VERIFIED
- crossProjectFeedback.cjs:472 normalizeExternalRef in validateFeedbackInput; value.externalRef :480.
- :746 source.externalRef on mint; :830 in result; :666 recordExternalRef (producer cross-project-feedback, fromCwd).
- :641-664 repeat with same fromCwd/producer returns `{ok, epicId, status:'existing', existing:true, externalRef, toCwd, fromCwd, note}` before mintFeedbackSession, so no mint, no auto-start grant, no receipt/audit.
- :644-651 different producer/fromCwd → 409.
- :641 whole lookup+mint inside withExternalRefLock.
- scheduler-mcp-server.cjs:572-574 optional string property with rule + repeat description. Tests present and green.

## external-ref-new-session-path — VERIFIED
- launchSession.ts:24 input field; :73 added to runtime when non-empty string.
- promptSessions.ts:338 runtime type; :654-660 source `{producer:'new-epic-ui', macroId?, externalRef?}`, no source if neither.
- remoteNewSession.ts:22,49 destructures and forwards only when non-empty string.
- Tests in remoteNewSession.test.ts and promptSessions.test.ts green.

## external-ref-macro-run — VERIFIED
- macroAdminRoutes.cjs:353-362 normalize (invalid → 400 before launch); runWithExternalRef :439.
- Payload includes externalRef (:483); recordExternalRef producer new-epic-ui + macroId (:506); audit row has externalRef (:512-519); answer `{ok, epicId, alreadyRunning:false, externalRef}` (:520).
- Repeat → `existing:true, alreadyRunning: isTabBusy` (:441-443,:464), no audit row; producer/macroId mismatch → 409 (:455-462).
- Keys `cwd\0macro\0ref` (:445); findRunningEpic shortcut not on this path; all inside withExternalRefLock; in-flight share (:446-452).
- No-ref path untouched (branch at :362); existing tests green.

## End to end (code-path read)
- /admin/macros/run → payload.externalRef (macroAdminRoutes:483) → chatRunner.startExternalNewSession spreads payload into `chat:external-new-session` (chatRunner.cjs:1239) → preload forwards payload whole (index.cjs:577-579) → remoteNewSession.ts:22/49 → launchSession.ts:73 → createPromptSession promptSessions.ts:654-660 sets source.externalRef → ipcSchemas.cjs:235 uses full EpicSourceSchema (keeps key) → ensureEpic stores `source` (epicMint.cjs:434). Reaches stored source: yes.
- feedback_open_session → validateFeedbackInput → mint(v.toCwd, {source:{..., externalRef}}) (crossProjectFeedback:746) → ensureEpic stores source in the receiving project (epicMint.cjs:434). Yes.

## Findings
- Critical: none.
- Important: none.
- Minor: macroAdminRoutes.cjs:506-511 swallows a recordExternalRef failure with console.warn (acceptable; open-Epic scan covers it, but a completed Epic would then be re-launched on repeat). 
- Minor: crossProjectFeedback.cjs:666 a failed recordExternalRef after a successful mint rejects the promise even though the Epic exists (inconsistent with the macro route); a retry would still dedupe via the open-session scan.
- Review method: /code-review and /security-review not run as separate skills; self-reviewed the diff for these paths: ref charset (no NUL, no path chars beyond `/`, `.`) is used only as a JSON object key, never as a path; no secrets; reuses atomicFs and existing run-key convention.
