# Validation: one standard video player (fb_mwjnwfgj)

Base: f9255ebe9bc33e77a31709d67b230beed427cc57. Commits: 2564ae98 (persona), ced7f1b3 (check), 38f4dca0 (delete frame).

## demo-video-persona-no-own-controls — VERIFIED
- demo-video-builder.md:171-176 — smDemo has duration/seek/play/pause/scenes (scene markers); "draws no playback UI at all" listed; no play/pause/progress ask.
- audio_policy (~248): autoplay rejection → keep playing muted, host sound button unmutes.
- reduced-motion bullet: storyboard stepped by host seek, no in-video prev/next.
- Frontmatter seedVersion 13 → 14; shippedPersonaSeeds.cjs gained matching seed-v14 entry. No other sections changed (diff read).
- Gate: vitest seedAgentPersonas + seedKit — pass (with checks + admin routes: 4 files, 75 tests).

## demo-video-check-rejects-own-controls — VERIFIED
- checks.cjs:114-143 — case-insensitive `<button`, `<input`, `<audio|video … controls`; reason `own playback controls: <what>`; bridge block (data-sm-player-bridge) stripped first.
- checks.test.cjs +23 lines and projectHomeAdminRoutes.test.cjs +22 lines added (clean, each control kind, bridged clean, save-route refusal).
- Gate: vitest checks.test.cjs + projectHomeAdminRoutes.test.cjs — pass.

## remove-unused-demo-video-frame — VERIFIED
- DemoVideoFrame.tsx and its test deleted in 38f4dca0; `grep -rln DemoVideoFrame src tests` → only tests/quality/summary.json (allowed).
- VideoPlayer.tsx only a doc-comment edit (no longer names DemoVideoFrame).
- Gate: `npm run typecheck` ok; `npm run lint` ok (e2e budget 18/19, scroll OK).

## Full unit suite (SM_* and CLAUDECODE unset via env -u) — NOT GREEN, unrelated
`npm run test:unit`: 1076 files passed, 2 failed, 10635 tests passed. Failures:
- src/preload/__tests__/apiSurface.test.cjs "apiSurface table equals the preload surface exactly"
- src/renderer/components/epics/__tests__/SessionActionsBar.test.tsx:164 macros.save called with extra `scriptStart:false`
Neither file nor the code they cover (preload, macro editor/save) is in this plan's diff (`git diff --stat` shows no src/preload or macro files); they come from other recent work (hotkeys/macros). Pre-existing at base was not re-run (no checkout allowed).

## Real-path probe — pass
Real checkHtmlLimits + real injectPlayerBridge, no stubs (script run from /tmp):
- vid-mwilynyoeq7/index.html (60s): `{"ok":false,"detail":"own playback controls: button"}` — now reported.
- Minimal control-free video: ok:true (210 bytes). After real injectPlayerBridge (marker present, 3785 bytes): ok:true.

## Combined diff review
The diff also carries unrelated commits (epic worktree file links: ChatTranscriptTurn, EpicChangesView, handleChatLinkClick); out of this plan, not reviewed beyond stat. Plan code: regexes are linear, no secrets, no path handling, no duplicate helper.

## Findings
- Important: two failing unit tests above (apiSurface, SessionActionsBar `scriptStart`) — owner of the macros/preload work should fix; they block a green suite.
- Minor: regex check misses `<button` inside HTML comments/strings (false positive) and div-drawn controls (declared out of scope); `shippedPersonaSeeds.cjs` edit is outside the PRD Files list but necessary for the version bump.
- Minor: existing saved videos (all 9) still draw own controls; regeneration out of scope.
