# Validation: demo-video-kit fix wave (fb_mwfubq3p)

Base: 43800306e8471f709eeb2cd6985bae1ac394c2b2. Commits base..HEAD: 138d574d (only one; touches scripts/check-ops-path-literals.cjs, src/main/lib/demo-video-kit/character.cjs).
PRD 3092's own commits landed before Base, so its criteria were checked against HEAD.

## demo-video-kit-character-ops-literal-allowlisted (PRD 3105) — VERIFIED
- ALLOWLIST entry for `src/main/lib/demo-video-kit/character.cjs` added at scripts/check-ops-path-literals.cjs:37. Its reason says the file is seeded standalone into ~/.claude/session-manager/demo-video-kit/, cannot require opsOwnership.cjs, and only reads <ops>/project-pages/videos/_character/.
- `git show 138d574d --stat` shows 1 line in the lint script. No other ALLOWLIST entry was added.
- character.cjs:12 gained one comment line (diff shows +1 line); behaviour is unchanged.
- Gate `npx vitest run scripts/__tests__/check-ops-path-literals.test.cjs .../seedKit.test.cjs .../character.test.cjs` (SM_* and CLAUDECODE unset): 3 files, 22 tests passed.

## demo-video-kit-character-standalone (PRD 3092) — VERIFIED at HEAD
- character.cjs requires only node:fs, node:path and node:child_process (lines 7-9). `OPS_ROOT_DIR` is a local literal (line 13), used at lines 70 and 72.
- seedKit.test.cjs:94 loops over KIT_FILES for the copied-kit child `node -e` load test. It passes in the gate above.
- Real probe under `env -i` with a fresh temp HOME: `seedDemoVideoKit({destDir})` returned seeded/fresh. Every KIT_FILES entry (checks, sound, capture, frames, character, playwrightLoader) was required from that folder in a child `node -e`; all exited 0.

## Full unit suite
`npx vitest run`, every SM_* and CLAUDECODE unset: 1054 files passed, 10255 tests passed, 1 skipped, 0 failed. No red file, so no Base/HEAD re-run was needed. The stderr noise (usePageShell error, canvas getContext) comes from tests that expect it.

## Review
The combined diff is 2 lines. No `/code-review` or `/security-review` was run for this record; I self-reviewed. There are no inputs, secrets or new paths, and no helper is duplicated. The allowlisted literal is a constant, not user input.

## Findings
- Critical: none.
- Important: none.
- Minor: `character.cjs:70` finds the ops root via `segs.indexOf(OPS_ROOT_DIR)`, a path-segment search. This is pre-existing and unchanged. It is outside this plan's scope.
