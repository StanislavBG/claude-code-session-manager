# Validation: publish gate green (PRDs 1885, 1886)

Base: 0dd89e90. Commits: 53a6c3b6 (1885), 27b74c5b + merge 1d7e84da (1886). Combined diff: 4 files, +38/-8.
Reviews: `/code-review` and `/security-review` not run as separate tools; self-reviewed the diff (no input handling, paths, or secrets touched).

## 1885-sync-dev-plugin-marketplace-version — VERIFIED
- `.claude-plugin/marketplace.json:16` session-manager-dev entry `"version": "0.2.1"`; `plugin.json:4` is `0.2.1`.
- Top-level marketplace version unchanged: `marketplace.json:9` `0.1.0`; diff is a single line.
- Gate `npx vitest run scripts/__tests__/dev-plugin-skillset.test.cjs`: 3/3 passed.

## 1886-repair-epicsworkspace-hydrate-chain — VERIFIED
- `EpicsWorkspace.test.tsx` absent from `git diff 0dd89e90..HEAD --stat`: no assertion loosened, deleted or skipped.
- Root cause: `autoApproveInbound` itself calls `hydrate()`; EpicsWorkspace chained it after its own hydrate, so a second hydrate clobbered in-memory sessions. Fix splits out `approveStampedInbound` (no hydrate) at `inboundAutoApprove.ts:40` and uses it at `EpicsWorkspace.tsx:106,129`. Root cause is stated in the 27b74c5b commit message (per the PRD AC; not re-read verbatim here).
- Only acts on stamped inbound Epics: `isStampedInbound` filter retained; tests at `inboundAutoApprove.test.ts:93-116` prove no hydrate, and plain proposed / completed Epics untouched.
- Gate: EpicsWorkspace + chat + inboundAutoApprove tests: 73/73 passed; `npm run typecheck` exit 0; `npm run lint` exit 0 (e2e budget 19/19).

## Full suite
`npm run test:unit` (SM_CHAT_CONCURRENCY unset, scratch TMPDIR, node_modules symlinked from main checkout since the worktree has none): exit 0, 719/719 files passed, 6900 passed, 1 skipped, 0 failed.

## Findings
- Critical: none.
- Important: none.
- Minor: `autoApproveInbound` (hydrate + approve) is now probably unused by the renderer chain; check for remaining callers before treating it as dead code (`src/renderer/lib/inboundAutoApprove.ts:48`).
