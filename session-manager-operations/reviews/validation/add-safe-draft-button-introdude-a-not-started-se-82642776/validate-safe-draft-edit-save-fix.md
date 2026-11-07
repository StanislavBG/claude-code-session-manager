# Validation: safe-draft edit-save fix

Base 99240b3d; HEAD includes 6983c45a (the only commit touching the PRD's files). PRD file: prds-archived/2791-edit-draft-save-keeps-card-and-autosave.md.

## edit-draft-save-keeps-card-and-autosave — VERIFIED

- Edit mode never resets after save: `NewEpicCard.tsx` handleSaveDraft edit branch (~l.428-444) returns before `resetForm()`. The reset at the end of the function is reached only in new mode.
- `handledRef.current=false` and `lastSavedSigRef.current=savedSig` are set after a successful save. `savedSig` is captured at save start (`const savedSig = sig`).
- Typing during the await: the debounce is re-armed when `snapRef.current.sig !== savedSig`, and the unmount flush covers the rest. The in-flight test passes.
- Duplicate references: no attachment handling changed. The "two saves with one attachment" test asserts the path appears exactly once in every write.
- New mode unchanged: `createPromptSession` branch plus `resetForm()` plus `onDraftSaved`. The test "new-mode Save still resets and mints once" passes.
- Fail on Base / pass on HEAD: the HEAD test file was run against a detached worktree at 99240b3d. 5 failed (keeps every field, edit after Save autosaves exactly once, unmount flush, in-flight edit, two saves one Reference) and 64 passed. The new-mode test passed on both, as the PRD author said. On HEAD: 69/69 pass.
- Gate: `vitest NewEpicCard.test.tsx` 69 passed; `npm run typecheck` exit 0; `npm run lint` exit 0 (e2e budget 18/19).
- Diff checks: `markHandled` (l.191-194) still clears the debounce, so no write follows Start. The edit-branch timer is stored in `debounceRef`, so markHandled cancels it. No new Epic status, flag or persisted field; the diff touches only the two PRD files.

## Full suite

`npm run test:unit`: 935 files passed; 8677 passed, 1 skipped, 0 failures.

## Findings

Critical: none.
Important: none.
Minor:
- `NewEpicCard.tsx` ~l.434-441 duplicates the debounce-arming timer logic already used by the sig effect (~l.507-571). A shared `armDebounce` helper would remove the duplication.
- In the edit branch `toast.success('Draft saved')` and `onDraftSaved` are duplicated ahead of the early return, so the tail of the function is now split across two paths. This is cosmetic.
