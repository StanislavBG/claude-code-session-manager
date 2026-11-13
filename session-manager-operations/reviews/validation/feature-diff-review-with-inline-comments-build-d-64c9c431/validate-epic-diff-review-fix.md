# Validation: epic-changes-flat-archived-prds

Base: b46dceea580b397b12ec3b80e17f644c0274ed4c. Commit under test: d30e97c6 (fix(epic-changes)); later agent-cli commits are on HEAD but are not part of this plan.

## epic-changes-flat-archived-prds — VERIFIED

- AC1 lister reads roots + subfolders, prds/ first, never throws: `git show d30e97c6` epicChanges.cjs `dirs = [...liveDirs, ...archivedRoots.flatMap((root) => [root, ...subdirsOf(root)])]`; try/catch blocks retained. Order test in epicChanges.test.cjs (prds/ beats flat beats nested) passes.
- AC2 JSDoc names flat `prds-archived/<NN>-<slug>.md` and nested `prds-archived/<ISO>/<NN>-<slug>.md`: present in the diff.
- AC3/AC4 epicChangesRealLayout.test.cjs: real temp git repo, flat x2 + nested x1, production-shaped history.jsonl; only loadEpic/validatePath injected; asserts 3 'prd' sections in PRD-number order with right files.
- AC5 existing epicChanges / epicChangesIpc tests green.
- Gate: 3 test files, 18 tests passed; `npm run typecheck` exit 0.

## Real-path probe (read-only, script in TMPDIR, outside repo)

```
a-lot-of-macros-show-max-effort-warrnings-this-i-270e9e9b ok: true sections: 8 prd: 8 2955,2956,2957,2958,2959,2960,2961,2962
feature-diff-review-with-inline-comments-build-d-64c9c431 ok: true sections: 16 prd: 15 2973,2974,2975,2976,2977,2978,2979,2980,2981,2982,2983,2984,2985,2988,3025
```
Both meet the thresholds (8 exact; 15 >= 14).

## Full unit suite (all SM_* unset): NOT GREEN

`npx vitest run --reporter=dot`: 1032 files passed, 1 failed; 10060 tests passed, 1 failed.
Red: `scripts/__tests__/check-ops-path-literals.test.cjs` "the real repo tree is clean" — flags
`src/main/lib/agent-cli/agentCliSessionStore.cjs:23` (`path.join(os.homedir(), '.claude', 'session-manager', 'agent-cli')`).
Re-run alone: still fails. At Base: that file does not exist (`git cat-file` fails), so Base is not red. It does not qualify for excuse. Cause is commit 5cc6716d (multi-agent-cli plan), not this PRD; the fix PRD touched no such path. Neither named known flake appeared.

## Findings

- Critical: none.
- Important: `src/main/lib/agent-cli/agentCliSessionStore.cjs:23` trips the ops-path-literal lint test (regression from 5cc6716d, unrelated to the Changes fix). The agent-cli plan's validation must resolve it (use `opsPath()` or an allowed-root helper, or extend the scanner allowlist if the path is legitimately outside ops).
- Minor: probe shows the second Epic has 16 sections (15 prd + 1 non-prd), fine; 2986/2987 slugs are not sections (likely not landed/other Epic) — not investigated.
