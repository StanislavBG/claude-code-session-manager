# Validation: Home-tab page audits, wave 1 (validate-page-audits-home)

Base: `d4a0615c` (from the PRD). HEAD at validation: `08505d6f`. Method: PRD files read from `scheduler/epics/home-tab-create-a-dedicated-subagent-for-each-pa-12c95b3d/prds-archived/`. All 14 gates re-run (each is a two-`grep -q` check, all exit 0). Header, six-section and `Verdict:` structure checked by script on every report. Two findings per report spot-checked against the tree (reads and greps, performed by delegated read-only sub-reviewers; the rest of the base..HEAD diff is non-audit fix-wave work and was not re-reviewed). `/code-review` and `/security-review` were not run: the only diff under review is 14 Markdown files, which have no executable surface. No secrets or path-traversal content appear in them.

## Audit-commit scope check

`git show --name-only` over the 14 `docs(reviews): … page audit 2026-10-09` commits: each touches exactly one file, `session-manager-operations/reviews/page-audits/2026-10-09-<key>.md`. No audit commit changed anything else. PASS. (`git diff --stat d4a0615c..HEAD` also lists 30+ `src/` files; those come from interleaved fix-wave and clipboard PRDs, not audit commits.)

## Per-PRD verdicts

All 14 reports: gate green; header present (key, label, faces, entry, base SHA, surface counts; formats vary but all fields present); `### 1.`–`### 6.` each followed by `Verdict: PASS|FINDINGS`; Findings table with severity, principle and fix shape; `Test reduction candidates` section present. No principle is marked PASS without reasoning (no Minor finding of that kind).

| PRD | Verdict | Spot-check 1 | Spot-check 2 |
| --- | --- | --- | --- |
| ps-audit-overview | VERIFIED | F1: `Home.tsx:777,781` uncached `listDir` scan; `useKnownProjects.ts:108-112` same scan cached. Confirmed | F2: four direct `schedule.runNow` callers (`Home.tsx:579`, `SchedulerPrdsView.tsx:375,548`, `CommandPalette.tsx:120`). Confirmed |
| ps-audit-projects | VERIFIED | F1: pin hydrate gap was real; **fixed since** by `b119fc69` (`ProjectsWorkspace.tsx:71` `hydrate()`). Finding valid at its base | F4: `compactPath.ts` hardcodes `/home/`. Confirmed (F3 no `config.watch` in `FileTree.tsx` also confirmed) |
| ps-audit-history | VERIFIED | F1: five `history/analytics` files import `projectNameFromCwd` from `scheduler/sched-primitives`. Confirmed | F2: `SchedulerTopBands.tsx:252` and `HistoryDashboard.tsx:123` both call `history.dashboard`; "Done today" label on a 30-day range. Confirmed |
| ps-audit-system-prompt | VERIFIED | F1: `ReferencedFilesPanel.tsx:49,61` parse only in a mount effect. Confirmed | F2: `Library.tsx:634,652,685` raw `readText`/`writeText` outside `useConfig`. Confirmed |
| ps-audit-skills | VERIFIED | F1: `Skills.tsx:176` `loadText(item.path)` without `keepDirty`. Confirmed | F3: `listSkills.ts` has no error handling. Confirmed |
| ps-audit-plugins | VERIFIED | F1: `Plugins.tsx:107,255-258` `setLoading(true)` unmounts drill-in on every reload. Confirmed | F5: `pluginSkills.ts:60,64` flat walk vs `listSkillEntries` in `listSkills.ts:15`. Confirmed |
| ps-audit-mcp | VERIFIED | F1: `McpServers.tsx:442-443` `defaultValue` with no `key` on the editor (l.369-375). Confirmed | F6: `mcpStatus.cjs:61` `spawn` with no `cwd`. Confirmed |
| ps-audit-hooks | VERIFIED | F2: `Hooks.tsx:233-249` `catch { current = {} }` then rewrite. Confirmed | F4: `Hooks.tsx:608` `placeholder="timeout ms"`. Confirmed (schema-seconds claim not independently re-checked) |
| ps-audit-permissions | VERIFIED | F1: `Permissions.tsx:118-132` same `catch { current = {} }` pattern. Confirmed | F3: `ModeSelector` hardcodes 4 modes (l.266-271, type l.26). Confirmed (8-value enum count not re-counted) |
| ps-audit-settings | VERIFIED | F3: `SettingsEpicIsolation.tsx:29` and `groundingBoard.ts:110` both call `getWorktreeDisabled`. Confirmed | F4: `SettingsEpicIsolation.tsx:36-39` rejection handler only `setLoaded(true)`. Confirmed |
| ps-audit-agent-library | VERIFIED | F1: `AgentLibrary.tsx:114,129` own load/`onChanged` instead of shared hook. Confirmed | F2: `AgentLibrary.tsx:42,462` hardcoded `TOOLS`. Confirmed |
| ps-audit-tag-library | VERIFIED | F1: `agentLibrary.cjs:75` `serializePersona` fixed key list drops unknown keys. Confirmed | F2: `toKnownTags` at `personaSavePayload.ts:13,29` (code side confirmed; stale-snapshot scenario not executed) |
| ps-audit-voice | VERIFIED | F1: no watch in `voiceHotkey/voiceSettings/voiceWizard.cjs`; `voice:hotkey-changed` only at `voiceHotkey.cjs:311`. Confirmed | F4 (Minor): `VoiceModal.tsx:72` `/Mac/.test(navigator.platform)`. Confirmed |
| ps-audit-data-model | VERIFIED | F1: `JOB_STATUSES` (`scheduleJobSchema.cjs:29`, 8 values incl. `skipped`) vs `dataModelErd.ts:410` (7). Confirmed | F2: `opsOwnership.cjs:76-90` scheduler delegation on `prompt-sessions`. Confirmed (F4 hand-typed map at `dataModelErd.test.ts:98` also confirmed) |

