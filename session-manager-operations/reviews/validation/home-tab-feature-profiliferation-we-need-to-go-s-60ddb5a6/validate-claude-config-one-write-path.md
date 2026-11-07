# Validation: claude-config-one-write-path (PRDs 2676–2687)

Base `1bc1ccf6`. Gates re-run at HEAD (SM_* unset): single vitest run of all 15 spec files → 15 files / 58 tests pass; `npm run typecheck` (renderer + main) exit 0; `lint:selectors` OK; `lint:hooks` OK. Commits located via `git log 1bc1ccf6..HEAD` (108d85c7 … af501a19).

## claude-config-patch-primitive — VERIFIED
- REGISTRY/read/patch exported: src/main/lib/claudeConfig.cjs:156; unknown fileId rejected :48; invalid JSON error names path :78; per-file lock map :96-109; writes via config.cjs writeJson (validatePath+validateWrite+atomicFs) header :9-10.
- `// @ts-check` :1; in tsconfig.main.json:23; test claudeConfig.test.cjs passes.

## claude-config-ipc-wire — VERIFIED
- Handlers src/main/index.cjs:622,626 via validated(schema); config:changed broadcast on patch; preload/index.cjs:166-168; ipc test passes.

## settings-editors-patch-one-key — VERIFIED
- Permissions.tsx/Hooks.tsx: no setDraft/saveJson (grep empty); claudeConfig used in Settings/Permissions/Hooks. Settings setDraft/saveJson remain only in Raw region (Settings.tsx:213,269). Scenario + invalidDraft tests pass.

## mcp-editors-patch-one-key — VERIFIED
- McpServers.tsx:323 and Library.tsx:106 use claudeConfig.patch; no MCP writeJson remains; URL entries default type 'http' Library.tsx:53-57. McpServers.test.ts passes.

## effective-settings-one-main-resolver — VERIFIED
- effectiveSettings.cjs `@ts-check`, tsconfig.main.json:24; consumed by usage.cjs:26, modelCatalog.cjs:22, memoryDirResolve.cjs:15 (via pickByPrecedence); tests pass.

## use-effective-settings-reuses-scoped-files — VERIFIED
- useEffectiveSettings.ts:19 calls useScopedConfigFiles; no loadJson/watchFile/unwatchFile; test passes.

## source-chip-primitive — VERIFIED
- SourceChip.tsx: mtime via config read :26, refresh on config.onChanged :30, "created on first save" :35, click opens via useEditor.openFile :38; test passes.

## plugins-api-list-enable-uninstall — VERIFIED
- pluginInstall.cjs:349/354/361 handlers; zod parse; pluginsApi.test.cjs passes.

## plugins-page-enable-and-uninstall — VERIFIED
- Library.tsx:323 uses plugins.list (no enabledPlugins read); delegationReadiness.cjs:338 fix text names Plugins switch; Plugins.enable test passes.

## plugin-catalog-from-marketplaces-on-disk — VERIFIED
- `grep CATALOG_PLUGINS src` → none; Library.tsx:8 imports listMarketplacePlugins; test passes.

## personas-read-through-use-agent-personas — VERIFIED
- AgentLibrary/TagLibrary/NewEpicCard use useAgentPersonasState; no direct listPersonas/onChanged calls (only a comment NewEpicCard.tsx:124); refresh() in hook :15; missionTagsForAgent imported NewEpicCard.tsx:19; configWatch tests pass.

## mission-tag-taxonomy-parity-test — VERIFIED
- tagTaxonomyParity.test.ts passes at HEAD. (Mutation check not re-run by validator.)

## Findings
### Critical
- none
### Important
- none
### Minor
- src/renderer/components/tabs/Library.tsx:452,478,562 still `config.writeJson` whole-file for hooks/permissions library installs. Outside 2679's MCP-only criterion but is a remaining second write path to settings.json; candidate for a follow-up.
- Parity test mutation check (AC 2 of 2687) not independently re-run.
- Self-review of combined diff (79 files): no secrets or path-traversal issues seen; patch IPC validates cwd via validatePath and writes go through the existing write boundary.
