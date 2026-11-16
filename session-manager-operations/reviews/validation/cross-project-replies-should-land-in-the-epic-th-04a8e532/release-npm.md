# Release record: claude-code-session-manager v0.136.0

- Precondition: validate-cross-project-replies.md lists all 8 plan slugs VERIFIED (as `- **slug — VERIFIED.**` bullets, not `##` headings), no REFUTED, Critical none, Important none.
- Version: 0.135.1 -> 0.136.0 (minor). Release commit c8826823 on main, tag v0.136.0.
- Commits covered (65): 29 feat (minor), 7 fix, 20 docs, 2 doc, 6 test, 1 ci. No breaking changes, no unprefixed commits.
- Gates (main checkout, SM_* unset, fresh TMPDIR): typecheck pass; test:unit 1074 files / 10529 tests pass.
- Pushes: `git push origin main` (2bd71322..c8826823) and `git push origin v0.136.0` both succeeded.
- CI: release.yml npm-publish job FAILED with `E404 PUT https://registry.npmjs.org/claude-code-session-manager` (trusted publisher not registered on npmjs.com). Other jobs (create-release, linux, windows, mac, finalize-release) succeeded.
- Local fallback (run once, ~/.cache/sm-publish/v0.136.0): npm ci ok, typecheck ok, test:unit first run red (4 files / 3 tests, load flake: runVerify, seedAgentPersonas, telemetryClient), full rerun green 1074/10529. `npm publish` printed `+ claude-code-session-manager@0.136.0` with "may take a few minutes to become available". Worktree removed.
- Registry evidence: cache-busted packument over ~10 tries (~5 min) and again afterwards: dist-tags.latest still 0.135.1, 0.136.0 not under versions, tarball URL 404. Consistent with a staged publish awaiting approval. Not republished, no new version.
- `npm profile get` / `npm token list`: profile get 403 on this machine; 3 classic publish tokens listed.
- Installer assets (GitHub release v0.136.0): found .dmg (arm64, x64), .zip, .exe (win-x64, win-arm64, win), .AppImage, latest*.yml. None missing.
- Manual: skipped, since the npm version is not live (manual.json exists; step 5 runs after a landed publish).

NOT LIVE (at the time of the original job): the publish was staged on npm. The owner approved the staged v0.136.0 publish on npmjs.com afterwards; see "Live confirmation" below.

## Live confirmation

- Checked 2026-11-16 11:39 AM PST (cache-busted packument, read-only; no publish, bump or tag run).
- `dist-tags.latest` = 0.136.0; `versions['0.136.0']` present (true).
- Tarball `claude-code-session-manager-0.136.0.tgz`: HTTP/2 200.
- Manual (builder step 5): no commit in 0.135.1..0.136.0 touches a surface any chapter describes (no chapter covers cross-project feedback/replies, context packs, the phone composer or video target rules; cockpit-tour mentions Video Pages only in passing). Per manual.md, bumped `documentsAppVersion` 0.135.1 -> 0.136.0 only; manual version stays 2.5.0, no content change, no manual release or Bilko bundle.
- Gaps (proposals, not authored): chapter on cross-project feedback + `feedback_reply`; chapter on context packs.

RELEASE: PUBLISHED v0.136.0
