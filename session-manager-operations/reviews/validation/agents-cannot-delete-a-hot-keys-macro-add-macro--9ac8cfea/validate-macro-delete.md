# Validation: macro delete plan (PRDs 2449–2451)

Base d6bbe9f6; commits 9346aa6c (2449), 807ce41d (2450), ca4b2130 (2451).

## macro-remove-from-project — REFUTED (gate flaky-red)
- `removeMacroFromProject` + `MacroRemoveFromProjectSchema` exported: macroLibrary.cjs:193, 622-653, 664, 674.
- Last project → deleted:true with stored copy; otherwise drops normalized cwd, new `updatedAt` (macroLibrary.cjs:645-652). Refusals (not found / builtin / `*` / not visible incl. `[]`) return exact messages with no write (:633-643).
- Runs inside `serialize` (:631), same as saveMacro; `deleteMacro`/`setMacroProject` untouched (diff only adds).
- Tests present in macroLibrary.test.cjs (:603+).
- Gate: `npx vitest run …/macroLibrary.test.cjs` FAILED in 3 of 4 reruns: `removeMacroFromProject drops only cwd when others remain` (test.cjs:622) `expect(r.macro.updatedAt).not.toBe(m.updatedAt)` — save and remove land in the same millisecond. Code is correct; the test is timing-dependent.

## macro-delete-admin-route — VERIFIED
- Route registered after save: macroAdminRoutes.cjs `registerAdminRoute`; route-list test updated; header comment describes all three routes.
- deleteHandler: 200 `{ok,deleted,macro}` from the library result; every refusal → 400 before audit/onChanged; missing id → `id is required`; bad id → zod message; null/invalid JSON → `invalid JSON body` via shared `readJsonBody`; relative cwd rejected by `resolveCwd`.
- One `admin_macro_delete` audit event with route/cwd/deleted/macro/originClaudeSessionId (null unless string of 1–128).
- saveHandler uses `readJsonBody` (same 400 messages). SessionActionsBar.test.tsx:155 adds the `macros:changed` removal test.
- Gate (vitest on route + SessionActionsBar tests, lint, typecheck): all pass.

## macro-delete-mcp-tool — VERIFIED
- `macro_delete` in TOOLS (id only, required), header comment, catalog entry after `macro_save` with pointers; domain-model.md sentence added.
- Handler sends exactly `{cwd: resolveCwd(), id, originClaudeSessionId}`; `args.cwd` ignored. `macroDeleteRefusal` refuses when SM_SCHEDULER_JOB_SLUG set (even with MAY_QUEUE) or no SM_CHAT_SESSION_ID; bad id → isError, no request. `{ok:false}` → isError with its error; success → JSON text.
- Gate (3 vitest files, lint): pass.

## End-to-end trace
- Tool body fields (cwd, id, originClaudeSessionId) = fields deleteHandler reads.
- Built-in, `*` macro, other project's macro: refused in library (clear message) → route 400 → tool isError with that text.
- Success: route calls `onChanged` once; index.cjs:92 passes `() => broadcastMacrosChanged()` (def :604).
- SessionActionsBar test: library emptied, `changed()` fired, strip has 0 macros.

## Full suite
`npm run test:unit` (SM_* unset): 837 files passed, 7981 passed, 1 skipped. lint and typecheck exit 0. (Note: the flaky test passed in this run.)

## Findings
- **Important** — src/main/lib/persona-macro/__tests__/macroLibrary.test.cjs:622: same-millisecond `updatedAt` makes the test fail ~75% of isolated reruns. Fix: set fake timers / advance the clock between save and remove, or backdate the stored `updatedAt`. Production code needs no change (could also guarantee strict increase).
- Minor — audit event is also written for `deleted:false` removals (intended per PRD).
