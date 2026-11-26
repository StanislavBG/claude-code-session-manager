# Validation: 4727-repair-sandbox-limit-traceback-block-scan

Base: d8530cc0 (parent of landed commit 359ac1ee). Validator run 4728, 2026-11-26.

## 4727-repair-sandbox-limit-traceback-block-scan — VERIFIED

Commit: `359ac1ee fix(scheduler): classify sandbox limits by traceback block, not 3-line window` (2 files, +80/-22). No `Follow-up:` trailers.

| AC | Met | Evidence |
| --- | --- | --- |
| ac-1 | yes | `__tests__/sandboxEnvironmentLimit.test.cjs:86-114` fixtures match, byte for byte apart from script path, what I got by re-running `python3 -I` (CPython 3.12.3) in this sandbox: caret line, `socket.py` line 233 `__init__` frame, `PermissionError: [Errno 1] Operation not permitted`. The version is named in the comment at :86. |
| ac-2 | yes | `timeout 300 npx vitest run src/main/lib/scheduler/__tests__/sandboxEnvironmentLimit.test.cjs` → 17 passed. The tests cover socket/bind → unix-socket, /tmp Errno 30 → readonly-tmp, no-AF_UNIX EPERM → null, and an earlier separate block → null. |
| ac-3 | yes | `sandboxEnvironmentLimit.cjs`: the grep for `WINDOW` comes back clean. `detectBashBody` (:52) is called only in the is_error Bash tool_result branch (:106-112). The FAIL-reason path uses `detectPerLine` (:120) and is pinned by the test "FAIL-reason path is plain per-line". |
| ac-4 | yes | `timeout 600 npm run typecheck` → rc=0 |

Validator live probe (my PRD's ac-1). I regenerated the tracebacks in this sandbox and fed each one as an is_error Bash tool_result, both as a string and as array content:
- socket(AF_UNIX) traceback → `{"kind":"unix-socket"}`
- open('/tmp/x_val4728','w') Errno 30 → `{"kind":"readonly-tmp"}`
- os.setgroups([0]) EPERM → `null`
- the same bodies with is_error:false → `null`

Gate (validate PRD): `timeout 600 npm run typecheck` → rc=0.

## Findings

### Critical
- none

### Important
- none

### Minor
- `src/main/lib/scheduler/sandboxEnvironmentLimit.cjs:59-61`: a block stays open after its exception line. `start` is reset only by a new `Traceback` header. So suppose an AF_UNIX traceback ends in another error, for example `ValueError`. A later plain `Operation not permitted` line within 60 lines (for example `rm: cannot remove y: Operation not permitted`) is then classified unix-socket. I reproduced this with a probe. Fix: close the block (`start = -1`) at the first unindented line after the frames, which is the exception line. (missKind: behavior-wrong)
