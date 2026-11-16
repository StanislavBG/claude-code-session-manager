# Release record: claude-code-session-manager v0.136.1

- Precondition: validate-reply-note-truth.md marks feedback-open-session-reply-note-truth VERIFIED, no REFUTED, Critical none, Important none.
- Version: 0.136.0 -> 0.136.1 (patch). Release commit 0683b14d on main, tag v0.136.1.
- Commits covered (3): 1 fix (18dad4b9 key feedback_open_session reply note off replyThread), 2 docs (a510147f, 904dbc73). No breaking changes.
- Gates (main checkout, SM_* unset, fresh TMPDIR): typecheck pass; test:unit 1074 files / 10536 tests pass.
- Publish-worktree gates (~/.cache/sm-publish/v0.136.1): typecheck pass; test:unit first run red (4 files / 3 tests: runVerify, seedAgentPersonas, telemetryClient, telemetryContract; load flake, same as v0.136.0); full rerun red once on a different file (crossProjectReply.test.cjs, 1 test), which passed 2/2 in isolation. The tree differs from the green main-checkout run only by the version bump, so publish went ahead.
- Pushes: `git push origin main` (c8826823..0683b14d) and `git push origin v0.136.1` both succeeded.
- CI: release.yml npm-publish job FAILED with E404 (trusted publisher not registered on npmjs.com). Other jobs succeeded.
- Local fallback (once): `npm publish` printed `+ claude-code-session-manager@0.136.1`. Worktree removed.
- Registry evidence: cache-busted packument polled 12 times (~6 min): dist-tags.latest still 0.136.0, 0.136.1 not under versions, tarball URL 404. Consistent with a staged publish awaiting approval. Not republished, no new version.
- Installer assets (GitHub release v0.136.1): .dmg (arm64, x64), .zip, .exe (win-x64, win-arm64, win), .AppImage, latest*.yml. None missing.
- Manual (builder step 5): no content change. No chapter names feedback_open_session, feedback_reply or replyThread; the fix only changes a tool-response note. Bumped manual.json documentsAppVersion 0.136.0 -> 0.136.1 only; manual version stays 2.5.0, no manual release, no gaps.

- Registry evidence (live): checked 12:39 PM PST on 2026-11-16. Cache-busted packument dist-tags = {"latest":"0.136.1"}; `versions` includes 0.136.1; tarball HTTP 200. The owner approved the staged publish on npmjs.com. No republish, bump or tag was made by this fix job.

RELEASE: PUBLISHED v0.136.1
