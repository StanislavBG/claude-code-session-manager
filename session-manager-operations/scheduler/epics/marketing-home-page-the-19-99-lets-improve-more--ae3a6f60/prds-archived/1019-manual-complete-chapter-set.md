---
title: Manual: complete the tab-by-tab chapter set (25+ surfaces)
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 90
sourcePromptId: marketing-home-page-the-19-99-lets-improve-more--ae3a6f60
dependsOn: [manual-figure-capture-pipeline]
---
# Goal

v1.0.0 of the Field Manual ships 3 chapters (Getting Started, Epics & Sessions, Scheduler). The product promise on the sales page is a tab-by-tab operator's guide, so the remaining surfaces need chapters before the manual is worth $19.99. Author chapters for the major nav destinations that have real operator content: Home/Project Brief, Settings & scopes, Permissions, Hooks, MCP Servers, Skills, Agent Library, Tag Library, History (analytics), Memory Clusters, Usage, Voice, Plans/Tasks, and Simple Mode. Bump the manual to 1.1.0 and rebuild the bundle.

# Acceptance criteria

- [ ] Each new chapter is a plain HTML fragment under session-manager-operations/manual/chapters/ with a unique lowercase-kebab slug, registered in manual.json with a title and a blurb that is safe to show to non-buyers.
- [ ] Every factual claim in every new chapter is verified against real code in this repo at authoring time — file paths, constants, flag names, env vars, and default values must match what is actually there. Do not restate CLAUDE.md; write operator guidance (what the surface is for, the common mistake, the workflow that pays off).
- [ ] The Settings chapter states the substrate-vs-per-Epic-curation rule explicitly: Settings edits on-disk files the CLI reads on every invocation and is NOT per-conversation curation; per-task behaviour belongs in a Tag or an Agent persona.
- [ ] Exactly the existing free chapter (getting-started) remains `free: true`; no new chapter is marked free.
- [ ] manual.json `version` becomes 1.1.0 and `documentsAppVersion` matches the current package.json version at authoring time.
- [ ] `npm run manual:check` and `npm run manual:build` both succeed, and the emitted bundle in ~/Projects/Bilko/data/manual/releases/1.1.0/ contains every declared chapter file.
- [ ] `cd ~/Projects/Bilko && npx vitest run tests/manual.test.ts` passes — it walks the shipped manifest and asserts every advertised chapter and asset exists on disk.
- [ ] Figure slots may be declared for new chapters but MUST use the pending-capture placeholder shape; no fabricated screenshots.

# Implementation notes

Read session-manager-operations/manual/README.md and the three existing chapters first — match their voice, structure (lede → h2 sections → manual-table / manual-note / manual-steps), and density. The CSS classes available are enumerated in the README and in the OFFLINE_CSS constant of scripts/build-manual.mjs; do not introduce new class names without adding them to BOTH that constant and ~/Projects/Bilko/src/index.css. Ground each chapter by reading the corresponding component under src/renderer/components/tabs/ and its backing main-process module. This PRD is executed by dev-lead.

# Out of scope

- Screenshot capture (PRD 1018 owns it).
- Changes to the Bilko-side routes, pricing, or entitlement model.

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
