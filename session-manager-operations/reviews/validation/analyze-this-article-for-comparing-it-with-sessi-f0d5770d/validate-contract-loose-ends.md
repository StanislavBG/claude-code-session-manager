# Validation: contract loose ends

Base: 096c36ec7605caa31642cf70f81544f8f0c36324. Commits: 4ab8be70 (3415), 0f4fa534 (3416), e5dadc12 (3417), 4e1752f3 (3418).
Gates re-run (all exit 0): vitest on the 9 listed files (175 passed), `npm run lint:docs`, `npm run typecheck`.
Review: self-review of the four commits (no unsafe input, secrets, paths; no duplicated helper).

## needs-you-post-reports-change-and-updates-ref — VERIFIED
- Store returns `{item, created, changed}` inside the queue: needsYouStore.cjs postNeedsYou (callerKey compare before/after the write).
- externalRef replaced on re-post (`data.externalRef ?? null`), absent clears it.
- Route drops the before-snapshot read, audits and calls onChanged only on `changed`, answer carries `changed` (needsYouAdminRoutes.cjs).
- external-contract.md Needs you section updated (replaces externalRef, lists `changed`).
- Tests present in both files: identical re-post → changed false/no row; new externalRef stored; two simultaneous posts.

## agents-resolved-alias-and-launcher-rule — VERIFIED
- agentAdminRoutes.cjs adds `modelAlias: info?.modelAlias ?? null` to resolved.
- external-contract.md: path `string or null`, modelAlias row, ordered launcher rule (modelId, modelAlias, else do not start).
- externalContract.cjs unchanged; the commit states it does not pin resolved's inner keys. The shape test was edited and passes.
- Tests: own model, inherit, failed resolution (resolved null), plus missing-alias → null.

## reply-mode-always-echoed — VERIFIED
- crossProjectFeedback.cjs: `replyMode: v.replyMode` always in the success result; the existing-Epic result is untouched.
- external-contract.md Replies row says always present.
- Tests assert 'prompt' when sent and when absent.

## epic-read-no-project-scan-for-open-epics — VERIFIED
- epicOutsideRead.cjs: getEpicRecord only checks cwd is absolute; listOpenEpicRecords no longer takes projectRoots; archivedEntry checks isRegistered first.
- Test: projectRoots call counter is 0 for open by id, by externalRef and for the list; ≥1 for a completed Epic; unregistered archive lookup returns null.

## Findings
- Critical: none
- Important: none
- Minor: none
