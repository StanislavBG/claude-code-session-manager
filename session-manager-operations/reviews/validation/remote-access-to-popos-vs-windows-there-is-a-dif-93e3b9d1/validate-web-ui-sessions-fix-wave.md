# Validation: web-UI Sessions fix wave (I1, I2)

Base: b1c6889c. Commits: ba72c703 (2541), bb7d3477 (2542), c57a61ab (2543). Run with SM_* env unset.

## repair-stale-stubs-epicsworkspace-inlineconsent — VERIFIED
- EpicsWorkspace.test.tsx:85 adds `promptSessions.writeArchive: vi.fn().mockResolvedValue({ ok: true })`; assertions untouched in the diff.
- InlineConsentTerminal.test.tsx:60 and :154 swap `config.exists` for `transcripts.exists`; assertions untouched.
- Gate 1 (`vitest run` of both files): 2 files, 21 tests passed.
- Gate 2 `npm run test:unit`: 870 files passed, 8223 tests passed, 1 skipped.
- Gate 3 `npm run typecheck`: exit 0.
- The product-bug AC was not triggered in `promptSessions.ts`. A different product fix landed in `src/renderer/state/config.ts` (see Minor M1).

## chain-spec-renders-epic-list-from-real-handlers — VERIFIED
- `fixtures/ipc-defaults.ts` is a typed per-channel table (arrays `[]`, required fields present). The spec uses it and falls back to null only for unlisted channels.
- The spec registers the real `registerPromptSessionsReadHandlers` and `registerActiveIndexMergeHandlers` over a temp project. The project is registered via tabs.json and in `fenceCtx.projectRoots`.
- The temp project's active-index.json holds one proposed and one active Epic. `sessions:load` returns one tab.
- 'Sessions list renders from real handlers' passed in real Chromium (12.4 s). It asserts both titles visible in the iframe, `promptSessions:load-active-index` dispatched, and `frameErrors == []`.
- Gate: `npm --prefix web/remote-app ci && npm --prefix web/remote-app test`: 33 files passed, 221 tests passed, 1 skipped. The 3 original real-chain tests pass. Typecheck exit 0.

## chain-spec-approve-round-trips-to-disk — VERIFIED
- Approve test (passed, 19.8 s): after the click, active-index.json shows `epic-proposed` active within 15 s. `epic-active` is unchanged. `merge-active-index` was dispatched. `frameErrors == []`.
- Mark completed test (passed, 29.9 s): the archive file exists under prompt-sessions, `epic-active` is removed from the index, `write-archive` was dispatched, and `epic-proposed` is still proposed.
- Control-off test (passed): a toast matching /Could not start/ appears, active-index.json is byte-identical, and no merge call was dispatched.
- Gate: same as above, green.

## Full suites
- Root `npm run test:unit`: green. Web/remote-app tests: green. No reds, so no pre-existing-at-Base comparison was needed.

## Findings
Critical: none.
Important: none.
Minor:
- M1: `src/renderer/state/config.ts:122-135` and the new `state/__tests__/configLoadDenied.test.ts` are outside the declared Files of 2541-2543. They are a justified fix (unhandled rejection from denied `config:readJson` in the web UI) with a unit test.
- M2: The approve test asserts `merge-active-index` was dispatched, not that the dispatch result was "ok". The on-disk state change proves success in practice (real-chain.browser.spec.ts, approve test).
- M3: The Mark completed test took 29.9 s against a 40 s wait (real-chain.browser.spec.ts, `waitFor(..., 40_000)`). The margin is thin under load, so it is a potential flake.
- M4: No `/code-review` or `/security-review` run. Self-review: the spec writes only to mkdtemp dirs. No secrets or path traversal found.
