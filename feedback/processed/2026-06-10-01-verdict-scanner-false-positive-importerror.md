# session-manager feedback 01 — verdict scanner false-positives on quoted ImportError text

**From:** Self project (interactive session investigating 2 "Needs review" PRDs) · **Date:** 2026-06-10 · **Priority:** normal (every review-heavy PRD will keep tripping this)

## TL;DR

Two Self PRDs (`25-self-pipeline-driver-hardening`, `25-self-services-parsers-hardening`) ran to full success today — exit 0, `result.subtype: success`, all acceptance criteria met, commits `754b489` and `61c16b4` landed in /home/bilko/Self — yet both were downgraded to `needs_review` with `verifierVerdict: verify_unavailable` and error `"ModuleNotFoundError/ImportError at event N, no install recovery found"`. No import error ever occurred. The scanner matched the *words* "ImportError"/"ModuleNotFoundError" inside code-review subagent findings that **described hypothetical failure scenarios in the code under review** (e.g. "the script will crash with ImportError at the top-level `from playwright.sync_api import ...`").

## Evidence

- `src/main/runVerify.cjs:74` — `detectPattern()` does a bare substring check over every tool_result content string:
  ```js
  if (content.includes('ModuleNotFoundError') || content.includes('ImportError')) {
    return { verdict: 'verify_unavailable', pattern: 'ModuleNotFoundError/ImportError' };
  }
  ```
- Run `2026-06-10T21-09-51-945Z`, log line 262: the "match" is a JSON review finding — `"...will crash with ImportError rather than a clean 'RESULT: failed ...' line"` — prose from a bug-finder subagent, not a runtime error.
- Run `2026-06-10T21-19-31-216Z`, log line 305: same shape — `"...would fail with an ImportError that is captured only in cron.log"`.
- Both runs' final `result` events: `subtype: success`, `is_error: false`, summaries listing every AC ✅ and the commit hash.

The Traceback detector (`runVerify.cjs:64-68`) has the same exposure: a reviewer quoting a traceback in a finding, or a PRD whose AC text contains one, will flag `transcript_errors`.

## Why it matters

Any PRD whose subject matter is error handling, logging, or hardening (i.e., most fix-PRDs) makes reviewers *talk about* exceptions in their findings. Those runs will land in `needs_review` ~100% of the time despite succeeding, which erodes trust in the verdict — the user has to manually open transcripts to discover the run was actually fine, which is exactly the toil the verdict scanner exists to remove.

## Ask

Make `detectPattern()` require an actual error context instead of a substring anywhere:

1. **Anchor the pattern.** Match only line-anchored exception output, e.g. `/^(ModuleNotFoundError|ImportError)(:|\b)/m`, or require the hit to be within a few lines after `Traceback (most recent call last):`. Quoted prose ("will crash with ImportError") never starts a line with the bare exception name.
2. **Scope what gets scanned.** Skip tool_results from subagent/Task tool calls (review-finder output is structured prose, the highest-noise source), or only scan results where `is_error: true` or the tool was Bash.
3. **Let the final result event veto a downgrade.** If the run's `result` event is `subtype: success` with `is_error: false` and exitCode 0, a mid-transcript pattern hit should at most annotate, not downgrade to `needs_review`. The agent itself already proved the ACs green (the PRDs mandate running the verification commands before declaring done).
4. Apply the same anchoring to the `FAIL/FATAL` and Traceback detectors — same false-positive class.

A regression fixture is sitting on disk: re-run the scanner against `runs/2026-06-10T21-09-51-945Z/25-self-pipeline-driver-hardening.log` and `runs/2026-06-10T21-19-31-216Z/25-self-services-parsers-hardening.log` — both must come back clean (`completed`), while a log containing a real top-of-line `ModuleNotFoundError: No module named 'x'` in a Bash tool_result must still flag.

## Resolution of the two flagged jobs

Both are safe to retag `needs_review → completed` in `queue.json` (queueOps retag); the work is committed and verified in /home/bilko/Self.

## RESOLUTION (2026-06-10, processed by Claude)

**Implemented** (`src/main/runVerify.cjs`):
1. ✅ Anchored Import detector: `/^\s*(?:ModuleNotFoundError|ImportError)\s*(?::|$)/m` — prose mentions no longer match.
2. ✅ Scoped scanning: tool_results produced by `Task` (subagent) tool_uses are exempt from `detectPattern` (review-finding prose was the noise source). `is_error` scanning unchanged.
4. ✅ Anchored the Traceback detector both ends: `^\s*Traceback (most recent call last):` + exception line `^\s*[A-Za-z_][\w.]*(?:Error|Exception)\s*:`. (FAIL/FATAL was already line-anchored.)

**Declined**:
3. ❌ Success-event veto. The verifier exists because `subtype: success` + exit 0 cannot be trusted (the 2026-05-23 false-PASS incident is test Case 1: agent echoed "PASS" over a real Traceback and declared success). A blanket veto would disable true-positive detection entirely. The anchoring + Task-scoping fixes remove this false-positive class without it.

**Verification**:
- 4 new regression tests in `src/main/__tests__/runVerify.test.cjs` (prose ImportError → clean; real line-anchored ModuleNotFoundError → flags; error text inside Task result → clean; quoted Traceback line → clean). Full suite 9/9 pass, `npm run typecheck` green.
- Live regression per the ask: both cited run logs re-scanned with the fixed verifier → `clean | no issues detected`.
- Both flagged jobs retagged `needs_review → completed` in queue.json after confirming commits `754b489` and `61c16b4` exist in /home/bilko/Self.
