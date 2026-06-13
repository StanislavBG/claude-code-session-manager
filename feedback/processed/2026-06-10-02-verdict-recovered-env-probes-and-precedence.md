---
title: Demote recovered env-probe tracebacks + let materially-checkable verdicts outrank pattern hits
source: Self project (interactive session triaging downgraded Self PRDs)
type: bug
severity: normal
---

> Filed as an addendum to `2026-06-10-01-verdict-scanner-false-positive-importerror`
> but reused that item's exact filename (convention violation — see README lesson).
> Re-homed here as item `-02` because it raises new, independently-actionable asks.

## Addendum (2026-06-10 evening) — Traceback detector, 3 more false positives + 1 masked real issue

Three more Self PRDs were downgraded the same day by the Traceback detector: `26-self-billbot-shared-lib`, `26-self-parser-tests`, `27-self-billbot-port-remaining` — all exit 0, `result: success`. The flagged "Tracebacks" were **environment probes during setup** (`ModuleNotFoundError: No module named 'playwright'` while the agent searched for the right interpreter, `pip3: command not found`, a conftest import probe), all recovered from within the run.

Crucially, `27-self-billbot-port-remaining` had a **real** problem — it died before its mandated commit, leaving 5 ported files uncommitted (recovered manually as Self commit `edf9d4e`). The scheduler's commit-guard (`scheduler.cjs:1319`) is exactly the right detector for that, but the noisy transcript-pattern verdict gave the same `needs_review` label for a non-issue, so true and false alarms are indistinguishable in the queue. Suggest: when multiple verdicts fire, prefer the materially-checkable one (commit-guard / AC-command exit codes) in `error`, and demote pattern-only hits to an annotation.

## RESOLUTION (2026-06-11, processed by Claude)

Root-caused against the three real run logs (still on disk under `~/.claude/session-manager/scheduled-plans/runs/`). All three "Tracebacks" were `Traceback … → ModuleNotFoundError: No module named '<x>'` (playwright / pip / ensurepip / conftest) — i.e. **missing-dependency probes**, not logic failures — in runs that ended `result: subtype: success` with genuine deliverable summaries. The agents recovered by interpreter/venv search (`~/.venv/billbot/bin/python`, `uv … Installed pytest 9.0.3`), which the existing recovery heuristics (`hasInstallRecovery` = pip/uv only; `isSelfRecovered` = same-description re-run) don't model.

Two root causes, both fixed:

**1. Misclassification (`src/main/runVerify.cjs`, `detectPattern`).** A Python `Traceback` whose *terminating exception* is `ModuleNotFoundError`/`ImportError` is now classed `verify_unavailable` (the "verification couldn't run" / missing-dependency class), not `transcript_errors`. A Traceback ending in any other exception (`KeyError`, `AssertionError`, …) **stays `transcript_errors`** — that is the real false-PASS class the verifier exists to catch (2026-05-23 incident; item 01 ask 3 decline).

**2. `verify_unavailable` is success-gated (`runVerify.cjs`, `verifyRun`).** When the run reached a genuine `result: subtype: success`, an un-recovered missing-dependency hit is recorded as a non-blocking **annotation** instead of downgrading to `needs_review`. `transcript_errors` is **never** demoted this way, so the false-PASS guard is fully intact. A missing-dependency hit in a run that did **not** succeed still flags `needs_review` (new regression test). This is the narrow form of item 01's declined ask 3: success rescues only the weakest "couldn't-verify" class, never a real failure.

**3. Verdict precedence + always-run commit-guard (`src/main/scheduler.cjs`).** The commit-guard was previously skipped whenever any transcript verdict fired (`verifyResult.verdict === 'clean'` gate) — which is exactly why `27-self-billbot-port-remaining`'s real uncommitted-files problem was masked by env-probe noise. The guard now runs for every exit=0 non-rate-limited run (skipped only when the job is about to re-fire on HALT/deps_unmet). When the materially-checkable `uncommitted_changes` verdict fires alongside a pattern verdict, it **owns** the `needs_review` reason and the pattern hit is carried as an annotation — so a real "finish protocol incomplete" is now distinguishable from transcript noise in the queue. Annotations are persisted on the job as `verifierAnnotations` (surfaced even on completed jobs).

**Verification.**
- 4 regression tests added/updated in `src/main/__tests__/runVerify.test.cjs`: recovered env-probe (success) → clean+annotated; bare ModuleNotFound (success) → clean+annotated; Traceback→KeyError on "success" → still `transcript_errors`/`needs_review`; ModuleNotFound in a **failed** run → `verify_unavailable`/`needs_review`. Full verifier suite **14/14 pass**; `npm run typecheck` green.
- **Live re-scan** of the three cited run logs with the fixed verifier: all three now return `verdict=clean, downgradeTo=null` (with `verify_unavailable` annotations). Before this fix each was `transcript_errors → needs_review`.
- The three stuck Self jobs need no manual retag: the existing boot self-heal pass (`reverifyNeedsReview`, `RESCANNABLE_VERDICTS` includes `transcript_errors`) re-runs the current verifier over needs_review jobs on startup and auto-completes the ones that now pass clean — the same mechanism that healed 8 jobs after item 01. `27-self-billbot-port-remaining`'s ported files were already committed manually (Self `edf9d4e`), so its working tree is clean and `completed` is the correct final state.

**Not implemented (noted, not blocking).** The "AC-command exit codes" half of the precedence suggestion would require parsing per-PRD acceptance commands and their exit codes as a first-class material verdict; there is no current spec for declaring AC commands in PRD frontmatter. Left for a future PRD if the queue starts seeing AC-level false alarms — the commit-guard + transcript signals cover the observed cases.
