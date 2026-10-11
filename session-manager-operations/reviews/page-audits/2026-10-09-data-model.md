# Data Model page audit — 2026-10-09

- **Key:** `data-model`
- **Label:** Data Model
- **Faces:** home
- **Entry:** `src/renderer/components/tabs/DataModel.tsx`
- **Base SHA:** `0f5ec6453055dd710dfb3c5a74ccc67ae7e31474`
- **Surface counts:** owned 1 · shared 5 · api 0 · shared api 0 · tests 1
- **Surface command:** `node scripts/page-surface.cjs data-model` (the worktree has no `node_modules`, so it was run with `NODE_PATH=/home/bilko/Projects/session-manager/node_modules`).

Scope: the one owned file, plus `src/renderer/lib/dataModelErd.ts` (shared with `overview`; judged here only as the drift-prone mirror the page exists to show). Every entity was compared against the sources its header names and against `OWNERS`/`DELEGATIONS` in `src/main/lib/opsOwnership.cjs`. Every source file named in the header and in `definedIn` exists. All `store.path` values for ops namespaces match the `opsPath()` call in their source (`exchanges.cjs`, `epicWorktreeProjectConfig.cjs`, `memoryAggregate.cjs`, `projectBrief.cjs`, `promptSessionTranscript.cjs`, `queueStore.cjs`, `prdLocations.cjs`, `uiPrefs.ts`, `promptSessions.ts`). `tabs.json`, `billing-cache.json`, `workbench-layout.json`, `agent-memory/<agentId>.json` and `history-rollup.jsonl` also match. Drift found is listed in `### Findings`.

### 1. Stateless

Verdict: PASS

The page holds only transient UI state: `view`, `selectedId`, `hiddenGroups` (`DataModel.tsx:40-42`). It reads no file and writes none.

```
$ grep -nE "localStorage|sessionStorage|window\.api" src/renderer/components/tabs/DataModel.tsx
(no output)
```

The data comes from a module-level constant compiled into the bundle. That is a principle 3 question, not a principle 1 one.

### 2. Physical files

Verdict: PASS

The page shows no file content and edits nothing (`api (0)` in the surface output), so there is no app-private copy of a Claude Code file. The ERD describes real files, and the paths it names were checked in `### Findings`.

### 3. Current, not hardcoded

Verdict: FINDINGS

The whole page is a hand-maintained mirror, which the charter allows if it names its sources and changes in the same commit. Four mismatches or gaps were found (data-model-F1, F2, F3, F6), and nothing guards the mirror against drift (data-model-F4).

**Derivation / drift-test inventory** (the standing principle 3 question):

| Mirror part | Real source | Can it be derived or drift-tested? |
| --- | --- | --- |
| `store.writer` on every ops entity | `OWNERS` + `DELEGATIONS` in `opsOwnership.cjs` | **Derive or test.** `OWNERS` is a plain frozen object exported by a `.cjs` module. A vitest drift test can `require` it and assert the namespace in each ops `store.path` maps to `entity.store.writer`. |
| `opsNamespace` entity's namespace/writer examples | `OWNERS` | **Test.** Assert every `OWNERS` key is named by some entity path. This would have caught F3. |
| `scheduleJob.status` enum | `JOB_STATUSES` in `scheduleJobSchema.cjs` / `ScheduleJobStatus` in `api.d.ts` | **Test.** Parse the union from the field's `type` string and compare to `JOB_STATUSES`. This would have caught F1. |
| `tag` entity and the `'feature' \| 'bug' ...` unions on `prd.tag` and `tag.tag` | `TAG_LIBRARY` / `EpicTag` in `tagLibrary.ts` | **Derive.** The renderer can import `TAG_LIBRARY` and build the union text. At minimum, test the string against `TAG_LIBRARY.map(t => t.tag)`. |
| `ScheduleJob` status-history cap (`~20 entries`) | `STATUS_HISTORY_CAP` in `scheduleJobTransitions.cjs` | Test. |
| `store.path` for ops entities | each source's `opsPath(cwd, ...)` call | Test. Regex the path segments out of the cited `definedIn` file. Brittle, so low priority. |
| `fields` of each shape | `api.d.ts` interfaces and TS types | Not derivable at runtime. Most of this mirror is prose and cannot be generated. Keep it hand-maintained, and add drift tests for the high-risk enums only. |
| `ERD_RELATIONS`, group tones and layout | none; they are modeling choices | Keep as is. |

