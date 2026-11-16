# Validation: cross-project-reply-test-load-robust (PRD 3200)

Base: cc1861db (known). Commits in the PRD's paths: `2e1be21e fix(feedback-reply): report a Y receipt that did not land instead of claiming it`.

## 3200-cross-project-reply-test-load-robust — VERIFIED

- Static check, writes awaited: `crossProjectReply.cjs` awaits both receipt appends and the diff now captures their `{ok}` (`const receipt = await appendEvent(...)`, fallback path and delivered path).
- Static check, Maps keyed by cwd+Epic: `threadLocks` (`crossProjectReply.cjs:56`) is keyed `${realOr(replierCwd)}\0${yId}` (line 241). `macroGrantCounts` (`crossProjectFeedback.cjs:551`) is keyed by senderEpicId only. It is not on the reply path (see Minor).
- Named root cause matches the diff: the dropped `{ok:false}` from `appendResponseEventWithReason`, which never throws, so a failed read or write let the reply resolve ok with no receipt on disk. The diff adds `receiptFields()` and `receiptOnReplyingEpic` / `receiptError` on both paths. This is a product fix in an in-scope file. The flake did not reproduce (the commit message reports 30/30 under nproc hogs, before and after). This is the PRD's "no failure reproduced, fix the most likely static cause" branch. I did not repeat the load repro.
- Regression test: `a receipt that did not land is reported, never claimed` is in `crossProjectReply.test.cjs`. It uses a failing appender, so it would fail before the fix.
- No retry, skip or timeout added: the diff touches only the two in-scope files, and a grep for `.skip`, `setTimeout` and `retry` finds none in them.
- Gate: `npx vitest run crossProjectReply` gave 3 files and 33 tests passed. `npm run typecheck` exited clean.

## Plan-level
- `npm run test:unit`: 1074 files passed, 10537 tests passed, 1 skipped. No flakes, so no rerun was needed.
- `npm run typecheck`: clean.
- Review: `/code-review` and `/security-review` were not run as separate commands. I self-reviewed the diff and found no unsafe input, secrets, or path handling changes. The diff only surfaces an existing result field.

## Findings
- Critical: none.
- Important: none. The load flake is unproven fixed. The fix targets a plausible cause, not a reproduced one, so a recurrence under load is still possible.
- Minor: `crossProjectFeedback.cjs:551` `macroGrantCounts` is keyed by senderEpicId alone, not cwd+Epic. Epic ids are unique, so the risk is low, and it is outside this path.
