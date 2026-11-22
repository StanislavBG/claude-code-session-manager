# Validation: docs written once (plan pl-mws8lkgy-514cac)

Base: 81fda522a3ec4797d76fa6a2c9c43382e2dfe0e1 (known). Plan commits on HEAD: c02a86a2, 115e2723, d7ee6237, ef5b27d4, 9d4bc97d, baef75b8. PRD files found in `prds-archived/` (3546-3550, plus fix PRD 3547-fix).
Gates re-run: `npm run lint:docs` -> ok (25 junctions, 41 files); `vitest dev-plugin-skillset + md-network-drift-check` -> 34/34 pass; `git ls-files --error-unmatch` on the 3 READMEs -> tracked.
Reviews: `/code-review` and `/security-review` not run; self-reviewed. The diff is docs only plus `.gitignore`: no secrets, no input handling, no paths built from input.

## docs-single-writer-law-once — VERIFIED
- `session-manager-operations/CLAUDE.md:8`: the four law sentences are gone; the file keeps "14 namespaces", the Owned / Not-owned lists and one link to `domain-model.md#single-writer-law` plus `opsOwnership.cjs`.
- Its "What must NOT be assumed" now has one link bullet replacing the two restating bullets (git diff).
- Feedback table row: "retired 2026-08-02 ... | none" (git diff).
- `src/main/lib/CLAUDE.md`: the `path.join` line is dropped; the reuse-table row for opsPath stays (line 44).
- `domain-model.md:343` section holds the law. The `opsPath()` / `path.join` fact was moved in at lines 350-351, so no fact was lost.
- `wc -c session-manager-operations/CLAUDE.md` = 3768 (< 4000). lint:docs ok.

## docs-track-namespace-readmes — VERIFIED
- `.gitignore` uses `<ns>/*` + `!<ns>/README.md` pairs for logs, ui-prefs and memory-clusters, matching the tasks pattern. `feedback/` stays fully ignored.
- `cmp` of each README against the main checkout copy: identical (3/3).
- `git check-ignore -v` on the 3 READMEs: not ignored. `git check-ignore -q session-manager-operations/ui-prefs/prefs.json`: still ignored.
- Main checkout `git status --short` for the three namespaces: empty (no conflict or modification). Main HEAD is baef75b8, which carries the READMEs.

## docs-md-network-doc-kinds — VERIFIED
- `placement.md:5` "## Doc kinds" sits before "Where each kind belongs"; exactly five kinds (Map, Folder notes, Topic docs, Agent files, History) with the specified meanings. Rules at lines 15-20 cover all four required points.
- `owner doc` / `one-owner` no longer appear in plan.md or SKILL.md ("topic doc", "one-home table"). `audit.md` and `drift-check.md` use "history" for machine-written records. The review-record file name and the JSON keys are unchanged (`drift-check.cjs` was edited by a different plan's PRDs).
- Plain-language check: sentences are short and jargon-free. "Personas" and "plugin packs" in Agent files are not defined, but the owner uses both terms daily (Minor 2).

## docs-root-map-index — VERIFIED
- The `| Doc | Covers |` table is gone. The intro ends with `[architecture index](session-manager-operations/architecture/README.md)` (`CLAUDE.md:7`).
- One new law line at the end of Conventions: "Every doc follows the five doc kinds ... [kinds](...placement.md#doc-kinds)".
- Architecture README class line: "LAW-RATIONALE (the why behind a root `CLAUDE.md` law)".
- All 10 removed docs are in the index: README.md was already the index, and lint:docs reachability is green with the table removed.
- `wc -c CLAUDE.md`: Base 11998 -> now 10925 (smaller, under 12,000).

## docs-develop-skill-points-to-prd-authoring — VERIFIED
- `develop/SKILL.md`: cwd row is "The Epic's project root; see PRD_AUTHORING.md §5." The fence/heading paragraph is replaced by the "§6, What the API writes" pointer. Rule 2 points to §14 No human-only gates. Phase 2 rule 1 points to §13.
- `PRD_AUTHORING.md` is unchanged and still holds each moved fact: §5 line 71 (cwd), §6 line 116 (fence rule), §13 line 208 (self-heal conditions), §14 line 237 (human-only gates).
- dev-plugin-skillset test passes.

## Findings
### Critical
- none
### Important
- none
### Minor
1. `plugins/session-manager-dev/skills/maintaining-md-network/drift-check.md:156` The Verdicts table header still says "Owner doc". The AC scoped drift-check.md to "history", so this is not a refutation. It is a leftover of the retired term, though, and the column also uses KEEP-OWNER verdict names. It should become "Topic doc" or get an explicit exemption.
2. `placement.md:8-12` "personas" and "plugin packs" in Agent files are not defined in the section. They are fine for this owner and low risk.
3. `placement.md` last row of the "Where each kind belongs" table ("Ownership of a doc | One named owner per doc") sits next to the new rule "kinds never say who owns a doc". The two are compatible (maintainer owner vs kind), but a reader can trip on it. Consider rewording to "maintainer".
4. Review scope: the base..HEAD range also contains other plans' commits (md-scan, config screens, tasks); only the six docs commits above were reviewed.
