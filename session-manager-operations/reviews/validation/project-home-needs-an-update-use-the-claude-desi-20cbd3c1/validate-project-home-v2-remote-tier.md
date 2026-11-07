# Validation: Project Home v2 remote-tier repair

Base: 3e9f5050; wave head 28ded18c (one commit, `fix(web-remote): serve project-pages:md-network as a fenced read`).

## repair-md-network-remote-read-tier — VERIFIED
- apiSurface row `project-pages:md-network`: remote `mutate` → `read`, kind/method unchanged (diff of src/preload/apiSurface.json, 1 line). apiSurface.test.cjs passes.
- `PATH_FENCED_CHANNELS['project-pages:md-network'] = { field: 'cwd', mode: 'root' }` at src/main/lib/feedback-remote/remoteIpcDispatch.cjs:63-64.
- Test (remoteIpcDispatch.test.cjs, new describe block, uses the real surface): authed client, remoteControlEnabled false, cwd in registered root and subdir → handler called.
- Same file: cwd outside roots / missing cwd → `path_fenced`, handler not called (control off and on); `.ssh` paths and symlink → path_fenced; unauthenticated → `e2e_not_authenticated`.
- No other channel changed: diff is 3 files, +48/-1, the only removed line is the one tier flip.
- Gate: vitest (2 files, 61 tests) pass; `npm run typecheck` exit 0; `npm run lint` exit 0.

## Full suite (SM_* unset, at 28ded18c)
- `timeout 900 npm run test:unit`: 947 files passed, 8951 passed / 1 skipped.
- typecheck and lint green.

## Findings
- Critical: none.
- Important: none.
- Minor: none. Self-review of the diff found no path-traversal or secret exposure; it reuses the existing fence.
