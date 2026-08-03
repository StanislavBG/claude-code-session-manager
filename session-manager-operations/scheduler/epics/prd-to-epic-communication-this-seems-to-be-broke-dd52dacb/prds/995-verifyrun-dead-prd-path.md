---
title: verifyRun is handed a PRD path that does not exist — it cannot read the acceptance criteria it verifies against
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 45
sourcePromptId: prd-to-epic-communication-this-seems-to-be-broke-dd52dacb
---
# Goal

PRD 985 fixed `prdPathForJob`'s retired-flat-dir bug in the two notify functions, but left three other call sites untouched — and two of them feed the VERIFIER. `scheduler.cjs:2890` (the live post-run `verifyRun`) and `:3798` (`reverifyNeedsReview`'s `verifyRun`) both pass `prdPath = prdPathForJob(job)`, which resolves to `resolvePrdWriteDir(cwd)` — the retired flat `<cwd>/session-manager-operations/scheduler/prds/` dir that today holds only zero-byte `.reserved-NNN` stubs and no PRD at all. Every Epic-scoped PRD therefore hands the verifier a nonexistent path, so it cannot read the acceptance criteria it is supposed to verify against. This is very likely degrading verification quality on every single job, silently.

# Acceptance criteria

- [ ] QUANTIFY FIRST, before changing anything: determine what `verifyRun` actually does when `prdPath` does not exist — which checks it skips, whether it silently degrades to a transcript-only scan, and whether any verdict it can return depends on the PRD body. Record the finding in the completion report. If it turns out verifyRun never reads prdPath at all, say so plainly and close this PRD as a no-op rather than inventing a fix.
- [ ] Assuming the path IS used: `scheduler.cjs:2890` and `:3798` resolve the PRD via the same live-then-archived lookup PRD 985 added — the exported `resolveNotifyPrd` helper, or a shared path-only variant of it if verifyRun wants a path rather than a parsed object. Do NOT duplicate the resolution logic a third time.
- [ ] `scheduler.cjs:2174` (executeJob's `prdPath`) is audited in the same pass. It already tries `resolvedDir` first and only falls back to `prdPathForJob`, so it may be correct — confirm and state which, rather than changing it reflexively.
- [ ] A regression test proves the verifier receives a REAL, existing path for an Epic-scoped PRD (live dir) and for an archived one — exercising actual path resolution against a temp tree, not a stubbed resolver. Every pre-existing test around this code stubs the lookup, which is exactly why two rounds of this bug shipped green.
- [ ] If `prdPathForJob` ends up with no remaining correct caller, delete it rather than leaving a loaded gun in the file. If it does retain a legitimate caller, add a doc comment naming that caller and warning that it resolves the RETIRED flat dir.
- [ ] `npm run typecheck`, `npm run lint:selectors`, and `npm run test:unit` all pass.

# Implementation notes

Main-process only. Read the appended standards file first.

BACKGROUND — verified by direct inspection on 2026-08-03, but re-confirm before relying on it:
- `session-manager-operations/scheduler/prds/` contains ONLY `.reserved-NNN` zero-byte stubs. Zero `.md` files. That is where `prdPathForJob` points.
- `grep -n "prdPathForJob(job)" src/main/scheduler.cjs` returned three remaining call sites after PRD 985: `:2174`, `:2890`, `:3798`.
- PRD 985 (commit 95b8a9a) added `resolveNotifyPrd(job, parsePrdRaw)` at ~scheduler.cjs:1845 — live Epic-scoped dir via `findPrdDir`, then the archived twin via `archivedPrdPathForJob`. Reuse it.

Key files/lines:
- `src/main/scheduler.cjs:2890` — the live verify call site, inside spawnJob's post-run block.
- `src/main/scheduler.cjs:3798` — `reverifyNeedsReview`'s call site.
- `src/main/scheduler.cjs:2174` — executeJob's `prdPath` (likely already correct via `resolvedDir`).
- `src/main/runVerify.cjs:702` — `verifyRun`'s signature; trace how `prdPath` is consumed inside it. That trace IS acceptance criterion #1.
- `src/main/lib/prdLocations.cjs:90` — `resolvePrdWriteDir`, the retired-flat-dir resolver behind `prdPathForJob`.

WHY THIS MATTERS beyond tidiness: PRD 983 (commit aa482d1) traced a false green to the verifier concluding `clean` on a run that did nothing. A verifier that cannot read the PRD's acceptance criteria has strictly less evidence to contradict a bad run with — so this defect plausibly widens every verification hole the scheduler has, including the one 983 just patched at the heal layer. Establishing the real blast radius (AC #1) is the most valuable part of this PRD; the code change may well be small.

# Out of scope

- Changing runVerify.cjs's verdict logic or thresholds
- The commit-guard dirty-tree precondition (separate PRD)
- Re-touching the two notify functions PRD 985 already fixed
- Backfilling verdicts for historical runs

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