### 4. One API per feature

Verdict: PASS

The page calls no `window.api` method, so it has no IPC surface to duplicate.

```
$ node scripts/page-surface.cjs --duplicates | grep -i data-model
(no output)
```

### 5. Clear separation and platform adherence

Verdict: PASS

- `DataModel.tsx` imports only `../ui/{Panel,ViewTabs,EmptyState,Badge}` and `../../lib/dataModelErd` (lines 1-21), so it imports no other page's owned file.
- It has no fs, `child_process` or `process.platform` use, and no z-index class literal.
- Face law holds: `navGroups.ts:86` declares `faces: HOME`, which matches the surface output.
- `dataModelErd.ts` is plain data with no React or DOM import, as its header requires. Cross-page consumers (`overview` through its Dashboard, and `Home.tsx:54` importing `ERD_ENTITIES`) read exports that this audit does not change.
- `npm run lint` was not run (no `node_modules` in the worktree). The checks above are by grep and by reading the file.

### 6. Lean tests

Verdict: FINDINGS

`DataModel.test.tsx` (surface verdict `keep`) has six tests driven through the public component entrypoint. The shared lib test `src/renderer/lib/__tests__/dataModelErd.test.ts` is not attributed to this page by the surface tool and has no verdict. It holds change-detector assertions and no real drift guard (data-model-F4, F5).

### Findings

