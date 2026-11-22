# Validation: feedback-inbox-image-fetch-narrow

Base: a449a739; PRD commit 869f9ce1 (2 files, matches `# Files`). Self-review used (no separate review tooling run); no secrets, path or input-handling issues in the diff (file paths still built from `item.id` after the existing safe-id filter; `decodeImage` unchanged).

## feedback-inbox-image-fetch-narrow — VERIFIED

- AC1: customerFeedbackInbox.cjs `fetchImagePage` builds `since` + `limit` only (no `images` param), bearer header, `AbortSignal.timeout(TIMEOUT_MS)`; `cacheImages` calls it with limit 1 first, `since = sinceBefore(item.receivedAt)`.
- AC2: `if (!has(page, item.id)) page = fetchImagePage(..., MAX_IMAGE_FETCHES)` — one retry only; null page (non-200/bad JSON) → `continue`; network error → existing catch; paths stay null (test "both image GETs miss", test.cjs:250).
- AC3: loop over every wire entry in the page whose id is in `byId`, not in `done`, with an images array → `writeItemImages`, `done.add`; `if (done.has(item.id)) continue` skips later GETs (test.cjs:238 asserts one image GET for two items).
- AC4: 20-item cap, `decodeImage`, naming/0o600 (`writeItemImages` body unchanged), catch drops errors, result shape and `pruneImages` untouched in diff.
- AC5: test.cjs:188 expects limit '1'; new tests at :221 (retry with 20), :238 (two items one GET), :250 (double miss). All pass.
- Gate: vitest 3 files / 37 tests passed; `npm run typecheck` exit 0.

## Findings

- Critical: none. Important: none.
- Minor: customerFeedbackInbox.cjs (cacheImages loop) — if the limit=1 response contains the item id but with a non-array `images`, `has()` is true so no limit=20 retry happens; the item stays null and retries next pull. Harmless (host always returns arrays for items with images).
