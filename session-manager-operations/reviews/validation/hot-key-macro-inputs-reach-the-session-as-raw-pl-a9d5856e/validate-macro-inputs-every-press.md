# Validation: HOT KEY macro inputs (PRDs 2101-2105)

Base c8844fd5; commits 474f00d0, c30217d8, 9322c2a9, abb749bc, c71bbed6. PRD files found in prds-archived/.

## 2101 macro-render-main-primitive — VERIFIED
- macroLibrary.cjs exports macroPlaceholders/defaultMacroValues/renderMacroPrompt/macroVisibleIn (+75 lines); strict undeclared case and Portfolio defaults confirmed by running node: default render = four default lines, no `{{`; `('x {{a}}', undefined, {})` -> `prompt uses undeclared input {{a}}`.
- Tests (constructor, macroVisibleIn, bogus mode) present in macroLibrary.test.cjs; gate vitest + typecheck green.

## 2102 macro-save-rejects-undeclared — VERIFIED
- Merged-macro check in saveMacro; tests in macroLibrary.test.cjs and macroAdminRoutes.test.cjs (+15). Legacy test (macroLibrary.test.cjs:380) passes; MacroSchema/refineInputs unchanged (refineInputs at :76, used at :164/:179).
- Gate vitest (3 files) green.

## 2103 macro-render-renderer-strict — VERIFIED
- macroPrompt.ts early return removed; own-property reads; useMacroLaunch/macroPrompt tests updated; tests/unit/macroRenderParity.spec.ts present. Gate vitest + typecheck + lint:any green.

## 2104 remote-create-renders-macro — VERIFIED
- ipcSchemas.cjs: macroId + bounded inputs record (<=2000 chars, <=20 keys). webRemote.cjs: visibility check -> `unknown macro`, render failure throws result.error (no value echo), requestExternalNewSession gets exactly {cwd,agentName,tag,title,prompt}; options has macroInputs:true.
- webRemoteSessionCreate.spec.ts green; typecheck green.

## 2105 phone-sheet-macro-inputs — VERIFIED
- NewSessionSheet.tsx (+51): fields, macroId/inputs payload, blocked-on-old-desktop, projects filter; spec covers all listed cases (new-session-sheet.spec.tsx:91-131). Gate: ci, typecheck, test (155 pass), lint:docs green.

## Plan-level check
- Phone payload (defaults mode=auto, others none) via macroId+inputs through renderMacroPrompt yields `- Mode: auto / - Focus: none / - Instructions: none / - Data / links: none`, no `{{` (node run + webRemoteSessionCreate.spec + phone spec).
- TS/CJS parity: macroRenderParity.spec.ts passes. Legacy macros still load.

## Findings
- Critical: none. Important: none.
- Minor: /code-review and /security-review not run as skills; self-reviewed: inputs bounded by schema, visibility check prevents cross-project macro use, errors don't echo values, no secrets/path handling.
