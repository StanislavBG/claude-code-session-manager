# Tag Library page audit — 2026-10-09

- Key: `tag-library`
- Label: Tag Library
- Faces: home
- Entry: `src/renderer/components/tabs/TagLibrary.tsx`
- Base SHA: `1253df1dea505dad7c44edde4ea284da60d813b2`
- Surface counts (`node scripts/page-surface.cjs tag-library`): owned 1, shared 37, api 3, tests 3
  (the tool needed `NODE_PATH` pointing at the main checkout's `node_modules`, because this job worktree has no
  `typescript` installed).

I did not run vitest: the worktree has no `node_modules`, and the page's tests are judged from their source and
from `tests/quality/summary.json` verdicts.

## Known-context check: tag assign/unassign no longer strips fields

The fix holds. Three layers cooperate:

- `src/renderer/lib/personaSavePayload.ts` `toPersonaSaveInput` builds the payload from the full persona:
  `effort: persona.effort ?? undefined`, `projects`, `action`, `actionLabel`, `title`, `body` and the rest are all
  forwarded; `TagLibrary.tsx` `assign`/`unassign` pass only `{ tags }` as an override.
- `src/main/agentLibrary.cjs` `savePersona` carries over `seedVersion`, `title`, `projects`, `action` and
  `actionLabel` from the existing file when the caller leaves them `undefined`. `seedVersion` is not in the
  payload helper at all, so that carry-over is what preserves it.
- `TagLibrary.test.tsx` "preserves non-tag persona fields on save" asserts `effort`, `title`, `projects`,
  `action` and `actionLabel` on both assign and unassign.

A residual loss path remains (F1, F2).

## Principles

### 1. Stateless

Verdict: PASS

Local state is transient UI only: `selectedTag`, `adding`, and `personas`, a projection of
`window.api.agents.listPersonas()` that is re-read on mount, on `agents:changed` and on the directory watch. No
browser storage. Reloads are sequence-guarded (`loadSeq` in `load()`), so a stale response never overwrites a
fresher one.

### 2. Physical files

Verdict: FINDINGS

Reads and writes target the real `~/.claude/agents/<name>.md` through `agents:list-personas` /
`agents:save-persona`, which is the file Claude Code reads. But the write path rebuilds the whole file from a
fixed key list (F1) from a possibly stale in-memory snapshot (F2).

### 3. Current, not hardcoded

Verdict: PASS

The persona list is live: mount read, `agents:changed`, and `useAgentsDirWatch(null, ...)` for external edits
(`TagLibrary.configWatch.test.tsx` covers the watch). `TAG_LIBRARY` is a compiled-in catalog by design: the
domain model law makes the 5-tag union closed, and `src/main/__tests__/workTypeLibrary.test.cjs` keeps it in
sync with `WORK_TYPES`. The "N tags" toolbar count is derived from `TAG_LIBRARY.length`, not typed.

### 4. One API per feature

Verdict: FINDINGS

`node scripts/page-surface.cjs --duplicates`:

```
agents.listPersonas -> agents:list-personas  (3) agent-library, project-home, tag-library
agents.onChanged -> agents:changed  (3) agent-library, project-home, tag-library
agents.savePersona -> agents:save-persona  (2) agent-library, tag-library
```

All three methods have one IPC handler each, but the renderer-side load/refresh logic is copied (F3), and the
tag-only write goes through the whole-persona writer (F2).

### 5. Clear separation and platform adherence

Verdict: FINDINGS

The page imports only `components/ui/`, `lib/` and `state/` files, no other page's owned file; the renderer
does no fs access; Home face matches `NAV_ITEMS` (`navGroups.ts:80`, `faces: HOME`); errors go through `toast`.
The finding is on the platform side: the persona writer does not preserve Claude Code frontmatter keys it does
not know (F1). The component docblock also still says "read-only directory" (F5).

### 6. Lean tests

Verdict: FINDINGS

`npm run lint:test-smells` output lists both page test files as `mock-only`; summary verdicts below. See F4.

## Findings

