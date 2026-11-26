# Validation — 4729-repair-sandbox-limit-close-traceback-block

Base: 52d21729 (commit before landed f9e3ed55). Range 52d21729..HEAD touches only the 2 PRD files (+19/−4).

## 4729-repair-sandbox-limit-close-traceback-block — VERIFIED

- ac-1: `src/main/lib/scheduler/sandboxEnvironmentLimit.cjs:61-67` — header sets `start`; blank/indented lines skipped; first non-indented line is the exception line, `start = -1` is set before the ERROR_LINE check. Chained case covered by test at `__tests__/sandboxEnvironmentLimit.test.cjs:146-150`. `npx vitest run …sandboxEnvironmentLimit.test.cjs` → 19 passed.
- ac-2: new test `__tests__/sandboxEnvironmentLimit.test.cjs:142-145` (AF_UNIX → ValueError → `rm … Operation not permitted` → null); verbatim fixtures TB_SOCKET (:87-94, :117) and TB_TMP Errno 30 (:108, :120-121) still pass.
- ac-3: `npm run typecheck` exit 0.

### Live probe (validator)
Probe script under $TMPDIR, fed through `sandboxLimitFromStreamJson` as a Bash tool_result:

| Input | pre-fix 359ac1ee | HEAD |
| --- | --- | --- |
| prior validator probe (AF_UNIX tb → `ValueError: nope` → `rm: cannot remove y: Operation not permitted`) | unix-socket (bug) | **null** |
| real `python3 -I s.py` AF_UNIX traceback (sandbox-produced, source line shows AF_UNIX) | unix-socket | **unix-socket** |
| real traceback with exception swapped to ValueError + rm line | unix-socket (bug) | null |
| real `python3 -I -c '…AF_UNIX…'` traceback (no source line printed for `<string>`) | null | null |

Gate: `timeout 600 npm run typecheck` → exit 0.

## Findings

### Minor
- `src/main/lib/scheduler/sandboxEnvironmentLimit.cjs:62` — a `python3 -c` AF_UNIX refusal prints no source line, so `AF_UNIX` never appears in the block and the classifier returns null (unchanged from before this PRD; not a regression). Possible follow-up: also accept a block whose frames include `socket.py … in __init__` with `Operation not permitted`.
