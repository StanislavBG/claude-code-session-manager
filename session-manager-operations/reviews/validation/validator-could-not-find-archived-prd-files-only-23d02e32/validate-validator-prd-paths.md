# Validation: validator PRD-path fix (Epic validator-could-not-find-archived-prd-files-only-23d02e32)

Base: `0cda1b51cbb120325e556de21baa2e612533d13e`
PRDs under validation: `1534-validator-persona-main-checkout-prd-paths`, `1535-develop-skill-validate-prd-main-checkout-paths`

Live check requested by the PRD: **confirmed**. From this job worktree, `find "$SM_PROJECT_ROOT/session-manager-operations/scheduler/epics/validator-could-not-find-archived-prd-files-only-23d02e32" -name '*.md'` resolved both PRD files successfully via `prds-archived/` (both are archived/terminal) — `$SM_PROJECT_ROOT` (`/home/bilko/Projects/session-manager`) is reachable and populated from this worktree, while the worktree's own `session-manager-operations/scheduler/` does not exist (gitignored, as the fix's rationale states).

## Commits since base

`git log --oneline 0cda1b51..HEAD -- src/seed/agents/validator.md src/main/lib/shippedPersonaSeeds.cjs src/main/__tests__/seedValidatorPersona.test.cjs`:
```
15b5249f fix(validator): resolve PRD files under $SM_PROJECT_ROOT, not the gitignored worktree path
```

`git log --oneline 0cda1b51..HEAD -- plugins/session-manager-dev/skills/develop/SKILL.md`:
```
de2d1305 docs(develop): validate-PRD criteria point to main-checkout scheduler paths
```

Both PRDs landed on `sm-job/1536-validate-validator-prd-paths` HEAD `2b0b27c3` (merge of `15b5249f` into the branch that already had `de2d1305`).

## 1534-validator-persona-main-checkout-prd-paths — VERIFIED

| Acceptance criterion | Evidence |
| --- | --- |
| `## Inputs` paragraph names `$SM_PROJECT_ROOT/.../epics/<epic>/`, `prds/` / `prds-archived/` (or timestamped subfolder), find-by-slug example, and states the folder is gitignored so never in the job worktree | `src/seed/agents/validator.md:14` — full paragraph present verbatim: `"PRD files live under \`$SM_PROJECT_ROOT/session-manager-operations/scheduler/epics/<epic>/\` — \`prds/\` while queued, \`prds-archived/\` (or a timestamped subfolder of it) once terminal; find by slug, e.g. \`find "$SM_PROJECT_ROOT/session-manager-operations/scheduler/epics/<epic>" -name '*<slug>.md'\`. This folder is gitignored, so it is never present in the job worktree — don't look for it there."` |
| Same paragraph gives the queue.json/history.jsonl fallback, Minor (not Important) finding | `src/seed/agents/validator.md:14` — `"If a PRD file is missing, fall back to \`$SM_PROJECT_ROOT/session-manager-operations/scheduler/state/queue.json\` / \`history.jsonl\` for that slug's \`landedCommit\`, and record the missing file as a Minor (not Important) finding."` |
| `seedVersion: 3`; body still ends `report them.`; under `AGENT_BODY_CHAR_CAP` | `src/seed/agents/validator.md:7` — `seedVersion: 3`. Body ends `"- Do the review once; do not loop on findings — report them."` (line 39). Measured body length (content after frontmatter, trimmed): 3302 chars, vs. `AGENT_BODY_CHAR_CAP = 6000` (`src/main/lib/agentModelResolve.cjs:184`). |
| `shippedPersonaSeeds.cjs` `validator` array gains the new version's entry; manifest test passes | `src/main/lib/shippedPersonaSeeds.cjs:210-219` — new entry `bodySha256: "ca159cd47ac4b618af842c6ccd59107fac4a34b0efcfa5dfe7d06875736156ed"` appended after the prior 4 entries, same `fm` shape, `commit: "<fill in>"` placeholder as the PRD's own step 2 instructed when the commit isn't known yet. |
| New pinning test in `seedValidatorPersona.test.cjs`; both test files pass | `src/main/__tests__/seedValidatorPersona.test.cjs:124-131` — `test('the seeded validator body resolves PRD files under SM_PROJECT_ROOT, not the job worktree', ...)` asserts `$SM_PROJECT_ROOT/session-manager-operations/scheduler/epics/` and `prds-archived/` present, and the old worktree-relative phrase absent. |