| id | severity | principle | file + symbol | evidence | fix shape | owner page |
| --- | --- | --- | --- | --- | --- | --- |
| data-model-F1 | Important | 3 | `src/renderer/lib/dataModelErd.ts` — entity `scheduleJob`, field `status` | The mirror lists 7 statuses and omits `'skipped'`. Command: `grep -n "JOB_STATUSES =" src/main/lib/scheduler/scheduleJobSchema.cjs` gives `29:const JOB_STATUSES = ['pending', 'running', 'investigating', 'completed', 'skipped', 'failed', 'needs_review', 'quarantined'];`. `api.d.ts:604` has the same 8 values. The mirror has `type: "'pending' \| 'running' \| 'investigating' \| 'completed' \| 'failed' \| 'needs_review' \| 'quarantined'"`. `scheduleHistoryEntry.status` points at `ScheduleJobStatus`, which includes `skipped`. | doc | data-model (mirror file is shared with `overview`; list it in the fix PRD's Files) |
| data-model-F2 | Important | 3 | `dataModelErd.ts` — entities `epic`, `epicEvent` (`store.writer: 'epics'`) | The mirror presents a single writer, but `DELEGATIONS` grants a second one. Command: `sed -n 76,90p src/main/lib/opsOwnership.cjs` shows `'prompt-sessions': [{ writer: 'scheduler', file: 'active-index.json', reason: 'The scheduler appends prd_created/response events ... and mints/joins an Epic when a PRD is created' }]`. `epic` and `epicEvent` both live in `active-index.json`, so the page's "single-writer owner" claim is incomplete for exactly the two entities the delegation covers. The `epic` notes also say the New Epic handler and `crossProjectFeedback.cjs` are the only mint authorities, and say nothing of the scheduler delegation. | doc | data-model |
| data-model-F3 | Minor | 3 | `dataModelErd.ts` — entity `opsNamespace` and `ERD_ENTITIES` (no `logs` entity) | `OWNERS` has 7 namespaces (`prompt-sessions`, `scheduler`, `project-brief`, `project-pages`, `logs`, `memory-clusters`, `ui-prefs`), but no entity stores anything under `logs/`. Command: `grep -n "logs/" src/renderer/lib/dataModelErd.ts` gives no match for a store path. `opsErrorLog.cjs` header: "sole writer of the `logs` ops namespace ... `<cwd>/session-manager-operations/logs/errors-<date>.jsonl`". The page cannot answer "where does the per-tab error log live and who writes it". | doc | data-model |
| data-model-F4 | Important | 3, 6 | `src/renderer/lib/__tests__/dataModelErd.test.ts` — test `marks every project-realm namespaced entity with the correct OWNERS writer` | The only writer check uses a hand-typed map and never reads `OWNERS`. Excerpt: `const expectedByPathFragment: Array<[string, string]> = [['prompt-sessions','epics'],['scheduler/','scheduler'],['project-brief','project-home'],['project-pages','project-home'],['memory-clusters','memory-clusters']]`. It omits `ui-prefs` and `logs`, so `uiPrefs.store.writer` is never checked, and an `OWNERS` change would not fail it. Nothing checks the status enum (F1 got through), tag union, `DELEGATIONS` (F2), or `STATUS_HISTORY_CAP`. The mirror's own header promises it "must change in the same PR", but no test enforces that. | wire | data-model |
| data-model-F5 | Minor | 6 | `dataModelErd.test.ts` — tests `has exactly the 35 entities enumerated in the PRD...`, `has at least 40 relations`, `has exactly 8 groups in the documented order` | These pin the current content of the data file. Adding an entity or group means editing the test, and they detect no drift against any real source. Excerpt: `expect(ERD_ENTITIES.map((e) => e.id).sort()).toEqual([ 'project', 'tab', 'epic', ... 'uiPrefs' ].sort())`, with a comment trail of PRD numbers justifying each increment. The same file's structural checks (unique ids, fk refs resolve, relation endpoints resolve, non-empty fields, known group) are the useful ones and should stay. | test-reduction | data-model |
| data-model-F6 | Minor | 3 | `dataModelErd.ts` — entities `mcpServerRegistry`, `pluginRegistry`, `systemPrompt`, `skillsAndCommands` (`store.definedIn`) | `definedIn` names another page's UI file instead of the persistence source: `src/renderer/components/tabs/McpServers.tsx`, `Plugins.tsx`, `SystemPrompt.tsx`, `Skills.tsx`. Command: `grep -n "definedIn.*components/tabs" src/renderer/lib/dataModelErd.ts` gives 4 hits. These files hold the read/write path inline today, but a page refactor would silently orphan the citation. | doc | data-model (consumers: `mcp`, `plugins`, `system-prompt`, `skills`) |
| data-model-F7 | Minor | 3 | `dataModelErd.ts` — entity `uiPrefs`, field `chatVerbosityPerEpic` | The mirror says `type: 'Record<string, ChatVerbosity>'`, but the source says `chatVerbosityPerEpic?: Record<string, string>` (`uiPrefs.ts:39`). Also `projectPages.store.definedIn` lacks the trailing space the file's own comment (lines 165-168) requires. | doc | data-model |

### Test reduction candidates

The surface tool attributes one test file to this page. It has no `bloat` or `merge` verdict, so there are no candidates among attributed files.

| test file | verdict | reasons | proposed action |
| --- | --- | --- | --- |
| `src/renderer/components/tabs/__tests__/DataModel.test.tsx` | keep | Six tests through the public `DataModel` entrypoint: both views render, one `<path>` per layout edge, every entity name shown, selection shows relations, a relation button re-selects. | keep |

Outside the attributed set (shared lib, no surface verdict): `src/renderer/lib/__tests__/dataModelErd.test.ts` has three content-pinning tests (see data-model-F5). Proposed action: replace them with the drift test from data-model-F4 under the Reduction rule (`coverage-guard.cjs --base <sha>` exits 0 and `mutants.cjs` with the same `--seed` shows no new surviving mutant). Keep the structural integrity tests and the `layoutErd` tests. Because the file is shared with `overview`, name that page as a consumer in the fix PRD.
