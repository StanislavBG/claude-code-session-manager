# Validation: 4719-repair-sandbox-limit-python-traceback

Base: 1b15722f (the commit before the landed commit d0c5296a). Validator run on 2026-11-26.

## 4719-repair-sandbox-limit-python-traceback: REFUTED

The detector does not classify a real CPython 3.12 AF_UNIX traceback. The 3-line window and the 80-char gap inside the regex both miss it.

Landed: d0c5296a `fix(scheduler): match sandbox limits across 3-line Python tracebacks`. It touches only the 2 PRD files (+33/-1).

| id | met | evidence |
| --- | --- | --- |
| ac-1 | no (behavior-wrong) | `sandboxEnvironmentLimit.cjs:43-50` adds the 3-line window. The vitest file passes 15/15, and the hand-written 3-line fixture returns `unix-socket`. A **real** traceback returns `null`. I made it in the job sandbox with `python3 -I x.py` (Python 3.12.3): `s = socket.socket(socket.AF_UNIX, ...)` is on line 4, then a `^^^^` caret line, then 2 lines for the `socket.py` `__init__` frame, then `PermissionError: [Errno 1] Operation not permitted` on line 8. That puts AF_UNIX 4 lines before the error. A synthetic 3.12 bind traceback with a caret line between the source and the error also returns `null`. The caret line's leading spaces push the gap past the regex limit `[^\n]{0,80}` (`:14`). |
| ac-2 | yes | The node -e probe returned `null` for all 3 cases: AF_UNIX more than 3 lines from the error, a success (`is_error:false`) Bash result, and a Read tool_result. The 12 existing tests are green (15/15 total). |
| ac-3 | yes | `timeout 600 npm run typecheck`: exit 0. |

Validate-PRD probes, all with `node -e` against `sandboxLimitFromStreamJson`:
- Real AF_UNIX traceback: `null`. **Fail**: it must be `unix-socket`.
- Real `/tmp` Errno 30 traceback: `{"kind":"readonly-tmp"}`. **Pass**, but the error line itself names `/tmp`, so the single-line pass already matched it.
- AF_UNIX more than 3 lines from the error: `null`. **Pass**.

Gate: `timeout 300 npx vitest run src/main/lib/scheduler/__tests__/sandboxEnvironmentLimit.test.cjs` exited 0 (15 passed), then `timeout 600 npm run typecheck` exited 0.

## Findings

### Important
- `src/main/lib/scheduler/sandboxEnvironmentLimit.cjs:18,43-50` (behavior-wrong): the window is too narrow for real CPython output. Python 3.11+ adds caret lines. A socket() that fails at creation puts the `socket.py` frame between the call and the error, so the gap is 4+ lines plus a long run of spaces and carets. This fails the goal ("real tracebacks classify"). One possible fix: match the error line (`PermissionError: [Errno 1] Operation not permitted`) and look back through the traceback block for `AF_UNIX`. Or drop caret and frame lines before windowing.
- `src/main/lib/scheduler/__tests__/sandboxEnvironmentLimit.test.cjs:86-89` (missing-test): the fixture is hand-written, not verbatim CPython output. It leaves out the caret line and the `socket.py` frame that a real 3.12 run prints, so the test passes while real output fails.

### Minor
- `src/main/lib/scheduler/sandboxEnvironmentLimit.cjs:101` (other): the FAIL-reason path also goes through `detectPerLine`, so it gets the new window too. The PRD said "Do not change the FAIL-reason path." The effect is small, because a reason is usually one line.
- Security: no unsafe input handling, secrets or path traversal. The regexes are bounded (`{0,80}`) and the window scans in linear time. No duplicated helper. No `Follow-up:` trailers.
