# Validation: web-remote boot tests run (fix wave for 2372)

Base: baeb8a63. Commits: a44fefcf (2374), a2b65f09/74a78552 (2375), 461e84d5 (2376), 741515a0 (record move). All commands run from the repo root with `npm --prefix web/remote-app`.

Gate results (re-run): `ci` exit 0; `typecheck` exit 0; `npm --prefix web/remote-app test` → 31 files / 198 tests passed (incl. remote-renderer-boot.browser.spec.ts, 2 tests, real Chromium); `npm run lint:docs` ok; remoteRenderer.spec.tsx run twice more → 8/8 each; readyGate.spec.tsx → 6/6.

## remote-renderer-listener-before-frame-boot — VERIFIED
- RemoteRenderer.tsx:1 imports useLayoutEffect; :302 listener effect is `useLayoutEffect` with preceding comment (:301); diff shows only that effect + import changed (IFRAME_SANDBOX :11 intact).
- remoteRenderer.test.tsx → remoteRenderer.spec.tsx (rename, 0 changes); test 'posts sm-boot…' at spec:62 passes, no added wait.
- remote-renderer-boot.browser.test.ts → .spec.ts (rename, 0 changes), 2 cases pass.
- Gate passes (above).

## remote-app-ready-gate-test-runs-and-passes — VERIFIED
- readyGate.spec.tsx exists, test file renamed; harness uses `vi.mock('../components/RemoteRenderer')` rendering `fallback` (spec:9); no Cockpit/RemoteRenderer change for it.
- 6/6 pass, including 'sends exactly one request after ready'.

## remote-app-vitest-include-test-files — VERIFIED
- vite.config.ts:18 `include: ['src/**/*.{spec,test}.{ts,tsx}']`, only line changed.
- `find web/remote-app/src -name '*.test.*'` → none.
- CLAUDE.md:12 has the required line. Full suite + lint:docs pass.

## remote-renderer-boot-script-inside-sandbox (2372) AC 4 & 5 — VERIFIED
- AC4: remoteRenderer.spec.tsx:62 posts sm-boot after sm-boot-ready; runs in plain `npm --prefix web/remote-app test`, passes.
- AC5: remote-renderer-boot.browser.spec.ts (first line `// @vitest-environment node`) runs in the plain suite, 2 tests pass (3.4 s) in real Chromium, incl. pre-fix blob: case.

## Record move / cleanup — VERIFIED
- `validate-web-remote-paired-connect-and-ui-boot.md` exists at repo-root session-manager-operations/reviews/validation/<epic>/ (rename in 741515a0); `web/remote-app/session-manager-operations` does not exist.

## Findings
- Critical: none. Important: none.
- Minor: readyGate.spec.tsx diff also swaps `await findByTestId('project-row')` for `await flush(); getByTestId(...)` (fake timers). The 2375 AC said assertions unchanged; the assertion target is the same, only the wait mechanism changed.
- Minor: stray 2376 PRD duplicate (`2376-fix-remote-app-vitest-include-test-files.md`) in prds-archived; no effect on the tree.
- Self-review of the diff (no new input handling, secrets, or paths): nothing found.