**Gate** (run from `$SM_PROJECT_ROOT`, same HEAD `2b0b27c3` as this worktree — this worktree has no `node_modules` installed, so the identical-commit main checkout was used instead):
```
$ timeout 300 npx vitest run src/main/__tests__/seedValidatorPersona.test.cjs src/main/__tests__/seedAgentPersonas.test.cjs
 Test Files  2 passed (2)
      Tests  29 passed (29)
```
Green, 29/29.

## 1535-develop-skill-validate-prd-main-checkout-paths — VERIFIED

| Acceptance criterion | Evidence |
| --- | --- |
| Step 4 names `$SM_PROJECT_ROOT/.../epics/<epic-id>/prds/<NN>-<slug>.md` while queued, `prds-archived/` (possibly timestamped) beside it once done, found by slug | `plugins/session-manager-dev/skills/develop/SKILL.md:205-207` — `"(\`$SM_PROJECT_ROOT/session-manager-operations/scheduler/epics/<epic-id>/prds/<NN>-<slug>.md\` while queued, \`prds-archived/\` (possibly a timestamped subfolder) beside it once done; find it by slug."` |
| Step 4 adds a `Why:` clause about `scheduler/` being gitignored and never in the validator's job worktree | `plugins/session-manager-dev/skills/develop/SKILL.md:207-208` — `"Why: \`session-manager-operations/scheduler/\` is gitignored, so it is never in the validator's job worktree."` |
| Record-path sentence stays repo-relative and unchanged; no other section edited | `plugins/session-manager-dev/skills/develop/SKILL.md:208-209` — `"The last: write and commit \`session-manager-operations/reviews/validation/<epic-id>/<validate-slug>.md\`."` unchanged (repo-relative, matches pre-diff text). `git diff 0cda1b51..HEAD -- plugins/session-manager-dev/skills/develop/SKILL.md` shows only this one hunk (step 4), no other section touched. |

Gate: `none` (doc-only PRD) — the per-criterion file reads above are the whole check.

## Diff review

`git diff 0cda1b51..HEAD --stat`:
```
plugins/session-manager-dev/skills/develop/SKILL.md              |  6 ++++--
src/main/__tests__/seedValidatorPersona.test.cjs                 | 11 +++++++++++
src/main/lib/shippedPersonaSeeds.cjs                              | 10 ++++++++++
src/seed/agents/validator.md                                      |  4 ++--
4 files changed, 27 insertions(+), 4 deletions(-)
```
Four files, exactly the two PRDs' declared `# Files` sections (no overlap, no out-of-scope edits — PRD 1534 did not touch `SKILL.md`; PRD 1535 did not touch the persona/seed/test files, matching each PRD's own "Do not touch" line).

`/code-review` (medium, base `0cda1b51`): no findings — confirmed the `reviews/` record path is correctly left worktree-relative (only `scheduler/` is gitignored, `reviews/` is tracked), consistent with the fix's own rationale.

`/security-review`: no findings — diff is persona/skill documentation text, a test assertion, and a seed-manifest data entry; no new input handling, subprocess execution, or secret handling introduced.

## Findings

None — Critical / Important / Minor: no findings.

---

VALIDATION: 1534-validator-persona-main-checkout-prd-paths VERIFIED
VALIDATION: 1535-develop-skill-validate-prd-main-checkout-paths VERIFIED
SCHEDULER_VERDICT: PASS
