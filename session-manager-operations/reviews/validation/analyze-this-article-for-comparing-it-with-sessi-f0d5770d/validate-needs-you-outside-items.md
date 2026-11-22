# Validation: Needs you — outside items

Base: aa3cc78785339bb570b46656e634486da93fc2c3 (HEAD commits listed by `git log aa3cc78..HEAD`: 4f9fe6b8, a530b6a7, aa031433, fc8200ce, ab689661, ab20da51, 440690ae, 2449c92d).
Gates re-run in the foreground: one vitest run over all 12 test files of the eight PRDs (12 files, 180 tests, all passed), `npm run typecheck` (exit 0), `npm run lint` (exit 0), `npm run lint:docs` (ok, 36 files).
The code-review and security-review commands were not run as separate tools here; I self-reviewed the diff (see Security reads).

## needs-you-store — VERIFIED
- `needsYouPath()` at schedulerPaths.cjs:113, exported :208, guarded by assertNotLiveRoot; lib-layout.json:28 `needsYouStore: feedback-remote`.
- Exports listNeedsYou/postNeedsYou/withdrawNeedsYou/answerNeedsYou/NeedsYouPostSchema (needsYouStore.cjs:261-270); file `{version:1, items}` with all 12 item fields (:200-213, :147-149); writeJsonAtomic + `serialize` queue (:82-88).
- Input rules at :27-59 (app regex 1-40, id/externalRef via normalizeExternalRef, title 1-200 one line, why ≤1000, link http(s) ≤2000, options 2-5 distinct 1-80).
- Post create/update/closed-unchanged :175-217; limits 10/app, 50 total with code NEEDS_YOU_LIMIT :193-198.
- Answer/withdraw return null per rules :221-259; 14-day prune :139-145.
- Test file covers these; passed.

## needs-you-admin-routes — VERIFIED
- Routes registered :141-143; index.cjs:105-113 registers with onChanged sending `needsYou:changed`; lib-layout.json:29.
- POST 200/400/429 :63-96; withdraw 200/404 :100-123; GET :125-136.
- Audit rows needs_you_posted / needs_you_withdrawn and one onChanged only when changed (:85-95, :119-120).
- Tests passed.

## needs-you-ipc-main — VERIFIED
- registerNeedsYouIpc needsYouIpc.cjs:169; both channels wrapped in validated() with s.needsYouList / s.needsYouAnswer (:174, :179); schemas ipcSchemas.cjs:816-821, exported :1763-1764; index.cjs:113; lib-layout.json:30.
- Answer success appends needs_you_answered with app, id, answer, externalRef when present, then onChanged (:187-192); null -> `{ok:false, error}` with no write (:181-186).
- Tests passed.

## needs-you-preload-api — VERIFIED
- preload/index.cjs:168-176 (list, answer, onChanged with unsubscribe); api.d.ts:389 NeedsYouItem and :2438-2442 methods; apiSurface.json:560-580 three rows (invoke, invoke, on), remote `deny`. apiSurface test passed.

## needs-you-row-model — VERIFIED
- NeedsYouKind 'outside-item' and optional app/itemId/link/options (homeNeedsYou.ts diff); fifth argument `outside` default `[]`; open items only, oldest first, appended last, id `outside:app:id`, label title, detail why, meta app, project '' .
- useOutsideNeedsYou.ts: lists on mount and on onChanged, answer calls window.api.needsYou.answer, component state only. Tests passed; lint passed.

## needs-you-dashboard-rows — VERIFIED (visual check still due)
- Home.tsx useNeedsYouRows passes the hook's items to buildNeedsYouRows (diff); outside-item row branch renders one button per option via answerOutside, error toast on failure, none when options absent; Open button calls `window.api.shell.open({as:'external', url})`.
- page-overview.md lists the needsYou.list read, the needsYou.answer write and the updated invariant.
- Component test Home.outsideNeedsYou.test.tsx passed.
- **The Dashboard rows cannot be checked by launching the app here; a visual check by the owner is still due.**

## needs-you-events-and-contract — VERIFIED
- externalContract.cjs:52-54 routes, :81-86 needsYouItemFields / needsYouAnsweredFields, :87 eventKinds incl. needs_you_answered; version stays 1, fingerprint replaced (:107). Shape and events tests passed.

## needs-you-doc — VERIFIED
- external-contract.md `## 6. Needs you` (line 450) sits before `## 7. Not part of the contract` (611); three routes table with examples, field table, rules (one decision, 2-5 options, no options for a notice, ≤10 per app), answer return via needs_you_answered / GET /admin/events?kinds=needs_you_answered and GET /admin/needs-you, withdraw of moot items, plain text + http/https only. lint:docs passed.

## Security reads (requested)
- Item text never rendered as HTML: Home.tsx renders `row.label`, `row.detail`, `row.meta` as JSX text (:523, :525, :532); grep for dangerouslySetInnerHTML/innerHTML in Home.tsx and homeNeedsYou.ts finds nothing.
- Link opens only via `window.api.shell.open({as:'external'})`; main refuses non-http(s) (index.cjs:1041-1048). The store also rejects links not starting with http(s):// at post time and on read (LinkSchema).
- Length bounds enforced at the POST route and store: title ≤200, why ≤1000, link ≤2000, option ≤80 chars and ≤5 options, app ≤40, id/externalRef ≤200 by normalizeExternalRef; 10/app and 50 total open. Stored items are re-parsed with the same bounds on read. The IPC answer schema is bounded (app 40, id 200, answer 80) and `.strict()`.

## Findings
### Critical
none
### Important
none
### Minor
- needsYouAdminRoutes.cjs:68-71: the "before" snapshot used to decide whether a post changed anything is read outside the store's write queue, so two concurrent posts of the same item could write an audit row for a change that the other post made (cosmetic audit noise only).
- needsYouStore.cjs:184-187: re-posting an open item without `why`/`link`/`options` clears them (documented in the doc), but `externalRef` is silently kept from the first post even if the re-post sends a different one; the doc does not say so.
