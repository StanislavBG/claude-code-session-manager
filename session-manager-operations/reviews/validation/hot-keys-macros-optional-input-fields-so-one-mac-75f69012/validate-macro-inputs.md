# Validation: macro-inputs plan (PRDs 1963–1969)

Base: 6302bc945acb10d999621387fb752fabe2206293. PRD files found under `prds-archived/` (all present).
Environment note: the job worktree had no `node_modules`; I symlinked the main checkout's (gitignored, not committed) to run gates.

Gate results (re-run in foreground): the 8 PRD test files → 8 files / 110 tests passed; `npm run typecheck` exit 0; `npm run lint` exit 0. Absence check `MacroS(ave)?Schema.(shape|extend|omit|pick|partial)` → clean.

## 1963 macro-inputs-schema — VERIFIED
- `MacroInputSchema`, `MACRO_INPUT_MAX_LEN`, `MACRO_PLACEHOLDER_RE` defined and exported: macroLibrary.cjs:63–75, 512–516.
- `refineInputs` applied via superRefine to MacroSchema and MacroSaveSchema (max 10); early-returns on absent/empty inputs; checks duplicates, default∉options, undeclared placeholder (message names it); fresh RegExp used: macroLibrary.cjs:77–95, 108–124.
- saveMacro create/update semantics (omitted keeps, `[]` deletes key, list replaces): macroLibrary.cjs:438–445, 459.
- `MacroInput`, `Macro.inputs`, `MacroSaveInput.inputs`: api.d.ts:262–300.
- Tests incl. legacy literal `{{x}}` still lists: macroLibrary.test.cjs:349–358.

## 1964 macro-inputs-mcp-tools — VERIFIED
- inputSchema `inputs` array (name/label/default/required/options), not required; description mentions `{{name}}`: scheduler-mcp-server.cjs:481–495.
- Handler forwards only when `Array.isArray(args.inputs)`: scheduler-mcp-server.cjs:792.
- Catalog notes + exampleArgs (`{{stream}}`, stream input): mcpToolCatalog.cjs:365–376.
- Two new tests in schedulerMcpServerMacros.test.cjs pass (gate run).

## 1965 macro-prompt-render — VERIFIED
- Exports `renderMacroPrompt`, `defaultMacroValues`, `macroPlaceholders`, `MACRO_INPUT_MAX_LEN=500`: macroPrompt.ts:7–60.
- No-inputs passthrough (line 38); sanitize CR/LF/tab→space, control chars removed, trim (line 30–32); error messages as specified (lines 44–53); single-pass replacer (line 56); 8000 cap (57–59).
- Tests cover stream example, required, 501 chars, newline, `{{other}}`/`$&`, options, passthrough (macroPrompt.test.ts:10–83).

## 1966 macro-inputs-admin-route — VERIFIED
- `inputs: body.inputs` passed into `MacroSaveSchema.parse`; parse failure → 400 before onChanged: macroAdminRoutes.cjs:72, 74–77.
- New tests (create+list, update keeps, undeclared → 400) pass (macroAdminRoutes.test.cjs, gate run).

## 1967 macro-launch-renders-inputs — VERIFIED
- `launch(macro, extra?, inputValues?)` renders before `setLaunching`, falls back to `defaultMacroValues`; failure toasts `Cannot start "<label>" — <error>` and returns: useMacroLaunch.ts:37, 64–68.
- Goal uses `rendered.prompt`, suffix unchanged: useMacroLaunch.ts:93.
- New tests pass (gate run).

## 1968 macro-editor-inputs — VERIFIED
- `macro-inputs` section, add button, rows with name/label/default/required/remove, init from `macro?.inputs`: MacroEditor.tsx:41, 205–260.
- Placeholder list with `macro-undeclared-placeholder`; Save disabled on undeclared/invalid/duplicate names: MacroEditor.tsx:75–85, 192–203.
- `inputs` sent only if `hadInputs || inputs.length>0`; `[]` when all removed from a macro that had inputs; empty label→name: MacroEditor.tsx:105–114.
- New tests pass (gate run).

## 1969 macro-inputs-press-form — VERIFIED
- MacroInputsForm: form testid, select for options else text input maxLength 500 with `macro-input-<name>`, prefilled defaults, autofocus first, required marked, Enter/Start submit, Esc/Cancel cancel, inline `renderMacroPrompt` error blocks submit: MacroInputsForm.tsx:21–105.
- SessionActionsBar: inputs → `setPending`, else `launch(m)`; submit → `launch(m, undefined, values)` and closes: SessionActionsBar.tsx:141, 178–189.
- New tests pass (gate run).

## End to end — VERIFIED
- stream example renders to `education-veggies` by default and to an override; no-inputs prompt returned byte-identical (even with literal `{{x}}`); empty required and 501-char values return `{ok:false,error}` which useMacroLaunch toasts and MacroInputsForm shows inline — all asserted in macroPrompt.test.ts / useMacroLaunch.test.tsx / SessionActionsBar.test.tsx (passing).
- Cross-PRD: renderer `PLACEHOLDER_RE` (macroPrompt.ts:9) and `MACRO_PLACEHOLDER_RE` (macroLibrary.cjs:64) are identical (`/\{\{\s*([a-z][a-z0-9_]{0,31})\s*\}\}/g`, confirmed by printing the main-side `.source`); name regexes identical (`^[a-z][a-z0-9_]{0,31}$` in macroLibrary.cjs:67, MacroEditor.tsx:19). Legacy macro with literal `{{x}}` and no inputs is not dropped by readStore (test above).

## Findings
Critical: none.
Important: none.
Minor:
- MacroEditor.tsx:262 vicinity — editor does not expose `options` editing, so options can only be set via MCP/admin; not required by the PRD.
- MacroEditor.tsx:107 — `required: i.required === true` writes `required:false` into every saved input (harmless noise).
- MacroInputsForm.tsx:69 — for a non-required select, a stored default not matching an option would show the blank option while holding the default value; schema prevents this (default ∈ options), so unreachable via validated paths.
- Worktree lacked `node_modules` (PRD 1972 symlinking was merged but the validate worktree was created without it); worked around locally, nothing committed.
- Untracked stray `<path>` file in cwd is the known sqlite-MCP placeholder; not part of this plan.
Security: no injection, path traversal or secrets concerns in the diff; values are sanitized (control chars stripped, length-capped) and substituted via a replacer function, so `$&`/`{{x}}` in values are not re-expanded.