## Findings (about the audits)

### Critical
- none.

### Important
- none. No audit was refuted.

### Minor
- projects-F1 is already fixed by `b119fc69` (landed after the audit base). The fix wave should drop it rather than re-queue it.
- Report headers use three different formats (bold keys, lowercase keys, `Surface counts`/`surface-tool counts`/`surface counts`). All required fields are present; the charter could pin one template.
- Spot-check limits: hooks-F4's "schema is seconds" claim, permissions-F3's 8-value enum count and tag-library-F2's overwrite scenario were not reproduced end-to-end.
- Several reports record base SHAs earlier than the HEAD they were written against (e.g. overview `a9204dac`, projects `dd59658b`); findings in files changed since base should be re-checked at fix time, as for projects-F1.
- Cross-report: hooks-F2 and permissions-F1 are the same copy-pasted bug; permissions-F5 already proposes one shared `lib/` helper, which should serve both.

## Closing table: every Critical and Important finding (14 reports)

| id | page | principle | severity | fix shape |
| --- | --- | --- | --- | --- |
| overview-F1 | overview | 4 (and 3) | Important | wire: `RecentSessionsCard` reads per-session mtimes from the cached `useKnownProjects` scan; delete the local `listDir` scan |
| projects-F1 | projects | 1 / 2 | Important | behavior: hydrate pins on mount, read-modify-write pin writes (ALREADY FIXED in `b119fc69`) |
| projects-F2 | projects | 1 | Important | migration: move split width and collapsed state from `localStorage` to `uiSettingsPrefs`; drop allowlist entry |
| projects-F3 | projects | 3 | Important | wire: watch cwd and expanded dirs via `config.watch`/`config:changed`; re-run `refreshNode` |
| projects-F4 | projects | 3 / 5 | Important | behavior: `compactPath` takes home dir from `useHomeDir`, not hardcoded `/home/` |
| history-F1 | history | 5 | Important | wire: import `projectNameFromCwd` from `lib/knownProjectAggregate` in the five analytics files |
| history-F2 | history | 4 | Important | wire: shared `lib/historyTotals.ts` for both `history.dashboard` callers; fix "Done today" vs 30-day label |
| history-F3 | history | 3 | Important | behavior: refetch on focus/visibility, add `history:updated` event or poll |
| system-prompt-F1 | system-prompt | 3 | Important | behavior: re-run `parseImports` on root file disk change / `config.onChanged` |
| system-prompt-F2 | system-prompt | 4 / 1 | Important | wire: route Presets read/write through `useConfig`, or refresh on `config.onChanged` |
| skills-F1 | skills | 2 / 1 | Important | behavior: `loadText(path, true)` or disable toggle while draft dirty |
| skills-F2 | skills | 4 | Important | wire: one shared skill-discovery walker for `listPluginSkills` and Library installed-check |
| skills-F3 | skills | 3 / 5 | Important | behavior: return listing error from lib, catch in `loadItems`, toast |
| plugins-F1 | plugins | 1 / 3 | Important | behavior: set `loading` only on first load; keep rows during refresh |
| plugins-F2 | plugins | 1 / 5 | Important | behavior: surface `parseError` and thrown errors via toast plus inline state |
| plugins-F3 | plugins | 3 | Important | wire: watch selected plugin's hooks.json, .mcp.json, agents, skills; reload detail |
| plugins-F4 | plugins | 2 | Important | behavior: resolve component paths from manifest, accept bare-map `.mcp.json`, add Commands section |
| plugins-F5 | plugins | 4 | Important | wire: `listPluginSkills` delegates to `listSkillEntries`; derive row count from it |
| mcp-F1 | mcp | 1 | Important | behavior: `key={selectedName}` on editor or controlled input; add scenario test |
| mcp-F2 | mcp | 5 | Important | behavior: add read/write `local` scope for `projects[cwd].mcpServers` in `~/.claude.json` |
| mcp-F3 | mcp | 2 | Important | behavior: disable editing while file unparseable; save by replacing only `mcpServers` |
| mcp-F5 | mcp | 3 | Important | wire: re-probe after save and on debounced `config:changed` |
| mcp-F6 | mcp | 3 | Important | behavior: `mcp.status(cwd)` with zod schema; pass `cwd` to `spawn`; key coalescing by cwd |
| hooks-F1 | hooks | 5 / 2 | Important | behavior: fix agent, mcp_tool, terminalSequence and http editor fields to match the schema |
| hooks-F2 | hooks | 2 / 1 | **Critical** | behavior: refuse to rewrite an invalid-JSON draft in `overrideInto` |
| hooks-F3 | hooks | 3 / 5 | Important | wire: derive event list from the schema; add `MessageDisplay`, `DirectoryAdded` |
| hooks-F4 | hooks | 5 | Important | behavior: relabel timeout as seconds or convert ms to seconds |
| permissions-F1 | permissions | 2 | **Critical** | behavior: refuse to rewrite an invalid-JSON draft; disable Rules view while `err` set (shares fix with hooks-F2) |
| permissions-F2 | permissions | 1 / 4 | Important | wire: apply presets through `useConfig`; watch `current` so a dirty draft isn't overwritten |
| permissions-F3 | permissions | 3 | Important | wire: derive `defaultMode` options from the schema enum (8 values) |
| permissions-F4 | permissions | 4 | Important | behavior: mtime/stale check in `saveJson`; stop `onExternalChange` silently keeping a dirty draft |
| settings-F1 | settings | 3 | Important | wire: `config.watch`/`onChanged` refresh for Telemetry and Epic isolation sections |
| settings-F2 | settings | 3 | Important | wire: watcher for `uiChromePrefs` and `rawSessionModel` hydration |
| settings-F3 | settings | 4 | Important | wire: one shared hook/lib for `getWorktreeDisabled` |
| settings-F4 | settings | 1 | Important | behavior: toast on load failure; block Save until a successful load |
| agent-library-F1 | agent-library | 4 | Important | wire: extend `useAgentPersonas` (cwd, loadSeq, error, reload, dir watch); adopt in AgentLibrary, TagLibrary, NewEpicCard |
| agent-library-F2 | agent-library | 3 | Important | behavior: render union of known `TOOLS` and persona's own tools; name the source |
| tag-library-F1 | tag-library | 2 / 5 | Important | behavior: `serializePersona` preserves unknown frontmatter keys |
| tag-library-F2 | tag-library | 2 / 4 | Important | wire: main-side `agents:set-persona-tags` reads file fresh and replaces only `tags:` |
| voice-F1 | voice | 1 / 3 | Important | behavior: watch `voice.json`, reload `currentConfig`, re-run `applyConfig`, emit `voice:hotkey-changed` |
| data-model-F1 | data-model | 3 | Important | doc: add `'skipped'` to `scheduleJob.status` in `dataModelErd.ts` |
| data-model-F2 | data-model | 3 | Important | doc: note scheduler delegation on `epic`/`epicEvent` entities |
| data-model-F4 | data-model | 3 / 6 | Important | wire: drift test reading `OWNERS`, `DELEGATIONS`, `JOB_STATUSES`, `TAG_LIBRARY`; replace hand-typed map |

Totals: 2 Critical, 40 Important (42 rows).
