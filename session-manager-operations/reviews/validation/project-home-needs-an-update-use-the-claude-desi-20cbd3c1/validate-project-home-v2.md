# Validation: Project Home v2 (validate-project-home-v2)

Base: ae16cfec7ff20bd5208c7011e7ad9e9f79de3010 → HEAD 8e846be9 (15 commits, 51 files, +9430/−836).
All 15 PRDs (2807–2820, 2822) found under `prds-archived/`. Foreign WIP (`project-pages/home.html`, `demo-video/index.html`) untouched.

## Full suite (SM_* env unset)
- `timeout 900 npm run test:unit` — 947 files passed, 8946 tests passed, 1 skipped (exit 0). Noisy stderr (VoiceModal getHotkeyConfig, canvas getContext) is pre-existing jsdom noise, not failures.
- `npm run typecheck` — exit 0 (renderer + main tsconfig).
- `npm run lint` — exit 0 (selectors, hooks, doc hierarchy, page-stewards clean, e2e budget 18/19).
- Per-PRD gates are subsumed by the full suite (each gate is a vitest subset + typecheck/lint).

## Per-PRD verdicts and evidence

- **ph2-composer-templates — VERIFIED.** `composerTemplates.ts` (356 lines) + `composerTemplates.test.ts` (352) landed (2281cb1e); covered by the passing suite.
- **ph2-replace-entry-line — VERIFIED.** `macroJobDispatch.cjs` `ENTRY_ID_RE=/^[a-z0-9][a-z0-9-]{0,63}$/` gates `/^\s*Replace entry:\s*(\S+)\s*$/im` before the video/Page branches, so it wins for both kinds; invalid values (`../x`, `A B`, `vid_1`, 65+ chars) fall through. Tests added; suite green.
- **ph2-builtin-prompt-lines — VERIFIED.** Run in node: builtin-project-home v3 / 2 priors, builtin-demo-video v7 / 6 priors (= priors+1 both), builtin-review-md-network v1 / 0 priors (unchanged). New prompts carry `Audience:`, `Length:`, `Read from:`, `Character: off`, `Video style: Auto`; the v2/v6 prompts are the last priorPrompts entries.
- **ph2-md-network-scan — VERIFIED.** `scanMdNetwork(process.cwd())` on this repo: `ok=true, docs=364, links=110, nodes=48, findings=12, scopes=7`. `lib-layout.json:85` lists `"mdNetworkScan": "."`; JSON cannot hold comments so the stated reason lives in the module header (`mdNetworkScan.cjs:9`, "Top-level in lib/ because no subfolder fits"), which is what `src/main/lib/CLAUDE.md` asks for.
- **ph2-md-network-ipc — VERIFIED.** `projectPages.cjs:277` registers `project-pages:md-network`; ephemeral-cwd refusal at `:92`; preload `index.cjs:399`; `apiSurface.json:1376`; api.d.ts types added; apiSurface/preload parity tests pass.
- **ph2-key-buttons-shell — VERIFIED.** `ProjectHomeKeyButtons.tsx` (testids project-home-key, count, meta); `ProjectHome.tsx:100` full-height column `gap-[18px] px-[28px] pt-[22px] pb-[20px]`, no `max-w-[1080px]`; panes use `252px minmax(0,1fr)`; PageSwitch/page-switch gone from all code (only a test mention of its absence); hint updated in navGroups.ts.
- **ph2-generate-composer — VERIFIED.** `GenerateComposer.tsx` + 307-line test; regen mode and Escape/overlay covered by tests that pass.
- **ph2-pages-pane — VERIFIED.** `PagesPane.tsx` has project-home-generate, regenerate, library header/count; `EXTRA_INSTRUCTIONS_CAP=4000` with `Replace entry` tail line never cut (`PagesPane.tsx:50,242`).
- **ph2-videos-pane — VERIFIED.** `VideosPane.tsx`: video-thumb/duration, video-sources, video-report, video-check, project-home-regenerate present; grid 252px.
- **ph2-building-state — VERIFIED.** `BuildingPanel.tsx` (testids per PRD), `project-home-building-row` in both panes, success toast `“<title>” is ready` at `ProjectPagesSection.tsx:73`; BuildingPanel tests pass.
- **ph2-empty-state-templates — VERIFIED.** `LibraryEmptyState.tsx`: template-card / -quick / -customize, tip strip, `library-empty-tools` link; tests pass.
- **ph2-tools-pane — VERIFIED.** `ToolsPane.tsx`: project-home-add-tool, project-home-tool, run-review, footnote text present; `MacroEditor` accepts `defaultSurface`; HotKeyStrip no longer referenced outside a test.
- **ph2-md-link-map — VERIFIED.** `MdLinkMap.tsx` viewBox `0 0 760 392`, legend, caption, findings card with Open; ToolsPane reports findings count via `onFindingsCount` → key button; info text matches `<docs> docs · <links> links · <n> findings. …`.
- **ph2-docs — VERIFIED.** project-pages README documents composer, Replace entry, Tools; 8 code-map matches; no `DemoVideoFrame` mention; `CLAUDE.md` untouched (11,983 chars < 12,000).
- **ph2-builder-overlay-sync — VERIFIED.** `.claude/agents/project-home-builder.md` description identical to `src/seed/agents/project-home-builder.md`; no `home.html` / `project_home_write` remain; lint green.

## Visual comparison (code vs renders/*.png and DESIGN_SPEC §1–7)
Judged from code and spec; renders were not diffed pixel-wise. Matching: key-button grid, 22/28/20 padding and 18px gap, 252px list column, 760×392 map viewBox, 104px template preview, serif title bars, accent Generate buttons. Section 8 deviations (no SCENES chips, no stale findings, no status-bar item, no in-page review strip) not flagged.

## Findings
### Critical
- none
### Important
- none
### Minor
- `PagesPane.tsx` truncates joined instructions by dropping focus then cutting fixed lines; fine, but the PRD said "truncate focus text first" — same outcome, untested at the exact boundary beyond the unit test.
- ph2-building-state asked `ProjectHome.tsx` to hold the per-macro launch record and the done-toast; implementation places the toast logic in `ProjectPagesSection.tsx:73`. Behaviour equivalent; location differs from PRD text.
- `lib-layout.json` has no inline reason (JSON); reason is in `mdNetworkScan.cjs:9` header. Acceptable under `src/main/lib/CLAUDE.md`.
- The scan on this repo reports 12 findings (broken links/orphans) — real doc drift, not a plan defect.
