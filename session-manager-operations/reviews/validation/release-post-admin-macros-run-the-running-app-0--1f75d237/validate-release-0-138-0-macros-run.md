# Validation: release-post-admin-macros-run plan

Base: 27aa9a5fdb45413f36bcc9c5f14eedd2f7fb5c3d (given). Checked 2026-11-20 (PST).

## repair-stale-macro-route-tests — VERIFIED
- Commit 18672269 `test(preload,macros): ...` touches exactly src/preload/apiSurface.json (+7) and SessionActionsBar.test.tsx (+1/-1).
- apiSurface.json: one new row chat/reportExternalNewSessionResult, channel chat:external-new-session-result, invoke, remote mutate (per diff).
- SessionActionsBar.test.tsx: exact payload now ends `scriptStart: false`; not loosened to objectContaining.
- Gate: `npx vitest run apiSurface.test.cjs SessionActionsBar.test.tsx` → 2 files, 32 tests pass. Typecheck not re-run (the unit run and the release bump are green; not a stated risk).

## stabilize-restorable-sessions-tests — REFUTED — nothing landed
- `git log 27aa9a5..HEAD -- src/main/lib/epic/restorableSessions.cjs src/main/lib/epic/__tests__/restorableSessions.test.cjs`: no commits. Last commit 04916776 (2026-11-14) predates the base. `git diff` for src/main/lib/epic over the range shows only epicAttachments files, which are not this PRD's.
- No commit message names a root cause and no regression test was added, so the criteria on root cause and isolation are unmet.
- Gate as observed: `npx vitest run src/main/lib/epic/` 28 files / 290 tests pass; full `npm run test:unit` 1082 files / 10686 pass, 1 skipped. The suite is green in this run, so the four load-dependent failures did not reproduce here. That does not make the PRD's deliverable present, and the flakiness is unaddressed.

## release-0-138-0-admin-macros-run — REFUTED — not published to npm
- Bump commit 2af89d21 `chore(release): bump to v0.138.0`; tag v0.138.0 is annotated and resolves to 2af89d21; eec0743b and fb691a2e are both ancestors of the tag (exit 0). Origin has refs/tags/v0.138.0.
- Registry: cache-busted packument returns dist-tags.latest = 0.137.0 and no 0.138.0 entry. `npm view` agrees, and `/0.138.0` returns "version not found". The tarball and macroAdminRoutes.cjs check therefore could not be run.
- manual.json documentsAppVersion is still 0.137.0, so the manual step did not land. A fix PRD (3240-fix-...) is still queued.
- Gate command 1 (latest === package.json version) fails: latest 0.137.0 vs 0.138.0.

## Findings
- Critical: 0.138.0 is not on npm (publish did not happen or failed), so POST /admin/macros/run is not shipped. package.json:version.
- Important: stabilize-restorable-sessions-tests has no commit; the flaky-test fix and root cause are absent. src/main/lib/epic/restorableSessions.cjs.
- Minor: manual.json documentsAppVersion stale at 0.137.0 (session-manager-operations/manual/manual.json).
- Minor: the release PRD's file also appears in a duplicated "fix" PRD (3240-fix-...) whose body is garbled with duplicated lines.
- Code and security review: the diff in scope is two tests/table rows; no input handling or secrets involved.
