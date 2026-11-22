# Validation: md-leftovers plan

Base: 7e69e865 (from the PRD). Commits: 937ed8c7 (3654), 5fc4ec55 (3655), 6682dfb1 (3656), f1c2a0a5 (3657).
The four PRD files were found under `prds-archived/`.
Read-only scan: `scanMdNetwork` run on the job worktree (HEAD) and on `$SM_PROJECT_ROOT`. Both gave identical output.
`/code-review` and `/security-review` were not run; I self-reviewed the diff instead (see Findings).

## md-skill-wording-leftovers — VERIFIED
- `grep -rn 'KEEP-OWNER\|Owner doc'` over the skill folder returns nothing.
- `drift-check.md:156` header is `Topic doc`; `drift-check.md:158` and `plan.md:38` use `KEEP-TOPIC`.
- `placement.md:12` reads "Personas (subagent definitions), skills, plugin packs (a plugin plus its always-on rules), commands."
- `placement.md:35` reads "Maintainer of a doc | One named maintainer per doc, reviewed every 3-6 months".
- The diff touches only the three listed files (8 lines changed).
- Gate: `vitest dev-plugin-skillset + md-network-drift-check` gave 2 files / 34 tests passed.

## md-census-bare-tokens — REFUTED (scan criterion fails)
- `mdDocRefs.cjs:104-110` implements the rule as specified. A token with no '/' and no extension resolves only by an exact top-level match, and is otherwise ignored.
- Tokens with '/' or an extension keep the old suffix path. The tests cover `tasks`, `scripts` and `lib/epicIntake.ts`.
- Gate: `vitest mdDocRefs + mdNetworkScan + mdDocCensus` gave 3 files / 58 tests passed. `npm run typecheck` gave rc=0.
- **Scan check fails.** `scanMdNetwork` on `$SM_PROJECT_ROOT`: `census.docs['CLAUDE.md'].ambiguousRefs = ["tasks"]`. `domain-model.md` also lists `tasks`.
- Cause: the token in `CLAUDE.md:46` is `` `tasks/` `` (trailing slash). The new rule only handles tokens with no '/', so the folder-style token still takes the suffix path and matches several `tasks` folders.
- `mdDocRefs.test.cjs:188-190` asserts that `tasks/` is ambiguous, so the test pins the behaviour the goal wanted gone.

## page-stewards-boundaries-once-a — VERIFIED
- `page-stewards.md:123-129` has the new `## Boundaries` section with the three shared rules.
- `page-app-settings.md` and `page-claude-config.md` each keep a `## Boundaries` heading with a one-line pointer to `page-stewards.md#boundaries`. claude-config adds one page-specific line (the Project-face `memory` key).
- Gate: `node scripts/check-page-stewards.cjs` printed "clean". `npm run lint:docs` printed "doc-hierarchy: ok".
- Not checked line by line: whether Your page and Page invariants are unchanged. The diff stat for these files is small (4-5 lines), consistent with Boundaries-only edits.

## page-stewards-boundaries-once-b — REFUTED (scan criterion fails)
- `page-history.md`, `page-overview.md` and `page-projects.md` each have a `## Boundaries` pointer line to `page-stewards.md#boundaries`, plus page-specific lines for projects.
- Gate: `check-page-stewards` clean, `lint:docs` ok.
- **Scan check fails.** The `duplicates` list still has all 10 page-steward pairs, with 73-82 shared runs each. The highest are history/overview at 82, app-settings/history at 80 and history/projects at 80. The criterion needs every pair at 40 or fewer.
- Samples of the remaining shared text: the frontmatter description ("page against the six page principles stateless physical files…"), the "read page-stewards.md first on every run" intro, and the "never trust a file list copied into this persona" lines. The Boundaries block was not the only source of the duplication.

## Findings
### Important
- `src/main/lib/mdDocRefs.cjs:104`: the bare-token rule skips `` `tasks/` `` because it contains '/'. `CLAUDE.md` still has `ambiguousRefs: ["tasks"]`. Fix either by also treating a trailing-slash single-segment token as a bare name, or by changing `CLAUDE.md:46` to avoid the folder token. Then change the test at `mdDocRefs.test.cjs:188-190`.
- `.claude/agents/page-*.md`: shared runs per pair are 73-82, not 40 or fewer. The shared description, "read first" intro and steward-boilerplate lines still need to move into `page-stewards.md`. Check whether the frontmatter descriptions can be shortened.
### Minor
- None. No secrets, path traversal or unsafe input in the diff; the new code only does string checks and `exists()` on a repo-relative path.
