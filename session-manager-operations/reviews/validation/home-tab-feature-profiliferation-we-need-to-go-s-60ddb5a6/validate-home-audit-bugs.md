# Validation: home-audit-bugs plan (PRDs 2661–2674)

Base: 1bc1ccf61e4114803335ada430a038e709b65b5a. All 14 PRD files found in `prds-archived/`. Each PRD's commit is visible in `git log 1bc1ccf..HEAD` (7913e538, 95fdff5f, 7d725f73, 6c37d93a, b70fae48, 9839e6c8, e146b4b9, 0b1dcff3, d5760b52, afd9257d, b50539e8, 3757bce8, 4981c9f4, 9e09b1c2).

**Gate re-run (all PRDs' gates, in the foreground):** one vitest run over all 19 gate test files: 19 files / 102 tests passed. `npm run typecheck` exit 0 (both tsconfigs). `lint:selectors` OK (648 files). `lint:hooks` OK (323 files).

## Per-PRD verdicts

- **settings-overrideinto-refuses-invalid-draft — VERIFIED.** Settings.tsx:129-137 sets an error naming the target and "fix it in Raw" on parse failure instead of resetting to `{}`; Settings.invalidDraft.test.tsx passes.
- **mcp-project-scope-save-allowed — VERIFIED.** config.cjs:163 exact-match `path.join(realRoot,'.mcp.json')` after realpath (symlink escape resolves elsewhere and is refused); state/config.ts:166-184 returns `{ok:false,error}` on reject; both new tests pass.
- **session-slots-ipc-schema-uses-pool-max — VERIFIED.** sessionSlots.cjs:173 exports MAX_SLOTS (=32); ipcSchemas.cjs:17,656 `.max(MAX_SLOTS)`; comment updated (:653); test passes.
- **telemetry-banner-keeps-settings-opt-out — VERIFIED.** TelemetryNotice.tsx:20 fresh `getConfig()` before set; SettingsTelemetry.tsx:276 dispatches `TELEMETRY_CHANGED_EVENT`; optOut test passes.
- **persona-save-keeps-unknown-frontmatter — VERIFIED.** agentLibrary.cjs:81 `extractUnmanagedLines`, used in savePersona (:203) and overlay save (:136,148); preserveFrontmatter + existing agentLibrary tests pass.
- **hooks-timeout-field-in-seconds — VERIFIED.** Hooks.tsx:553-571 schema-derived default and positive-int parser; :653-666 "timeout (seconds)" label and inline error; scenario test passes.
- **permission-modes-from-settings-schema — VERIFIED.** Permissions.tsx:282 reads enum via `settingsSchema().at(['permissions','defaultMode'])`; :27 `defaultMode?: string`; no literal mode list found; test passes.
- **mcp-remove-fake-enabled-toggle — VERIFIED.** McpServers.tsx:83-87 strips `enabled` on write; :317 disabledMcpjsonServers note; only remaining checkbox is `alwaysLoad` (a real field); test passes.
- **claude-md-imports-outside-roots-read-only — VERIFIED.** config.cjs:362,515 `config:can-write`; preload index.cjs:172 and api.d.ts:2010; SystemPrompt.tsx:66-73,131 read-only branch; readOnlyImport test passes.
- **hot-key-delete-same-on-ui-and-mcp — VERIFIED.** SessionActionsBar.tsx:60 uses `macros.removeFromProject`; MacroEditor.tsx:107,345-356 confirmed "Delete everywhere" calls `macros.delete`; EpicQueue.tsx:635-637 label; new IPC at index.cjs:630; deleteScope test passes.
- **health-reads-ops-retention-store — VERIFIED.** health.cjs:29,1408 uses `resolveRetentionConfig` exported from runLogRetention.cjs; retentionSource test passes.
- **grounding-board-reuses-skill-and-mcp-listers — VERIFIED.** groundingBoard.ts:13,44 `listSkillEntries`; :108,126-152 User (~/.claude.json) vs Project (.mcp.json) layers; test passes.
- **home-agent-tools-renders-every-group — VERIFIED.** HomeAgentTools.tsx:13-22 labels for all 7 groups, :41-48 unknown groups appended with raw name; groups test passes.
- **data-model-erd-matches-disk — VERIFIED.** dataModelErd.ts:475 scheduler-machine.json; :553 macros.json; :890-901 three app-pref files; :521 effort; :512 action/actionLabel retired; :538 "7-tag"; facts test passes.

## Review of combined diff
Self-review (no separate tool runs): the `.mcp.json` allowance is an exact realpath match, so no path traversal beyond one file; `config:can-write` reuses the existing zod `configPath` schema and is read-only; no secrets; no duplicated helpers found (retention, skill lister and settings schema are reused).

## Findings
- Critical: none.
- Important: none.
- Minor: HomeAgentTools.tsx:11-12 notes the preload type still narrows `group` to 4 values (cast to string at runtime). Widening the type in api.d.ts is a cheap follow-up.
