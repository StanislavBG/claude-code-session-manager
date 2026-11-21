# Validation: agent-first README plan

Base: 94b3e4575ec7b13f5fb5d13d9495ff91e93e7a7c. Commits: 771f85f5 (catalog summaries), d2f64df0 (markdownToProse), baadf404 (generator), 1258dbdf (check rules), 7949c953 (README + package.json).

Gates re-run (all exit 0): `npx vitest run` on mcpToolCatalog, schedulerMcpServerHelp, readability, check-readme, package-files tests (5 files, 246 tests pass); `node web/manual/readability.mjs` (0); `node scripts/check-readme.cjs` (0); `--write` left README.md unchanged (idempotent); `npm run lint` (0, ends with lint:readme).

## readme-mcp-tool-summaries — VERIFIED
- Schema field, 30 entries with summaries, unique/grade/composeDescription tests: `src/main/lib/mcpToolCatalog.cjs` (+31 lines) and its test (+44) pass.
- Diff of the catalog contains only `summary` lines; no other field changed. help test stays green.

## readme-markdown-prose — VERIFIED
- `markdownToProse` exported in `web/manual/readability.mjs` (+94); new tests pass; existing tests and CLI (exit 0) unchanged.

## readme-generator — VERIFIED
- `scripts/check-readme.cjs` exports loadSources/renderRegions/applyRegions; `node scripts/check-readme.cjs` exit 0; `--write` idempotent (git status shows no README change). Tests cover the listed cases. package.json has `lint:readme` and `readme:build`.

## readme-check-rules — VERIFIED
- Rules (grade, links, repo links, size, lists) run in `main()`; `MAX_GRADE`/`MAX_BYTES` tests pass; real README passes all of them (22,069 bytes < 24,000).

## readme-rewrite-agent-first — VERIFIED
- H2 order matches the skeleton (Facts, Not, Features, Headless surface, Skills, Install, Reference, Development, Links, License); all gen and list regions present.
- package.json description and keywords match the PRD exactly; `lint` ends with ` && npm run lint:readme`.
- No emoji/images/badges found by grep.
- Spot-checks against code (all confirmed): installer formats/arches vs `electron-builder.yml` (dmg+zip arm64/x64, nsis x64/arm64, AppImage x64); marker `.scheduler-mcp-seeded` and `SM_SEED_SCHEDULER_MCP_DISABLE` in `src/main/seedSchedulerMcp.cjs:16,47,170`; `admin-api.json` in `schedulerPaths.cjs:174`; four `SM_SEED_*_DISABLE` vars exist in src/main; `--simple` at `src/main/index.cjs:595`; four guard hooks in `scripts/hooks/`; run mode `when-available` in `scheduler.cjs:514`; `SM_SCHEDULER_JOB_MCP_TOOLS` in `scripts/scheduler-mcp-server.cjs:810`.

## Findings
- Critical: none.
- Important: none.
- Minor: README contains the GitHub handle `StanislavBG` in repo URLs (README.md:11,264,349 etc.). It is a URL handle, not a real name or email; unavoidable for absolute links.
- Minor: working tree shows foreign deletions of `session-manager-operations/project-pages/*` (not this plan's work; ignored).
- Not run as separate skills: /code-review and /security-review; self-reviewed the diff: no shell use in the new script (execFileSync), no secrets, no path traversal from README input.
