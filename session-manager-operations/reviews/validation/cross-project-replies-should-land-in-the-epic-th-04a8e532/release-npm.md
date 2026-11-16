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

NOT LIVE: owner must approve v0.136.0 on npmjs.com (staged publish), then the gate turns green. The line `RELEASE: PUBLISHED v0.136.0` is deliberately withheld until the version is live.
