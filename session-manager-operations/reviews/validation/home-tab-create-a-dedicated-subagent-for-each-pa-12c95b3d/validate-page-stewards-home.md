# Validation — Home-tab page stewards

Base: 736c8522c94026d298e5af1c4a3361feef8da40b. HEAD: 8d5c2235. 24 files, +1580/-1 (`git diff --stat`).
Note: the worktree has no `node_modules`; I symlinked the main checkout's (gitignored) to re-run gates, then removed the link.

## Gates re-run (all green)
- `npx vitest run scripts/__tests__/page-surface.test.cjs scripts/__tests__/check-page-stewards.test.cjs` → 2 files, 21 tests passed.
- `npm run lint:page-stewards` → `check-page-stewards: clean`. `npm run lint:docs` → ok (20 junctions, 32 files). `npm run lint` → ends green (smells OK, page-stewards clean).
- Spot checks: `--list` printed all 18 NAV_ITEMS keys (grep of navGroups.ts: 18); `--duplicates` → `agents.savePersona -> agents:save-persona (2) agent-library, tag-library`; `skills --json` → owned 1, api 4, tests 4; `zzz` → `page-surface: unknown NavKey 'zzz'`, rc=2.

## Per-PRD
- **ps-charter-page-stewards-doc — VERIFIED.** page-stewards.md has the six `###` principles (6 `How to check:` lines) plus How a steward works / Audit report / Severity / Naming. README row at architecture/README.md:22. `.gitignore:20` `!.claude/agents/page-*.md` right after project-home-builder; `git check-ignore` rc=1. src/renderer/CLAUDE.md:23 pointer, 2378 bytes. No `src/…:NN` refs, no markdown links to the two scripts, no page counts.
- **ps-page-surface-pages-and-graph — VERIFIED.** `listPages`/`importGraph`/`classifyPages` present; tests green; `--list` entries match (terminal `-`, voice → VoiceModal.tsx, projects faces home,project).
- **ps-page-surface-ipc-map — VERIFIED.** api/sharedApi populated (skills api 4); agent-library `agents.savePersona` appears in duplicates; tests green. See Minor 1.
- **ps-page-surface-tests-dupes-cli — VERIFIED.** CLI flags `--json/--list/--duplicates`, unknown key rc=2; tests drive the CLI; scripts/README.md row added (diff stat).
- **ps-lint-page-stewards — VERIFIED.** scan/PENDING exported, validation rules tested, `lint:page-stewards` in package.json and the lint chain; gate green.
- **ps-lint-page-stewards-ratchet — VERIFIED.** Lint clean with all 14 Home personas present and PENDING ratcheted to project-home/terminal/scheduler/memory (lint would report stale entries otherwise); gate and `npm run lint` green.
- **ps-steward-{overview,projects,history,system-prompt,skills,plugins,mcp,hooks,permissions,settings,agent-library,tag-library,voice,data-model} — all VERIFIED.** Each persona: 6 frontmatter keys (name, description, tools, model: sonnet, effort, title), 38–59 lines (≤120), `## Your page` / `## Page invariants` / `## Boundaries` present, entry path matches `page-surface --list`, tracked (not ignored), `lint:page-stewards` validates all 14.

## Cross-plan check
- Every repo path in backticks across the 14 personas exists (script check: zero MISSING). Runtime `~/`/`<cwd>/` paths spot-checked against code: ui-settings-prefs.json, projects-prefs.json, history-rollup.jsonl, voice.json, session-slots-config.json, web-remote.json, ui-chrome-prefs.json, telemetry.json, otel.json, billing-cache.json, .scheduler-mcp-seeded, remote-audit logs, epic-worktree-config.json, ui-prefs, installed_plugins.json all appear in src/. No persona restates the six principles; the only hits are the one-sentence pointer to the charter. No persona fails.

## Combined diff review (self-review; no product code changed outside scripts/personas/docs)
Scripts are dev-time only, read repo files under a fixed root, key args are matched against `listPages` keys (no path built from user input). No secrets.

## Findings
### Critical
- none
### Important
- none
### Minor
1. PRD file `prds/1667-ps-page-surface-ipc-map.md` is still in `prds/` (queued) although its commits (82e509b2, merge d6563033) landed — queue-state bookkeeping lag, not a code issue.
2. Persona wording differs slightly (some use ". Then run", some ", then run") — cosmetic.
3. The `<path>` untracked file in the worktree root is the known sqlite MCP placeholder artifact, not part of this plan.
