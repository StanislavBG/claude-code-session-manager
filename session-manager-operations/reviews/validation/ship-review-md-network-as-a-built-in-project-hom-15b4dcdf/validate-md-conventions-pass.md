# Validation: md conventions pass (PRDs 2756-2763)

Base: 883786f8. All eight PRD files found in `prds-archived/`. Commits per PRD located via `git log 883786f8..HEAD` (4b3c3bca, d7dc8e6f, f3629ef2/547d774f, c5fb2e06, df9b11de, 9a38e937, 94bb42df, 0c9219e5 and their merges).

## md-conventions-host-boundary — VERIFIED
- Gate re-run: drift-check on host-boundary.md exit 0, `"counts": {}`.
- Diff (host-boundary.md, 52 lines) read word-by-word: only path spans change (`Bilko:` prefixes, repo-root prefixes, de-backticked `src/lib/sessionManagerCheckout.ts`, `web/manual-app/`, `refs/sm-stranded/`, `scheduler/prds/`). No prose changes.

## md-conventions-partition-marketing-ops — VERIFIED (see Important finding 1)
- Gate re-run: exit 0, counts empty.
- Stale `web/project-pages/generate-font-data.mjs` (project-partition.md:51, :74): de-backticked to plain text, not re-pointed. The file was deleted in 536d7ed4; no replacement exists (`git ls-files | grep font-?data` is empty). It passes the gate but the sentence still claims the script writes `library/fontData.ts`. Counted as "reworded" only in the weakest sense.

## md-conventions-domain-conventions-scheduler — VERIFIED
- Gate re-run: exit 0, counts empty.
- Diff of domain-model.md, conventions.md, scheduler-operations.md: path spans only (repo-root prefixes, `~/.claude/session-manager/` prefix, de-backticked retired `scheduler/prds/` and `videos/_character/`). conventions.md:79 adds the words "the videos/_character/ folder" around the path, which is a trivial path-span-adjacent wording change.

## md-conventions-arch-readme-feedback-telemetry — VERIFIED
- Gate re-run: exit 0, counts empty.
- Stale `web/project-pages/assets.cjs` and `publish-gate.cjs` entries in README.md reworded as "the retired ..." with removal commits (00bbdcc6, 536d7ed4). One checker sentence was reworded: the "three checkers" text now names the removed `check-unregistered-tests.cjs` checker as gone. That is more than a path-span edit, but it is within the PRD's rule 4 (fix stale paths by rewording).
- `Bilko:` prefixes added in customer-feedback.md and telemetry.md.

## md-conventions-manual — VERIFIED
- Gate re-run: exit 0, counts empty.
- Release-note facts: RELEASE-2.0.0.md and RELEASE-2.0.1.md diffs change only path spans (`Bilko:` prefixes; de-backticked `src/pages/ManualPage.tsx`). Version numbers, dates, test names and claims are untouched. README.md only de-backticks `assets/`.

## md-conventions-claude-md-web-pages — VERIFIED
- Gate re-run: drift-check exit 0. `wc -c CLAUDE.md` = 11983, which is 12,000 or less. `npm run lint:docs` ends "doc-hierarchy: ok (21 junctions, 35 files linted)" with exit 0.
- CLAUDE.md diff is one line: `scheduler/prds/` and `prds-archived/` de-backticked.

## md-conventions-seeded-templates-personas — VERIFIED
- Gate re-run: drift-check exit 0. PRD_AUTHORING.md line 1 is `<!-- PRD_AUTHORING.md v19 -->`.
- Persona edits are 1-line each (validator.md, demo-video-builder.md).

## md-conventions-shipped-skills — VERIFIED
- Gate re-run: drift-check exit 0. `vitest run scripts/__tests__/dev-plugin-skillset.test.cjs`: 3 passed.
- `git diff 883786f8..HEAD -- plugins/session-manager-dev/skills/develop/standards.md` is empty, so standards.md is untouched.

## Real-path evidence
Command run on the merged tree (worktree, HEAD 1b446fbe):
`node plugins/session-manager-dev/skills/maintaining-md-network/scripts/drift-check.cjs --root . --exclude session-manager-operations/reviews --exclude session-manager-operations/design-mocks --exclude content/blog`
Result: exit 1; counts `no-contents-list` 32, `broken-link` 4, `missing-path` **1** (114 before, now 1).

- missing-path `src/renderer/CLAUDE.md:17` target `web/project-pages` — the line reads "`web/project-pages` is gone." It is a retired path named on purpose, so the finding is true in form. The script flags it, and the file is outside all eight PRDs. The fix is to de-backtick it.
- broken-link x4 `session-manager-operations/CLAUDE.md:37,39,41,47` (`feedback/`, `logs/`, `memory-clusters/`, `ui-prefs/` README.md) — the targets sit in gitignored runtime namespaces (`.gitignore:53-54`), so they are absent in a job worktree. This is a script gap: lint:docs already treats these as "gitignored and absent (excluded)" notes, while drift-check lacks that exemption. They are not stale paths.
- no-contents-list x32 — a different check, not part of the path pass. Not assessed.

## Findings
### Critical
- none
### Important
1. `session-manager-operations/architecture/project-partition.md:51,74` — `generate-font-data.mjs` and `library/fontData.ts` are still described as live, in plain text. The file is gone (536d7ed4). The gate cannot see this, because plain text escapes the check. This is a stale reference the PRD asked to be "fixed or reworded"; it was only hidden. Reword it as retired, as the README entries were.
### Minor
1. `src/renderer/CLAUDE.md:17` — the one remaining missing-path. De-backtick it.
2. drift-check has no exemption for links to gitignored runtime targets (session-manager-operations/CLAUDE.md:37-47). Gap in the script; lint:docs already has one.
3. `session-manager-operations/architecture/conventions.md:79` and README.md carry small non-path wording additions (see the PRD sections above).
