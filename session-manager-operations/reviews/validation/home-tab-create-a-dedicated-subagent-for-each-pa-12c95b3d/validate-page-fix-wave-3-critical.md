# Validation: page fix wave 3 (critical)

Base: `1253df1d` (full `1253df1dea505dad7c44edde4ea284da60d813b2`). Commits: 35b6f615 (permissions), 70b59c4e (hooks), 960150ac (config stale guard).
Gates were run with the main checkout's `node_modules` symlinked into the worktree (worktree has none; symlink removed afterwards), scratch `TMPDIR`, nothing touched `~/.claude/settings.json`.
Gate result: `vitest run configSaveConflict + Permissions.scenario + Hooks.scenario` = 3 files / 12 tests passed (a superset of each PRD's own gate); `npm run typecheck` rc=0.

## ps3-permissions-no-clobber-bad-json — VERIFIED
- Invalid draft refuses writes: `Permissions.tsx` `overrideInto` returns after `toast.error(INVALID_JSON_MSG)` when `parsePerms` errs (diff hunk @ ~127); `updatePerms` same guard (~152). No `setDraft` before the guard. `catch { current = {} }` removed.
- Inline error state, inputs disabled: `role="alert"` banner (~237); `RuleList` and `AdditionalDirs` take `disabled={!!err}` on inputs and add button.
- Non-object draft treated as invalid: `parsePerms` rejects null/array/non-object (`Permissions.tsx` ~36).
- Valid draft preserves other keys: `{ ...current, permissions: nextPerms }`; test "valid draft keeps hooks, env and model after adding an allow rule" passes.
- Tests: `Permissions.scenario.test.tsx` has the three required scenarios (invalid JSON, array, valid with hooks/env/model); passed.

## ps3-hooks-no-clobber-bad-json — VERIFIED
- `Hooks.tsx` `overrideInto` uses `parseFull`, toasts and returns on error (~242); `updateHooks` guarded (~291). `parseFull` rejects non-objects (~141).
- Inline error banner (`role="alert"`, ~367); `jsonInvalid` disables matcher, type, value, timeout, args, terminal inputs and the add/remove buttons; `+ add group` disabled.
- Valid draft preserves other keys (`{ ...current, hooks: nextHooks }`); test "valid draft keeps permissions, env and model after adding a hook group" passes.
- Tests: `Hooks.scenario.test.tsx` has the two required scenarios; passed.

## ps3-config-save-stale-guard — VERIFIED (with one Important finding)
- `baseMtimeMs` on `FileState`, set in `applyJsonRead`/`applyTextRead` only when the draft is replaced (`config.ts` ~83, ~104), so a kept dirty draft keeps its old base.
- `saveJson`/`saveText` re-read the file and return `{ ok:false, error:'conflict' }` when `disk.exists && disk.mtimeMs > baseMtimeMs`; the draft is untouched; a missing file saves normally.
- Toast names the path and says it changed on disk (`conflictMessage`).
- After a successful save the file is re-read through `applyJsonRead/TextRead(..., false)`, which updates `baseMtimeMs`; test "two saves in a row never conflict" passes.
- `force` option exists (`SaveOptions`) and is covered by the test "force overwrites despite the conflict".
- Tests: `configSaveConflict.test.ts` covers refusal, force, back-to-back saves, a new file, and saveText.
- Gap: see Important finding 1.

## Cross-check
- `grep -n 'catch { current = {} }'` on Hooks.tsx and Permissions.tsx: clean (exit 0 path, no match).
- Remaining catches: Permissions.tsx:45 (`parsePerms`, now returns an `err` that every write path checks); Hooks.tsx:150 (`parseFull`, same); Hooks.tsx:702 (regex fallback in `evaluateMatcher`, no write); Hooks.tsx:726/734 (test-fire payload parsing, not written to settings). None falls back to an empty object that is later written.

## Findings

### Critical
- none

### Important
1. `src/renderer/state/config.ts:162` / `:187` plus the callers (`Settings.tsx:208`, `Permissions.tsx:214`, `Hooks.tsx:349`, `McpServers.tsx:299`, `Library.tsx:662`, `Skills.tsx:340`, `SystemPrompt.tsx:121`): the `force` overwrite path has no caller. The conflict toast says "save again to overwrite", but a second Save passes no `force`, `baseMtimeMs` is unchanged, and it is refused again. The user can only escape by reloading, which drops the draft. The AC ("a deliberate overwrite path exists and is used only by an explicit user action") is met only on the store side. Follow-up: add an explicit "Overwrite" action wired to `saveJson/saveText(path, { force: true })`, or change the toast copy.

### Minor
1. `src/renderer/components/tabs/Permissions.tsx` (~245): the default-mode selector is not disabled while the draft is invalid. It is still safe (`updatePerms` refuses with a toast), but it is inconsistent with the other disabled inputs.
2. `config.ts` conflict check is read-then-write, so there is a small TOCTOU window. It costs one extra `readJson/readText` per save. Both are acceptable for a single-user app.
3. The scenario tests assert disabled inputs and `setDraft` absence, but do not assert the save path is unreachable for an invalid draft. `saveJson` already rejects invalid JSON itself, so this is covered in practice.

Security review (self): no new input reaches a shell or a path; paths come from existing scope maps. No secrets. No duplication of an existing helper found.
