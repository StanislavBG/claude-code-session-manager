---
title: Manual: annotated-screenshot capture pipeline (real figures, no mockups)
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 75
sourcePromptId: marketing-home-page-the-19-99-lets-improve-more--ae3a6f60
---
# Goal

The Field Manual (session-manager-operations/manual/) declares figure slots via `<div class="manual-figure__frame" data-capture="...">` that currently render an honest "pending capture" placeholder. Build the pipeline that turns those declarations into REAL annotated screenshots of the running app: launch the Electron app under xvfb via the existing Playwright-Electron e2e harness, navigate to the surface named by data-capture, screenshot it, and overlay numbered arrow callouts matching the chapter's <span class="callout" data-arrow="..."> entries. Output lands in session-manager-operations/manual/figures/ and is copied verbatim into the release bundle by scripts/build-manual.mjs (which already handles the figures/ directory).

# Acceptance criteria

- [ ] A new script `scripts/capture-manual-figures.mjs` exists and is wired as `npm run manual:figures`.
- [ ] It parses every chapter under session-manager-operations/manual/chapters/ and extracts each figure's id (data-figure), its capture instruction (data-capture), and its ordered callouts with their data-arrow directions.
- [ ] For each figure it drives the real app (reuse the Playwright Electron + xvfb pattern already used by `npm run test:e2e`; do NOT invent a second harness) and writes session-manager-operations/manual/figures/<data-figure>.png.
- [ ] Numbered arrow callouts are composited onto the PNG at coordinates resolved from named DOM selectors declared per-figure — never hardcoded pixel guesses.
- [ ] A figure whose target surface cannot be reached fails LOUDLY (non-zero exit naming the figure) and leaves the existing placeholder in place. It must never emit a blank, cropped, or synthesized image — a fabricated screenshot in a paid product is the failure mode this PRD exists to prevent.
- [ ] Chapter HTML is updated so a captured figure renders <img src="figures/<id>.png"> while an uncaptured one keeps its placeholder div; both shapes render correctly in the /manual reader and in the offline HTML edition.
- [ ] `npm run manual:build` still succeeds and the emitted bundle contains the figures/ directory.
- [ ] `npm run typecheck` and `npm run lint` pass.
- [ ] Honor memory `no_second_electron_while_jobs_run`: the script must refuse to launch when the scheduler queue has a live job, since a second Electron SIGTERMs running jobs and clobbers admin-api.json.

# Implementation notes

Read session-manager-operations/manual/README.md first — it specifies the figure markup contract. The build script is scripts/build-manual.mjs; it already copies session-manager-operations/manual/figures/ into the release. Reuse the Playwright Electron harness config (playwright.config.ts + existing specs under tests/ and e2e/) rather than writing a new launcher. Image compositing: prefer a dependency already in the tree; if none fits, sharp is acceptable — justify the addition in the commit message. The CSS class contract (.manual-figure, .manual-figure__frame, .manual-figure .callout) is duplicated in two places by design and both must keep working: ~/Projects/Bilko/src/index.css (the reader) and the OFFLINE_CSS constant in scripts/build-manual.mjs (the downloadable edition). This PRD is executed by dev-lead.

# Out of scope

- Authoring new chapter prose — only figures.
- Any change to pricing, the session_manager SKU, or the entitlement model.
- PDF generation (separate PRD).

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
