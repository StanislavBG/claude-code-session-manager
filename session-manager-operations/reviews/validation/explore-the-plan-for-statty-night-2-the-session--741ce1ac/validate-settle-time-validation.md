# Validation: settle-time validation plan

Base: 947b2a25 (from the PRD notes). Commits b4abb53d..7a43ac7d (6). PRD files found in `prds-archived/` (1996–2001).
Gates re-run (scratch TMPDIR): vitest on epicSettle, epicSweepValidator, epicValidationHook, promptSessionEvents, scheduler-notify-originating-tab → 5 files / 73 tests pass; `npm run typecheck` exit 0; `npm run lint:docs` ok (21 junctions, 34 files). `CLAUDE.md` = 11971 chars (<12000).

## epic-settle-evaluator — VERIFIED
- `src/main/lib/epic/epicSettle.cjs:27-103` pure (only node:crypto + bareSlug), returns the 8 specified keys.
- settled = no pending/running among epic rows (`:33-36`, epicId/sourcePromptId + cwd filter).
- Validator exclusion `:21-22,59`; covered iff verdict `t >= check-in t` (`:90`); window = max(newest digest, now−24h) (`:42-48,55`); digestKey sha1 16-hex of sorted lists (`:96-99`).
- `promptSessionEvents.cjs:104-105` copies agentType/digestKey only when present; doc comment `:72-74`. `scripts/lib-layout.json` has epicSettle + epicSweepValidator.
- Tests present in `epicSettle.test.cjs`, `promptSessionEvents.test.cjs`; gate green.

## epic-sweep-validator-input — VERIFIED
- `epicSweepValidator.cjs:13-14,19-22` constants + isSweepValidatorSlug (NN- prefix tolerant, non-strings false).
- `:30-72`: input fields agentType validator, tag build, estimateMinutes 10, gate ['none'], sourcePromptId, cwd, slug `validate-sweep-yyyymmddhhmm` (UTC), dependsOn bare slugs, files = [record path], carried = overflow past 25; empty → `{input:null, carried:[]}`.
- Persona line + `Base: <sha>` / `Base: unknown …` at `:56-57,46-48`; no gate fence / `# Gate` / `# Files` text in any string.
- Gate green.

## epic-settle-runner-digest — VERIFIED
- `epicValidationHook.cjs:49-81` buildSettledDigest (starts "PLAN SETTLED", sections omitted when empty, record folder, no re-verify line).
- `:97-180` runEpicSettle: gates disabled / not active / not settled / no content / same digestKey (`:110-128`); sweep guard via dependsOn of sweep rows in jobs+history (`:133-138`); one createPrd, no prompt on ok (`:157-161`); refused/throwing/all-swept/empty-uncovered → one sendPrompt + digest marker event (`:162-175`).
- `:189-210` scheduleEpicSettle: per-key debounce, unref, running guard, default 120 s via SM_EPIC_SETTLE_SECONDS.
- Tests in `epicValidationHook.test.cjs`; gate green.

## wire-epic-settle-into-scheduler — VERIFIED
- `scheduler.cjs:3022-3043` defaultScheduleSettle with the specified deps (readQueue, readHistory limit 500, prdCreate.createPrd(input, remote), rev-parse `commit^` → null on error, enqueueExternalPrompt, appendResponseEventIfKnown).
- `:3083` option `scheduleSettle`; enqueueValidation/loadJobs options removed; `:3196` agentType in meta; `:3199-3210` scheduleSettle called once only inside `if (routed)`, in try/catch, for validators too. `hasDownstreamValidator` still required (`:105`) and used at `:5628`.
- Call site `:6862-6866` no longer passes loadJobs; jobsSnapshotForNotify removed.
- Tests in `scheduler-notify-originating-tab.test.cjs`; gate green (incl. typecheck).

## remove-per-prd-validation-prompt — VERIFIED
- `rg 'maybeEnqueueValidationPrompt|buildValidationPrompt' src` → no source hits (only plain-text matches absent; name-absence test exists in epicValidationHook.test.cjs). Module exports are exactly buildSettledDigest, runEpicSettle, scheduleEpicSettle, __resetSettleForTests (`:218-223`).
- Header doc (`:3-20`) describes only the settle runner, both env vars, and "spawns NO process itself".
- Gate green.

## doc-develop-settle-validation — VERIFIED
- SKILL.md validate section: queue last, no per-PRD prompt, settle/sweep/digest explained in 5 lines; Phase 2 rule 3 merged into one "PLAN SETTLED digest" item; persona-missing paragraph points at Not validated. SKILL.md net +1 line (11+/10−).
- `scheduler-operations.md` §4a "Validation messaging into the Epic" (trigger, debounce, sweep guard, digestKey dedup, 24 h horizon, kill switch, no boot sweep) + diagnosis row "Epic got no PLAN SETTLED digest". Numbered as 4a (no renumbering → cross-links safe). `lint:docs` ok.

## Plan-level checks
1. **Incident replay** (starry-night-2 Epic `game-design-…-d14c9377`, read-only; active-index events=89, queue rows=13: 12 pending + 1 running): `settled:false`, uncovered 18, verified 7, refuted 0; `runEpicSettle` with injected fakes → `{action:'none', reason:'not-settled'}`, **0 prompts, 0 createPrd, 0 appends**. Matches expectation. (Hypothetical, all rows terminal: one sweep createPrd, still 0 prompts.)
2. **No per-PRD prompt path**: `rg 'enqueueExternalPrompt|sendPrompt'` → epicValidationHook.cjs:169 (digest only, after settle gates); scheduler.cjs:3039 (settle dep), :3079/:3237 (pre-existing fallback in notifyOriginatingTab, reached only when the check-in append was refused; not a validation prompt; see Minor 1). No call sends one per finished PRD.
3. **Loop guard / fallback**: sweep validator check-ins are excluded from `uncovered` (agentType validator, or `validate-` prefix) — epicSettle.cjs:21-22; slugs in any sweep row's dependsOn (jobs + history) are never swept again (hook :133-138, → digest with "already ran" reason); a settle with a sweep still pending is not settled. Refused/throwing createPrd → exactly one digest + marker, and the same digestKey blocks a repeat (hook :124-128). Covered by tests.

## Findings
### Critical
- none
### Important
- none
### Minor
1. `scheduler.cjs:3237` — when the check-in append is refused (completed/unknown Epic) the original per-job `message` is still sent via sendPrompt. Pre-existing, unrelated to validation, and only on that refusal path; not a flood source.
2. Sweep guard depends on `readHistory({limit: 500})` (scheduler.cjs:3033); in a very busy project a completed sweep row older than 500 history rows could be forgotten and its slugs re-swept. Unlikely; digest dedup does not cover this.
3. If a sweep validator exits without emitting verdicts, its PRDs surface only as "Not validated" in one digest — by design, noted for completeness.
4. `.../scheduler-operations.md` uses "4a" rather than a new numbered section (deliberate per PRD; fine).
