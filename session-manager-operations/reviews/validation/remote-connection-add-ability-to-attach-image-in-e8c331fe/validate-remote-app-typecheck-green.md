# Validation: repair-remote-app-ws-typings (PRD 3258)

Base: 9efef7b4. Commit: e71e8ebe (only `web/remote-app/src/__tests__/ws-package.d.ts`, +3 lines). Checks run in the main checkout (the job worktree lacks web/remote-app/node_modules); main HEAD = e71e8ebe.

## repair-remote-app-ws-typings — VERIFIED

- AC1 shim members: `git show e71e8ebe` adds `maxPayload?: number` to ServerOptions, `on(event:'close', listener:(this: WebSocket, code:number, reason:Buffer)=>void): this` and `close(code?: number, data?: string|Buffer): void` to WebSocket; no existing line changed (3 insertions, 0 deletions).
- AC2 typecheck: `npm --prefix web/remote-app run typecheck` -> exit 0, no errors. The commit touches only the .d.ts, so the spec is unedited and no ts-ignore/ts-expect-error/any was added.
- AC3 runtime: `npm --prefix web/remote-app test -- src/__tests__/remote-renderer-save-binary.browser.spec.ts` -> 2/2 passed.
- Gate re-run: both commands exit 0.
- Plan-level: full `npm --prefix web/remote-app test` -> 44 files passed, 333 passed / 1 skipped (second run). First run had 1 failure (`ws-frames-pacing.spec.ts:214`, `until:` timeout); it passes alone (9/9) and on the full re-run. Timing flake under load, unrelated to the .d.ts change.

## Findings

Critical: none.
Important: none.
Minor:
- `web/remote-app/src/__tests__/ws-frames-pacing.spec.ts:214` is timing-sensitive: it failed once in a loaded full-suite run and passed on retry.
- Review: the diff is declaration-only, test-scoped, no runtime, input handling or secrets surface; the shim reuses no existing helper. /code-review and /security-review not run separately; self-reviewed.
