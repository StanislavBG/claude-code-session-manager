# Validation: config screens editable (Base 81fda522)

Commits: d54d9c1f (parser), 75cc4ee0 (denylist), 8ede4f9b (config write), 44a7cb8d (workbench). PRD files found in prds-archived/ (3552-3555).

## claude-md-import-parser-matches-cli — VERIFIED
- Parser/walkImports gate: `vitest personaImportHealth.spec.ts importReferences.spec.cjs` green (with denylist/config files: 5 files, 36 tests pass).
- package.json:153 `marked ^14.0.0` is under `dependencies` (line 149 block, devDependencies starts 158); package-lock root has it in dependencies, not devDependencies; `node_modules/marked` has no `dev` flag.
- `npm run typecheck` exit 0.

## sensitive-write-denylist-shared — VERIFIED
- `grep rejectCredentials src` hits only the test's import alias of `assertNotSensitiveWrite`; no definition left in files.cjs.
- insideHome.sensitiveWrite.test.cjs, files-reject-credentials.test.cjs, filesProjectRoots.test.cjs pass.

## config-write-text-instruction-files — VERIFIED
- src/main/config.cjs:222 `checkInstructionWrite` (sensitive → ops-root → basename → importedBy via walkImports + realpath → `not-imported`); :262 `writeRendererText` uses validateWrite-or-instruction rule then assertOpsWrite + atomic write; `config:write-text` handler (:634) uses it.
- Exported `writeTextAtomic` (:339), `writeJson`, `validateWrite` (:341/:354/:382) still call strict `validateWrite`; test proves direct `writeTextAtomic(<root>/CLAUDE.md)` throws.
- Gate: configInstructionWrite, configWriteBoundaryOwners, config.mcpJsonWrite, ipc-config, apiSurface: 5 files / 64 tests pass.

## claude-md-workbench-edits-roots-and-imports — VERIFIED
- ClaudeMdWorkbench.tsx:330-335 `canWrite(activeRoot)` / `canWrite(ref.path, { importedBy: activeRoot })`; :93-102 five exact reason sentences; old "outside the folders" text appears only in a negative test assertion.
- Gate: typecheck 0; vitest claudeConfig + tabs/__tests__ + state + ipc-config: 102 files / 1031 tests pass; playwright `claude-config-shots` 1 passed.
- Regenerated test-results/claude-config/home-claude-md-import.png in this worktree and viewed it: `rules/git.md` import selected, row meta "Imported · editable here", editor with Save control, no READ-ONLY badge, no read-only note. Spec asserts this (claude-config-shots.spec.ts:307).

## Review
Combined diff is 74 files (it includes unrelated commits between base and HEAD). Self-reviewed config.cjs: the importedBy path goes through validatePath, is restricted to CLAUDE.md/CLAUDE.local.md names, and compares realpaths (symlink-safe); sensitive and ops-root checks run before allow. No secrets or path-traversal issues found. /code-review and /security-review were not run as skills; self-review only.

## Findings
- Critical: none.
- Important: none.
- Minor: the shot selects `rules/git.md` rather than the `@~/Projects/Agents/shared/core.md` import named in the PRD; the stub's first import satisfies the criterion text ("first import"). No action required.
