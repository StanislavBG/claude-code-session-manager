# Validation: epic-usage-last-context, epic-header-context-readout

Base: 096c36ec7605caa31642cf70f81544f8f0c36324. Commits: 04941c78 (usage), 280cbf63 (header); ecaaef81 landed the once-per-call counting they build on. `/code-review` and `/security-review` were not run as separate commands; I self-reviewed the diff (no file or shell input, no secrets, no path handling added).

## epic-usage-last-context — VERIFIED
- usageForOne returns lastContext (input + cache_read + cache_creation of newest call, null if none) and calls: src/main/transcripts.cjs ~561-612 (`ctx`, `calls`, `lastContext`, `usage = {inputTokens, outputTokens, lastContext, calls}`).
- Tail reads: calls, lastContext, recentIds and newestId are kept in the cache entry (transcripts.cjs ~525-529, 605-612). A late line of an older id cannot move lastContext (`if (id === newestId)`).
- Type: src/preload/api.d.ts:2342 declares `lastContext: number | null; calls: number`.
- Tests: transcriptsUsageFor.test.cjs:263 (one call), :270 (several), :285 (split message), :318 (no usage).
- Gate: `vitest run transcriptsUsageFor.test.cjs` → 17 passed; `npm run typecheck` → exit 0.

## epic-header-context-readout — VERIFIED
- EpicUsage carries optional lastContext, calls: src/renderer/state/epicUsage.ts:6.
- epicDerive.ts exports EPIC_CONTEXT_WARN_TOKENS = 200_000; epicStats returns context (compact, e.g. "412K", else null) and contextLarge (>=): epicDerive.ts ~211-233.
- EpicDetail.tsx ~1019-1031: span data-testid epic-detail-context after the branch text, only when stats.context is set; text `context <value>`.
- Large: AMBER_TEXT (already used in the file, line 17/333); title says every turn re-reads this much and new work is cheaper in a fresh session.
- Tests: epicDerive.test.ts:372-394 (value, null, both sides of the limit); EpicDetail.test.tsx:487 (absent without usage, present with it, toned when large).
- Gate: vitest epicDerive + EpicDetail → 93 passed; `npm run lint` → exit 0; `npm run typecheck` → exit 0.
- Visual check: the header cannot be checked by launching the app here; a visual check by the owner is still due.

## Findings
- Critical: none
- Important: none
- Minor: none
