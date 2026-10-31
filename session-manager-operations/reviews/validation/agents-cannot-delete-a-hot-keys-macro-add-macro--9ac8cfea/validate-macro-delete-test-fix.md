# Validation: macro delete test fix wave

Base: 46d37b843a559af49f68f1913ecb8eee7108dc03. PRD files found in `prds-archived/` (2467, 2449).

## macro-remove-test-fixed-clock — VERIFIED
- Commit 2089a467 touches only `src/main/lib/persona-macro/__tests__/macroLibrary.test.cjs` (5 insertions, 1 deletion).
- AC1: test.cjs:618-621 uses `vi.useFakeTimers({ toFake: ['Date'] })` with `setSystemTime` 00:00:00.000Z for `saveMacro` and 00:00:01.000Z before `removeMacroFromProject`.
- AC2: test.cjs:626 asserts `r.macro.updatedAt` `toBe('2026-01-01T00:00:01.000Z')`; the other assertions (622-625, 627-628) are unchanged.
- AC3: `afterEach` first line is `vi.useRealTimers();` (test.cjs:27).
- AC4: the diff for the commit is that one file.
- Gate: macroLibrary test file passed 12 of 12 runs (54/54 each); `npm run lint` exit 0.

## macro-remove-from-project — VERIFIED
- The code landed in 9346aa6c, before the Base; `git diff 46d37b84 HEAD` on macroLibrary.cjs is empty.
- AC1: macroLibrary.cjs:193 defines the schema, :629-630 parse it, :664 and :674 export both names.
- AC2-4: macroLibrary.cjs:629-657 matches the specified behaviour (delete on last project; drop cwd with new `updatedAt`; four refusals, with the exact messages, return before any write). Tests at test.cjs:610-646 cover them, including byte-identical checks.
- AC5: test.cjs:657-665 covers the concurrent `Promise.all` case.
- AC6: tests are in the named file; `deleteMacro` and `setMacroProject` are untouched by the Base..HEAD diff.
- Gate: `timeout 60 npx vitest run .../macroLibrary.test.cjs` passed 12 runs in a row (54/54 each); lint exit 0.

## Full suite — `timeout 420 npm run test:unit`: RED (1 failure)
Run with `SM_*` unset, twice; the same result both times: 849 files, 8046 passed, 1 failed, 1 skipped (baseline: 837 files, 7981 passed, 1 skipped). The only failure is unrelated to macros:
`tests/unit/chatRunner.spec.ts` > "prepends both STOP_SIGNAL_INSTRUCTION and CHAT_MODE_TRUTH_INSTRUCTION to the -p argv value". It reproduces in isolation (1 failed, 41 passed): `expected 'MemoryHigh=8704M' to be '--model'`.

## Findings
- **Important** — `tests/unit/chatRunner.spec.ts:~429`: the test expects `-p` to be followed by `--model`, but argv now starts with `MemoryHigh=8704M`. This follows the systemd memory-scope wrapping of chat turns (a96a3c6c, `feat(chat): run Epic chat turn attempts in a memory-capped systemd scope`, in Base..HEAD). It is outside this fix wave's PRDs, but the repo-wide suite is red. The architect should queue a fix: update the spec, or have the production code keep `-p` argv positions stable.
- **Minor** — none for the two PRDs. Neither PRD gate covers the full suite, so the red above was not seen by the PRD gates.

The macro-delete criteria hold. The full-suite criterion is not met, because of the unrelated chatRunner failure.
