# Validation: Project Home tools shared by every project

Base: a687533947655c48a29026dd40c90a6a7c5862f8. Commits 55ad2766, c7b68709, 59bc5682, 64acf8ef, f7d61eae, f36354da (one per PRD, in order). PRD files found in prds-archived/ (2939–2944).

## macro-save-route-project-home-every-project — VERIFIED
- `quoteNamesProjectHome` exported: macroAdminRoutes.cjs:56, :263. Quote gate at :80 (project-home accepts Project Home or every-project quote).
- Gate `vitest macroAdminRoutes.test.cjs schedulerMcpServerMacros.test.cjs`: green (27 + 145 tests across runs).

## project-home-tools-every-project — VERIFIED
- `widenProjectHomeScope` macroLibrary.cjs:408, exported :750; used in listMacrosRaw :554 and load :422.
- Gate (macroLibrary, macroAdminRoutes, macroJobDispatch, builtinMacros tests) + `npm run typecheck`: green (165 tests, tsc exit 0).

## mcp-macro-save-project-home-text — VERIFIED
- Gate `vitest schedulerMcpServerMacros.test.cjs mcpToolCatalog.test.cjs`: 2 files, 145 tests green.

## macro-editor-project-home-every-project — VERIFIED (with an Important finding outside its gate)
- Gate vitest (MacroEditor, ToolsPane, SessionActionsBar): 81 green; typecheck, lint:hooks, lint:selectors OK.
- Footnote changed in ToolsPane, but a sibling spec was left stale (see Findings).

## builtin-cpu-audit-macro — VERIFIED
- Gate (builtinMacros, macroLibrary, seedAgentPersonas, macroJobDispatch): green.
- Real-path probe sha256 of prompt = 7e9ed14b…a1427 (matches), 12 newlines.

## doc-project-home-tools-app-level — VERIFIED
- `npm run lint:docs`: ok. CLAUDE.md = 11,994 bytes (≤ 12,000). Named symbols exist: widenProjectHomeScope, quoteNamesProjectHome (above), builtin-cpu-audit, macro-everywhere-note (MacroEditor).

## Real-path probe (copy of ~/.claude/session-manager/macros.json, listMacros({filePath: copy}))
- builtin-cpu-audit present, projects ['*']; cpu-audit-fixes-8bd5d1 absent; exactly one macro labeled "CPU audit & fixes".
- Every surface 'project-home' entry has projects ['*'] (none non-'*').
- No stored built-in's updatedAt changed.
- Second call: temp file content unchanged (true). Live file never written.

## Full unit suite (`timeout 900 npm run test:unit`)
985 files: 984 passed, 1 failed. 9554 tests passed, 1 failed.
- RED: `ProjectPagesSection.test.tsx` › tools tab › "with only the library builtins the list is empty but keeps Add a tool and the footnote" (line 522) expects footnote to contain 'Surface: Project Home'; now reads "Every Project Home tool shows up here in every project…". **Caused by PRD macro-editor-project-home-every-project** (changed footnote in ToolsPane.tsx; that PRD's Files/gate omitted this spec).

## Findings
### Critical
- none
### Important
- src/renderer/components/tabs/projecthome/projectpages/__tests__/ProjectPagesSection.test.tsx:522 stale assertion; suite is red. Fix: update expected footnote text. (Scoped gate hid it.)
### Minor
- none (all six PRD files present).
- Self-review of diff (code-review/security tooling not run separately): no secrets, no path handling added; new save refusal is fail-closed.

Note: pre-existing foreign WIP in project-pages/home.html and demo-video/index.html was not touched.
