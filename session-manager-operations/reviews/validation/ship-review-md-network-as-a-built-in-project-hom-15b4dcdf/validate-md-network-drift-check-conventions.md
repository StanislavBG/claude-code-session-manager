# Validation: drift-check ellipsis/ignore marker + path conventions doc

Base: d7ba5efc. Commits: d72b14bf (script + tests), 74eb3cef (doc + 0.3.3).

## drift-check-ellipsis-and-ignore-marker — VERIFIED
- Code: `drift-check.cjs` IGNORE_MARKER (line ~103), ellipsis rules in `isRepoPathCandidate`, `ignoredLines` skip in links and paths loops.
- Gate: `npx vitest run md-network-drift-check + dev-plugin-skillset` → 2 files, 22 tests passed.
- Temp repo (src/main exists; CLAUDE.md has `src/main/...`, a marked line with missing path + link, an unmarked line with same): findings = only line 4 (broken-link gone/x.md, missing-path gone/missing.ts). Ellipsis line 2 and marked line 3 → no findings.

## drift-check-path-conventions-doc — VERIFIED
- Gate (vitest 22 pass; script on drift-check.md with links,limits,contents) → exit 0, findings [].
- "Path conventions" section (drift-check.md) lists: other-repo `Repo:path` prefix (matches SCHEME_RE skip), `~/` leading tilde skip, plain text/ignore marker for retired paths, `...` placeholder skip. All match the script.
- plugin.json version 0.3.3 == marketplace.json plugin entry 0.3.3 (marketplace's own `0.1.0` is a separate field).

## Real-path evidence (read-only, with the 3 excludes, against /home/bilko/Projects/session-manager)
- Exit 1 (findings). 79 files checked. missing-path: **114** (vs 117 before; −3). Also 32 no-contents-list.
- 10 evenly spaced samples:

| # | Location | Span | Class |
|---|---|---|---|
| 1 | CLAUDE.md:109 | scheduler/prds/ | FP — retired path named on purpose |
| 2 | architecture/bilko-run-marketing.md:28 | server/routes/manual.ts | FP — host repo path |
| 3 | architecture/domain-model.md:40 | prompt-sessions/active-index.json | FP — relative to ops root |
| 4 | architecture/host-boundary.md:26 | src/lib/manualClient.ts | FP — host repo path |
| 5 | architecture/host-boundary.md:33 | session-manager-landing/ | FP — host/other repo |
| 6 | architecture/host-boundary.md:84 | server/routes/manual.ts | FP — host repo path |
| 7 | architecture/host-boundary.md:109 | src/data/projectsRegistry.ts | FP — host repo path |
| 8 | architecture/project-partition.md:51 | web/project-pages/generate-font-data.mjs | TRUE stale (dir exists, file does not) |
| 9 | architecture/scheduler-operations.md:292 | prds-archived/ | FP — relative to scheduler dir |
| 10 | manual/RELEASE-2.0.0.md:82 | tests/manual.test.ts | FP — historical release note / host test |

Result: 1 true, 9 false positives in sample. Remaining noise is docs that name other-repo, relative, or retired paths in backticks; the new conventions (Repo: prefix, plain text, marker) are not yet applied to them.

## Findings
- Important: ~114 missing-path findings, mostly FP (sample 90%); the project's own docs do not yet follow the new conventions, so the check is still too noisy to gate on. Follow-up: apply prefix/plain text/marker in those docs (e.g. host-boundary.md:26,33,84,109).
- Minor: project-partition.md:51 names nonexistent web/project-pages/generate-font-data.mjs (true stale).
- Minor: the 117→114 drop is small; ellipsis/marker changes alone barely move the real-repo count.
- /code-review and /security-review: self-reviewed the diff; marker/ellipsis checks are string-only, no path traversal or secret handling added. No issues.
