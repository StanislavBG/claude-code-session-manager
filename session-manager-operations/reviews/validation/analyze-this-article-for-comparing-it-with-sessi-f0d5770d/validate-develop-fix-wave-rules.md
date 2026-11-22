# Validation: develop-fix-wave-rules (PRD 3337)

Base: 1421acb0871e7f492b49adaf914fd454ff85f7a2. Landed commit: f5ef0830 (touches only SKILL.md). Gate `none` for this validate PRD; the PRD 3337 gate was re-run.

## develop-fix-wave-rules — VERIFIED

- AC1 (fix-wave validate PRD: one criterion per fix PRD and per earlier-REFUTED PRD, cited by slug, one-sentence Why): holds. SKILL.md Phase 2 rule 2, "The new validate PRD has one criterion per fix PRD and one per PRD the earlier validator marked `REFUTED`, each cited by slug. Why: a refuted PRD keeps its Epic blocked until a validator verifies that same PRD."
- AC2 (REFUTED again on same criterion gets no third wave; listed open with validator reason and what was tried; one-sentence Why): holds. Same rule, "gets no third fix wave: list it as open in the final report with the validator's reason and what was tried, for the human to decide. Why: a second miss on the same criterion means the plan is wrong, and another wave would repeat it."
- AC3 (Done rule consistent, no new section, <20,000 bytes): holds. Rule 4 now reads "including each PRD an earlier validator refuted ... after its second refutation an open entry in the final report". `git diff` shows no added headings. `wc -c` = 19048.
- AC4 (standards.md unchanged): holds. `git diff <base>..HEAD --stat -- .../standards.md` is empty.
- AC5 (version handling): holds, with a caveat. Of the three commits before f5ef0830 that edited SKILL.md, only e7e1877a bumped plugin.json and marketplace.json; 0c9219e5 and 8754a1d2 did not. The mixed history reads as "no bump", and neither manifest changed. See Minor.
- Gate: `timeout 120 npm run lint:docs` exit 0 (doc-hierarchy ok, 21 junctions, 35 files); `timeout 120 npm run lint:readme` exit 0.

## Review of combined diff

The plan's own change is one 12+/5- docs edit in SKILL.md. The base..HEAD diff is much larger (77 files); that is other work in the repo, not this PRD. Self-review of the SKILL.md hunk: no session-manager-internal paths, no secrets, no unsafe input. `/code-review` and `/security-review` were not run (docs-only change; self-reviewed).

## Findings

- Critical: none.
- Important: none.
- Minor: the version-handling criterion is ambiguous because the three prior commits are mixed (1 bumped, 2 did not). No bump was applied. If the owner wants the skill change shipped to plugin users, bump plugin.json and marketplace.json together in a separate change.