| id | severity | principle | file + symbol | evidence | fix shape | owner page |
| --- | --- | --- | --- | --- | --- | --- |
| tag-library-F1 | Important | 2, 5 | `src/main/agentLibrary.cjs` `serializePersona` | Quoted code: `function serializePersona({ name, description, tools, model, effort, color, tags, projects, action, actionLabel, title, seedVersion, body })` writes only those keys. Any other frontmatter key on the file (Claude Code subagent keys such as `disallowedTools`, `permissionMode`, `maxTurns`, `skills`, `mcpServers`, `hooks`, `memory`) is silently deleted by a tag assign/unassign, which rewrites the whole file via `savePersona`. Not triggered on this machine today: key census of `~/.claude/agents/*.md` shows only `name description tools model effort color tags title seedVersion`. The same hole exists in the Agent Library editor. | behavior | agent-library |
| tag-library-F2 | Important | 2, 4 | `src/renderer/components/tabs/TagLibrary.tsx` `assign` / `unassign` → `agents.savePersona` | `toPersonaSaveInput(persona, { tags })` rewrites `name`, `description`, `tools`, `model`, `color`, `body` and the rest from the renderer's cached `personas` snapshot. An external edit to that file after the last reload but before the click (the dir watch is asynchronous) is overwritten with the old values. Adding one tag is a one-key change. Also `toKnownTags` silently drops any non-taxonomy tag already on the persona on save. Fix shape: add a narrow main-side op, e.g. `agents:set-persona-tags { name, tags }`, that reads the file fresh, replaces only the `tags:` frontmatter line, preserves every other key and the body, validates tags against `WORK_TYPES`, writes via `writeTextAtomic`, and broadcasts `agents:changed`. Tag Library and Agent Library's tag chips would use it; `personaSavePayload.ts` and its `toKnownTags` workaround then shrink or go. | wire | agent-library (handler `agents:save-persona` in `src/main/index.cjs`, `agentLibrary.cjs`); tag-library for the caller |
| tag-library-F3 | Minor | 4 | `src/renderer/components/tabs/TagLibrary.tsx` `load` + `useEffect(() => window.api.agents.onChanged(...))` | `grep -rn "agents\.\(listPersonas\|onChanged\)" src/renderer` shows the list+refresh loop re-implemented in `TagLibrary.tsx:49,62` and `AgentLibrary.tsx:114,129`, plus `NewEpicCard.tsx:205`, while `src/renderer/lib/useAgentPersonas.ts` already implements the same "read + re-read on `agents:changed`". The hook is not a drop-in as written: it has no sequence guard, swallows errors (no toast), cannot reload on demand after a save, and returns `[]` before the first load so callers cannot show "loading…" (`TagLibrary.tsx:189` uses `null`). Judgment: yes, this is a duplicate; fix by extending `useAgentPersonas` (null-until-loaded, `loadSeq` guard, error callback/toast, returned `reload`, optional dir watch via `useAgentsDirWatch`) and having TagLibrary, AgentLibrary and NewEpicCard consume it. | wire | agent-library (shared hook, AgentLibrary and NewEpicCard callers); tag-library for its caller |
| tag-library-F4 | Minor | 6 | `src/renderer/components/tabs/__tests__/TagLibrary.configWatch.test.tsx`, `TagLibrary.test.tsx` | `page-surface`: `TagLibrary.configWatch.test.tsx  merge (uniqueS<=3 ...covered by 2 other test files)`; `TagLibrary.test.tsx  review (smell:mock-only)`. `lint:test-smells` lists both as `mock-only` (7 and 3 cases, 220 and 112 lines). Both files duplicate the `installWindowApiMock` harness and `mount()` helper. Several cases assert only `toHaveBeenCalledWith` on `savePersona`/`listPersonas`/`config.watch`. Fix: merge into one scenario file (assign, unassign with field preservation, external-change reload, unmount unwatch) with disk-shaped assertions; once F2 lands, the save assertions move to a main-side test of the new op. | test-reduction | tag-library |
| tag-library-F5 | Minor | 5 | `src/renderer/components/tabs/TagLibrary.tsx` docblock (lines 14-34) | Quoted: "Tag Library — read-only directory of the Epic intent-tag taxonomy, plus a writable relationship ..." and `useEffect` comment at line 64 "agents:changed only fires as a write-echo from this app's OWN save" (the same claim sits in `useAgentsDirWatch.ts` doc). The page is a CRUD editor over tag assignment per root `CLAUDE.md`; docblock wording misleads. Fix: reword to "tag taxonomy closed; tag assignment is writable". | doc | tag-library |

## Test reduction candidates

| test file | verdict | reasons | proposed action |
| --- | --- | --- | --- |
| `src/renderer/components/tabs/__tests__/TagLibrary.configWatch.test.tsx` | merge | `uniqueS<=3`; top source `TagLibrary.tsx` covered by 2 other test files; `mock-only` smell | Merge its three cases (watch on mount, reload on `config:changed`, unwatch on unmount) into `TagLibrary.test.tsx` as one external-change scenario, then delete the file under the README Reduction rule (`coverage-guard.cjs --base <sha>` exits 0 and `mutants.cjs` same `--seed` shows no new survivor). |
| `src/renderer/components/tabs/__tests__/TagLibrary.test.tsx` | review (smell:mock-only) | Assertions are mostly `toHaveBeenCalledWith` on a mocked `window.api` | Keep as the merge target. Re-express the save assertions against the real `savePersona` serialization once F2 lands. |
| `src/renderer/components/__tests__/screenMemoization.test.tsx` | keep | Cross-page memoization guard | None (shared; not a candidate). |

Not a candidate but relevant: `src/renderer/lib/__tests__/personaSavePayload.test.ts` belongs to the shared payload
helper (agent-library and tag-library); if F2 removes the helper it goes with it.
