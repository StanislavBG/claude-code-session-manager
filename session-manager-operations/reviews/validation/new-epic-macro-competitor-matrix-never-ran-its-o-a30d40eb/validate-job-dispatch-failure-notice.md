# Validation — job-dispatch-failure-epic-notice (PRD 2950)

Base: unknown (validator PRD had no `Base:` line); commit located via `git log -- <paths>`: **7c376ce7** `feat(macros): durable 'build not queued' notice…` (HEAD of validated tree).

## job-dispatch-failure-epic-notice — VERIFIED

- AC1 notice on ok:false for an indexed Epic: `macroJobIpc.cjs` — `appendNotice` called on not-active refusal (entry.status !== 'active'), on dispatch `ok:false`, and on dispatch throw; text = `${label} background build was not queued: ${error} — press it again in Project Home ▸ Tools to retry.`; label from `BUILTIN_MACROS`, falls back to macroId. Dep wired at `src/main/index.cjs:~626`. Unknown epic (no index entry) → no notice (nothing to append to).
- AC2 no notice on already-building/success: guard `result.ok === false && !result.activeSlug`; test coverage in macroJobIpc.test.cjs (passes).
- AC3 marker key: `promptSessionEvents.cjs:106` `if (meta && meta.notice) event.notice = …` (copy-when-present); `PromptSessionEvent.notice` in `promptSessions.ts`; `api.d.ts` payload type. No zod event schema exists (grep `digestKey` hits only main modules), so `promptSessionSchema.cjs` correctly unchanged. Uses `allowInactive:true` (existing meta) so proposed Epics get the notice; not written onto the event (existing test).
- AC4 append failure never alters result: `appendNotice` try/catch + warn; returns original `{ok:false,error}`. Test "append-failure-keeps-result" passes. Note: if dispatch itself throws, notice is appended and the error is rethrown (original behaviour preserved).
- AC5 amber notice: `EpicDetail.tsx` — `data-testid="epic-job-not-queued-notice"`, aria-label `Notice — build not queued: …`, AMBER_TINT/AMBER_TEXT, excluded from `isSchedulerNotice`.
- AC6 tests: macroJobIpc.test.cjs (+74 lines) and EpicDetail.test.tsx (+26) present.
- AC7 typecheck/lint: pass (below).
- Feedback ACs 1/3/4 untouched: `git log 7c376ce7..HEAD -- src/renderer/lib/launchSession.ts` empty; await-approve-persist ordering from 932284c4/dca31d76 intact (`launchSession.ts` awaitApprovePersisted before dispatchJob).

## Gate results

- PRD gate vitest (4 targets): 27 files / 464 tests passed.
- `npm run lint`: clean (page-stewards clean, e2e budget 18/19).
- `npm run typecheck`: exit 0 (both tsconfigs).
- Full `npm run test:unit`: 984/985 files, 9566 passed, **1 failed**: `src/main/__tests__/epicMint.test.cjs:467` (restore-archived rejects). Cause: environment — the job process carries `SM_PROJECT_ROOT`/`SM_SCHEDULER_JOB_*` vars (known env-sensitive gotcha). Re-run with all `SM_*` unset: 38/38 pass. Files untouched by this plan (last change 3f53546f, unrelated). Classified unowned env-sensitive flake, not a regression.

## Review

`/code-review` / `/security-review` not run as separate agents; self-reviewed the 7c376ce7 diff: no secrets, no path handling added (cwd from existing validated payload), notice text is rendered as React text (no HTML injection), event meta copied by explicit key only.

## Findings

**Critical:** none. **Important:** none.

**Minor**
- `macroJobIpc.cjs` notice `error` text embeds raw dispatch error strings into persisted Epic text; fine, but unbounded length — consider truncation.
- PRD listed `src/main/lib/promptSessionSchema.cjs` in Files; no change was needed (no event schema) — harmless.
- Validator PRD lacked a `Base:` line; commits found by path log.
- Foreign uncommitted `project-pages/*.html` deletions in the worktree were not touched.
