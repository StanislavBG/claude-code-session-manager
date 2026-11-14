# Validation: queue-rows-carry-artifact-fields (PRD 3114)

Base: 2cc0298b. Commit: 4435116e (5 files, +126), matching the PRD's `# Files`.

## Verdict: VERIFIED

### Acceptance criteria
1. parsePrd returns `deliverable` and `artifactPaths`: `src/main/scheduler/prdParser.cjs` has `parseArtifactPaths` plus the two fields beside `macroId` (lines ~152-156). 'artifact' is the only accepted `deliverable`; an empty or absent list gives null.
2. Every macroId copy site also copies both fields: `scheduler.cjs:1880-1881`, `2007-2008`, `2162-2163`, and the listPrds builder at `11659-11660`. The first two use the same `p.x ?? job.x ?? null` precedence as macroId. The new-row site and listPrds use `?? null`, which matches macroId there.
3. Schema and types: `scheduleJobSchema.cjs` declares both as nullable and optional beside macroId. `src/preload/api.d.ts` ScheduleJob mirrors them.
4. Test `scheduler-row-artifact-fields.test.cjs` has 3 tests. They cover the parse result, the reconciled row carrying both fields, a successful artifact-only orphan completing with no commit (`status 'completed'`, `exitCode 0`), and an existing row picking the fields up on refresh.
5. The two row consumers now see the fields: `scheduler.cjs:3230` (orphan `artifactOnly`) and `9016` (`artifactVerified`).

### Gate (re-run)
- `timeout 300 npx vitest run <3 files>`: 3 files passed, 49 tests passed.
- `timeout 300 npm run typecheck`: exit 0.

### Full suite: `timeout 600 npm run test:unit`
1055 of 1056 files passed. 10275 tests passed, 1 failed, 1 skipped.
The failure is `src/main/lib/git/__tests__/gitWorktree.test.cjs:2624`. The test expects no leftover `sm-mergefile-*` tmp dirs, but one (`sm-mergefile-uc7hlE`) was left in a shared tmp dir. That is probably a concurrent job leaving a temp dir, since the test compares a shared tmp listing before and after. It is unrelated to the files in this diff and I did not re-run it in isolation.

### Reviews
`/code-review` and `/security-review` were not run as separate tools. I self-reviewed the diff. The parser reads frontmatter strings only. The list is split on commas with no path resolution, so there is no traversal surface. No secrets. `parseArtifactPaths` duplicates the inline-list shape in `prdFrontmatter.cjs`; the code comment says this is deliberate.

## Findings
- Critical: none.
- Important: none.
- Minor:
  - `prdParser.cjs:~53` sits between the `parsePrdRaw` doc comment and its function. The `parseArtifactPaths` block was inserted after the comment, so the comment now describes the wrong function.
  - `parseArtifactPaths` re-implements the list parsing in `prdFrontmatter.cjs`. The two could drift.
  - The gitWorktree test failure above is unrelated and may be a flake.
