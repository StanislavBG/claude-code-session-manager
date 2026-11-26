# Validation — job sandbox limits plan (4697–4699)

Base: unknown in the PRD (no `Base:` line); used `a22e243b`, the parent of the first plan commit `dbed25a4`.
Plan commits: `dbed25a4` (4697), `bc36e0bd` (4698), `922859d9` (4699). The other commits in `a22e243b..HEAD` (`59b801ae`..`4d0d438d`, service pairing) belong to other plans and were not judged.

## 4697-prd-authoring-sandbox-limits — VERIFIED

- ac-1: `src/main/templates/PRD_AUTHORING.md:157-165` `### Job sandbox limits` sits inside §7. It states the `.claude/` Bash refusal (git mv/git rm/rm, the Write+Edit shim, or leave deletion to a human), the AF_UNIX refusal (`Operation not permitted`), read-only `/tmp` with only `$TMPDIR` writable, and the gate rule. These facts match `environmentProfiles.cjs:98-106` JOB_WRITE_ROOTS (no `/tmp`, `{tmp}` is the private dir) and `jobSandboxPolicy.cjs:393-395` (TMPDIR/TMP/TEMP set to tmpDir).
- ac-2: `PRD_AUTHORING.md:261` adds the §14 line `§7 Job sandbox limits … (see [Job sandbox limits](#job-sandbox-limits))`.
- ac-3: line 1 is `<!-- PRD_AUTHORING.md v32 -->`, pinned by `prdAuthoringSeed.test.cjs:41-49`.
- ac-4: gate `npx vitest run src/main/__tests__/prdAuthoringSeed.test.cjs` gave 6/6 passed; `npm run lint:docs` gave `doc-hierarchy: ok (27 junctions, 55 files linted)`.
- No renumbering: the diff only adds lines, and no `## §N` heading changed.

## 4698-prd-create-sandbox-claude-dir-warning — VERIFIED

- ac-1: `src/main/lib/prd/prdSandboxWarnings.cjs:20-31`. The warning names the paths, says "refused by the job sandbox", recommends Write/Edit, and links `PRD_AUTHORING.md#job-sandbox-limits`. That anchor now exists (4697).
- ac-2: `VERB_RE` at `prdSandboxWarnings.cjs:8`. Tests `prdSandboxWarnings.test.cjs:27-38` cover the matches (`rm -rf x`, `` `rm x` ``, `git rm`) and the non-matches (`form`, `confirm`, `perform the rmdir`). A probe confirmed `perform`/`confirm`/`form` give 0 warnings.
- ac-3: `prdCreate.cjs:1097` (dryRun) and `:1189` (write result) both spread `sandboxWarnings(input)`. The batch path goes through `createPrdInner`. `prdSandboxWarnings.test.cjs:41-63` proves the warning appears in a `createPrdBatch` result.
- ac-4: gate `vitest … src/main/lib/prd/__tests__` gave 17 files / 180 tests passed; `npm run typecheck` exited 0.

## 4699-autofix-skip-sandbox-environment-limits — REFUTED

- ac-1: `src/main/lib/scheduler/sandboxEnvironmentLimit.cjs:12-16` implements the three narrow regexes. Tests `sandboxEnvironmentLimit.test.cjs` cover the incident strings and the negatives (plain EACCES, the bare word "sandbox", a read-only `/etc`) and pass.
- ac-2: The failed path works: `scheduler.cjs:9849` passes `environmentLimit` into `classifyFailureOutcome`, which returns `fail-environment` at `:5009`. The `:9861` branch only sets the error and never calls `spawnInvestigation`. The needs_review path works too: `reviewLadder.cjs:946` skips the row, which also covers `isEligibleForImmediateAutoFix` (`:1004-1010`, used at `scheduler.cjs:9656` after the stamp at `:9579`). The row is stamped `environmentLimit` and gets `ENVIRONMENT_LIMIT_MESSAGE`.
- ac-3: `src/main/scheduler/__tests__/autoFixEnvironmentLimit.test.cjs:8-12`. Gate vitest gave 14 files / 118 tests passed.
- ac-4: `scheduleJobSchema.cjs:118-119` declares the field; typecheck exited 0.
- **Why REFUTED:** detection runs over `readTail(logPath, 16384)` (`scheduler.cjs:6997-6998`), and that log is **stream-json** (`scheduler.cjs:5886`). In stream-json every event is one physical line and newlines inside it are escaped as `\n`, so the `[^\n]{0,80}` bound no longer limits a match to one line. Any text the job only *read* can match, not just a real refusal.
  - Probe: the shipped `PRD_AUTHORING.md` "Job sandbox limits" section, wrapped as a tool_result JSON line, returns `{ kind: 'claude-dir-write', evidence: 'sandbox, so a gate or step must not depend on any of these:\\n- Bash writes under `.claude' }`.
  - Result: a job that Read or Grepped sandbox-related docs or code in its last 16 KB and then failed for an ordinary reason, such as a red test, gets stamped `environmentLimit`. Its real error is overwritten (`scheduler.cjs:9581`) and it gets no auto-fix. Validator criterion 3 ("narrow enough not to catch ordinary test failures") is not met in this repo, which edits sandbox code often.

## Gate (this PRD)

`timeout 600 npm run typecheck` exited 0.

## Findings

### Important

1. `src/main/scheduler.cjs:6997` and `src/main/lib/scheduler/sandboxEnvironmentLimit.cjs:12-16` (4699, behavior-wrong): the detector scans raw stream-json, where `[^\n]` does not bound a match to one line. Text the job read, including `PRD_AUTHORING.md`'s own new section, is classified as a sandbox refusal. That suppresses auto-fix and replaces the row's real error. Fix: scan only tool_result error content or the final `SCHEDULER_VERDICT: FAIL` reason, or JSON-parse each event and match its decoded text line by line (and also accept `\\n` as a boundary).

### Minor

2. `src/main/scheduler.cjs:9861` (4699, missing-test): no unit test covers `classifyFailureOutcome` returning `fail-environment`, the finalize stamp/clear, or the absence of `spawnInvestigation` on that branch. I verified those only by reading the code.
3. `922859d9` trailer (4699, other): "Follow-up: add #job-sandbox-limits section to PRD_AUTHORING.md (the notice links to it; not in this PRD's Files)". 4697 (`dbed25a4`) has already resolved it.
4. `src/main/lib/prd/prdSandboxWarnings.cjs:8` (4698, behavior-wrong): a bare `rm` at the end of text (e.g. "remove it with rm") does not match, because `\s` is required after `rm`. This is a false negative only; the warning is advisory.
5. `src/main/templates/PRD_AUTHORING.md:159` (4697, docs-drift): "jobs run under the CLI OS sandbox" is unconditional. The `open-web` profile (`environmentProfiles.cjs:134-136`, `osSandboxRequired: false`) and the `tool-rules` level run without it. Consider "sandboxed jobs (the default dev-lead/validator profiles)".
6. `src/main/lib/prd/__tests__/prdSandboxWarnings.test.cjs:45` (4698, other): `config.addAllowedRoot(cwd)` mutates process-global config and the temp dir is never removed. This matches existing prdCreate tests, so it is low impact.
