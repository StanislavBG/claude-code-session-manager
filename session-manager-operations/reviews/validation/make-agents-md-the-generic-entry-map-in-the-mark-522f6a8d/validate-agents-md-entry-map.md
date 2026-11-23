# Validation: AGENTS.md entry map plan

Base: 5be58ddc (given). Gates re-run in the job worktree: `npm run lint:docs` ok (26 junctions, 50 files); vitest over every gate file: 19 files / 216 tests pass; `npm run typecheck` exit 0. Review skills not run; self-review of the diff (below).

## agents-md-pair-standard — VERIFIED
- placement.md:37 section "AGENTS.md and CLAUDE.md"; line 27 table row replaces the old import row.
- migrate-to-agents-md.md exists; linked from SKILL.md:43. lint:docs passes.

## drift-check-agents-md-pair — VERIFIED
- drift-check and md-duplicates tests pass (in the 216). Running drift-check on the repo reports no claude-md-stub-missing-import / agents-md-not-loaded / fact-in-both.

## doc-lint-agents-md-map — VERIFIED
- check-doc-hierarchy.cjs header (lines 6-20) and JUNCTIONS (line 54) use the AGENTS.md map and the pair budget and stub rule. health-claude-md-budget and check-doc-hierarchy tests pass.

## md-scan-agents-md-hub — VERIFIED
- mdNetworkScan, mdDocCensus, mdNetworkLinkParity and memoryMdNetwork tests pass; typecheck exit 0.

## ops-sweep-agents-md-map — VERIFIED
- ops-sweep-claude-md-fallback test passes (scripts/ops-sweep.cjs changed, 76 lines).

## codex-adapter-reads-claude-md-fallback — VERIFIED
- codex.cjs:13 `FALLBACK = ['-c','project_doc_fallback_filenames=["CLAUDE.md"]']`; all src/main/lib/agent-cli/__tests__ pass.

## migrate-sm-root-to-agents-md — VERIFIED
- `git diff -M` shows rename CLAUDE.md => AGENTS.md (100%); CLAUDE.md is exactly `@AGENTS.md`.
- AGENTS.md:9 budget paragraph names `wc -c AGENTS.md CLAUDE.md`; pair = 11,931 chars (<= 12,000). Conventions line at AGENTS.md:126. No `CLAUDE.md#` anchor links remain.
- Live check: `claude -p --model claude-haiku-5-5 --strict-mcp-config --max-turns 1` quoting the first law line returned "- **TAB = cwd = Main Project.** One TAB per project; extra sessions within a project are Epics, not tabs." — the first law line of AGENTS.md.

## migrate-sm-scoped-to-agents-md — VERIFIED
- All 8 scoped folders have AGENTS.md + CLAUDE.md = `@AGENTS.md` (git ls-files). Root table links the AGENTS.md files; JUNCTIONS lists them (check-doc-hierarchy.cjs:54-67). plugins/CLAUDE.md existed at base, plugins/AGENTS.md is new (git shows create + a delete-side stub; the migration commit is 2ed25c17).

## Findings
### Critical
- none
### Important
- none
### Minor
- Root AGENTS.md pair is 11,931 / 12,000 chars: 69 chars of headroom.
- Foreign worktree changes (project-pages, knowledge screens) are outside this plan and were not touched.
- /code-review and /security-review were not invoked; the diff is docs, lint and argv builders. The codex argv uses spawn (no shell), no secrets or path input added.
