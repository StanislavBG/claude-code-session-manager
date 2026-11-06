# Validation: demo-video marketing features (PRDs 2586-2594)

Base a43a8be5. All commits seen via `git log a43a8be5..HEAD` (5ee434df, b36be5ea, f7f42190, 40cc006e, 164edfa6, 692d3f75, eb53c8cb, 35a1318f, 949792c4).
Gate re-run (one vitest over all 12 touched test files): 12 files / 214 tests pass; `npm run typecheck`, `lint:selectors`, `lint:hooks` OK.
Full `npm run test:unit`: 4 failed / 8407 passed (see Findings).

## kit-checks — VERIFIED
checks.cjs + checks.test.cjs pass in the combined run; ack of each criterion covered by the passing tests (blank frame, 13-word caption, banned word, npx closing, 1.3x line).
## kit-sound — VERIFIED
ffmpeg present (/home/bilko/.local/bin/ffmpeg); verbose run shows "mix lands near -14 LUFS under the true-peak ceiling" executed (not skipped) and passing, i.e. lufs in -15.5..-12.5, truePeakDb <= -1.0; same-seed determinism and ebur128 parse pass.
## kit-capture — VERIFIED
capture.test.cjs passes (no-url, no-playwright, budget loop, max 6).
## kit-frames — VERIFIED
frames.test.cjs passes incl. the Playwright two-scene blank-frame fixture (ran, 207 ms).
## kit-character-route — VERIFIED
character.test.cjs and projectHomeAdminRoutes.test.cjs pass (first write, refusal, replace, argv no-shell).
## kit-seeder-and-character-tool — VERIFIED (with Important finding)
seedKit.test.cjs and schedulerMcpServerProjectHome.test.cjs pass. But seedKit.cjs:25 trips the repo's ops-path-literal lint test (see Findings).
## video-gate-cheap-checks — VERIFIED
projectHomeAdminRoutes.test.cjs passes covering checkHtmlLimits 400, report.checks ok:false 400, alias exemption.
## demo-persona-v8-marketing-features — VERIFIED
seedAgentPersonas, builtinMacros, personaToolScope tests pass (seedVersion 8, needles).
## demo-macro-v6-kind-target — VERIFIED (with Important finding)
builtinMacros.test.cjs and ProjectPagesSection.test.tsx pass; typecheck/lints OK. Version bump left a stale expectation in macroLibrary.test.cjs.

## Findings
### Important
- src/main/lib/persona-macro/__tests__/macroLibrary.test.cjs:431 — "real demo-video v4 copy with a late updatedAt upgrades to v5" expects builtinVersion 5, now 6 (caused by 2594; file outside its Files list). Fails test:unit.
- src/main/lib/demo-video-kit/seedKit.cjs:25 — `path.join(os.homedir(), '.claude', 'session-manager', 'demo-video-kit')` fails scripts/__tests__/check-ops-path-literals.test.cjs "the real repo tree is clean" (caused by 2591). Fails test:unit.
### Minor (pre-existing / not this plan)
- src/preload/__tests__/apiSurface.test.cjs:68 — projectPages.rename/projectPages.delete missing from the table (from earlier commit 96ea5e34, not this plan's PRDs).
- src/renderer/components/__tests__/ProjectHomeEmptyState.test.tsx "renders no hand-written live blocks…" fails; not diagnosed (likely tied to earlier Project Home library work or the foreign dirty home.html); not attributed to this plan.
- The "full test:unit green" criterion is NOT met (4 red).
