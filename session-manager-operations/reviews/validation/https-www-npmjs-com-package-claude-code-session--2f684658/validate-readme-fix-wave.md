# Validation: README fix wave

Base: 8f9d30643ff53c2c93fbcde0260af9600bf08843. Commits: 472fadf6 (node-floor), ba9abd1e (check-hardening), a869391b (one-of), 637b68d6 (publish guard).
Self-review used (no separate review commands run); no secrets, shell use, or path traversal found (`execFileSync` with arg array, no shell).

## readme-node-floor-spec — VERIFIED
- Region regex + "README.md has no gen:node-floor region" message: tests/unit/node-floor.spec.ts:77-86.
- Value equals `engines.node` minus `>=`; major/minor equal `nodeFloor()`: same lines.
- Only that file changed for this PRD (472fadf6).
- Gate `npx vitest run tests/unit/node-floor.spec.ts`: 10 passed. `npm run test:unit` at HEAD: 1084 files, 10877 passed, 1 skipped.

## readme-check-hardening — VERIFIED
- Per-section + preamble grading, `MAX_SECTION_GRADE = 8.0`, 40-word floor, failing headings printed: scripts/check-readme.cjs `splitSections`/`checkGrade`.
- `checkRequiredRegions` covers 5 gen + 3 list regions, each named: check-readme.cjs `GEN_NAMES`, `checkRequiredRegions`, wired in `runRules`.
- Known paths via `git ls-files -z --cached --others --exclude-standard` (no shell): `listKnownPaths`.
- Packs from `listPacks()`; PERSONAS==folder test: src/main/__tests__/seedAgentPersonas.test.cjs (end of file).
- Tests for each rule added in scripts/__tests__/check-readme.test.cjs (+161 lines).
- Gates: `npm run lint:readme` exit 0; vitest on check-readme + seedAgentPersonas pass; `npm run lint` exit 0.

## readme-one-of-args — VERIFIED
- `requiredOneOf` optional schema field: src/main/lib/mcpToolCatalog.cjs:36; set on project_page_write, project_matrix_write, project_video_write, project_demo_video_write, project_character_write.
- Rendering `` one of `a` / `b` ``: check-readme.cjs `renderRegions`; README.md rows 178-184 show the groups.
- Tests: mcpToolCatalog.test.cjs:253-302 (names exist in inputSchema, handler says "exactly one of", composeDescription unchanged).
- Gates: the 4-file vitest set passes (356 tests across the combined run), `lint:readme` and `lint` exit 0.

## readme-publish-guard — VERIFIED
- package.json prepublishOnly ends ` && npm run lint:readme`, earlier steps first.
- scripts/README.md has the check-readme.cjs entry; project-partition.md:41 row rewritten.
- Gates: `npm run lint` exit 0; package-files.test.cjs passes.

## Findings
### Critical
- none
### Important
- none
### Minor
- Files outside the PRDs' `# Files` lists were changed: CLAUDE.md (npm publish line), scripts/package/__tests__/build-scripts.test.cjs (new prepublishOnly test), session-manager-operations/architecture/build-target.md (prepublishOnly chain). All are consistent with the guard and correct; just unlisted.
- check-readme.cjs `listKnownPaths` excludes deleted-but-tracked files (beyond spec); sensible, but untested by the PRD criteria.
