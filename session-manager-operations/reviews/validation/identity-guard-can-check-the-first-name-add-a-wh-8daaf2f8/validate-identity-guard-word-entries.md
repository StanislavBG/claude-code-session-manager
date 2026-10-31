# Validation: identity-guard-word-entries (PRD 2428)

Base: 6c7dc0af. Landed commit: 6a505fca (3 files: `scripts/identity-guard.sh`, `scripts/__tests__/identity-guard.test.cjs`, `identity-boundary.md`). PRD read from `prds-archived/2428-identity-guard-word-entries.md`.

## identity-guard-word-entries — VERIFIED

Gate re-run (the PRD's own gate, foreground, SM_* unset):
- `npx vitest run scripts/__tests__/identity-guard.test.cjs` → 21 passed (12 existing + 9 new).
- `npm run lint:docs` → exit 0 (21 junctions, 35 files).
- `npm run hooks:install` → exit 0, installed in the main checkout's shared hooks dir.
- `npm run identity:scan` → exit 0, "(3 entries checked)".

Criteria:
1. whole-word `match()` — `scripts/identity-guard.sh:53-86`: `found()` loops past in-word occurrences, uses explicit `at == 1` check and `[a-z0-9_]`; applied to every awk-based mode (pre-commit, commit-msg, pre-push). Tests a–d pass.
2. Tree mode — `identity-guard.sh:170-178`: `args=(-w -F -e "${p#word:}")`, `-c -i`, binary files still scanned, `${rev[@]+"${rev[@]}"}` kept, no path exclusion. Test e passes.
3. Loading — `identity-guard.sh:40-41`: lowercase first, then drops blank, comment and empty `word:` lines (so prefix is case-insensitive, empty entry uncounted). Plain entries stay substrings (test g). `identity-guard:` output prefixes unchanged in the diff.
4. Tests — `identity-guard.test.cjs` has `describe('word: entries')` with 9 tests (a–i); the 12 original tests are unmodified in the diff (additions only) and pass. Synthetic strings only.
5. Docs — header comment `identity-guard.sh:7-12` and `identity-boundary.md` guard paragraph and Limits bullet use the PRD wording. No tracked text names which identifier is a `word:` entry.
6. Live probe (step 8): `hook-copy-current` (cmp identical), `whole-word-exit=1`, `longer-word-exit=0`; `identity:scan` exit 0 with the local deny-list's 3 entries all checked.

## Wording-rule check
I checked the commit message and the plan diff against every local deny-list value (message grep, whole-word diff grep) without printing any. No breach found. The commit message is a bare subject plus trailer.

## Combined diff review
Self-review of the guard: values are passed as awk data, never code; tree mode passes them via `-F -e`, so no pattern or shell injection. `word:` stripping uses `${p#word:}` on already lowercased text. No secrets. No duplicated helper. The base..HEAD range also carries unrelated commits from other plans; only the three PRD files were examined for this PRD.

## Findings
- Critical: none.
- Important: none.
- Minor: none.
