# Memory tab — design brief

Input for a design agent redoing the Memory tab UI (NavKey `memory`, Project face only,
nav group Configure). Describes **what the tab must do and what data it has** — not how it
looks today. Written 2026-10-12 from the code on `main` plus the queued plan of Epic
`memory-project-tab-describe-the-features-of-the--609fcd0b`.

## 1. What the tab is (one paragraph for a first-timer)

Claude Code forgets everything between conversations. **Memory** is a folder of short
Markdown notes that Claude Code itself reads at the start of every session, so it doesn't
relearn the same things. The Memory tab is a window onto **Claude Code's own memory files** —
it adds nothing Claude can't read, it never invents a parallel store. On top of the native
files it adds an **aggregate layer**: health checks, staleness, clustering, and a quick console.

## 2. The native model the UI must make legible

| Concept | Where it lives | Key fact for the UI |
| --- | --- | --- |
| Workspace (project) memory | `~/.claude/projects/<encoded git-repo root>/memory/` (or the `autoMemoryDirectory` setting) | All worktrees of a repo share one folder. |
| `MEMORY.md` | In each memory folder | The **index**: one line per memory, `- [Title](file.md) — hook`. Only its **first 200 lines / 25 KB** load into a session. A memory file with no index line is effectively invisible. |
| Topic file | `<name>.md` beside the index | Frontmatter `name` / `description` + body. |
| Subagent memory | `~/.claude/agent-memory/<agent>/` (scope `user`), `<repo>/.claude/agent-memory/<agent>/` (`project`, committed), `<repo>/.claude/agent-memory-local/<agent>/` (`local`, not committed) | Exists only when the agent's frontmatter has `memory: user\|project\|local`. Same shape as workspace memory (index + topic files). |
| Auto memory on/off | `autoMemoryEnabled` in settings | When off, Claude reads/writes **none** of this — the tab must say so loudly. |

## 3. Feature inventory (everything the redesign must cover)

### Scope switch
- **Workspace** vs **Subagent**. Last choice remembered.

### Workspace scope
1. **Memory list** — every `.md` in the folder; name, size, last-modified; text filter.
2. **Editor** — Markdown editor for the selected memory; Save (enabled only when dirty, "unsaved"
   marker), Delete (confirm). Shows the file path.
3. **New memory** — slug (`[a-z0-9-_]`) + optional one-line description → creates the file **and
   its `MEMORY.md` index line**. Delete removes the index line too.
4. **Live sync** — the folder is watched; external writes by Claude refresh the list (prevents
   saving a stale draft over Claude's update).
5. **Stale badges** (zero-cost, deterministic) — a memory is stale if it references a repo path
   that no longer exists, or is 90+ days old with no `[[wikilink]]` pointing at it. Reasons are
   available as strings. "Stale only (N)" filter.
6. **Index health** (new) — `MEMORY.md` lines/200 and KB/25, near-budget (≥180 lines or ≥22.5 KB)
   and over-budget states; **orphans** (files not in the index → "Claude won't see this");
   **dangling** index lines (point at missing files).
7. **Auto-memory-off banner** (new).
8. **Natural console** — chat-style box: `list`, `show <name>`, `search <text>`, `forget <name>`
   (confirm), `help` run locally; anything else offers **Send to Claude** (types a prompt into the
   project's live terminal session) or **Add as new memory**. Voice input button.
9. **Clusters** — groups memories into named themes with links between them; click a member to
   open it in the editor. Opening shows the cached result for free; **Aggregate/Refresh is a paid
   `claude -p` call** (Sonnet, ≤3 min) — the UI must make that cost gate explicit.

### Subagent scope (new, replaces the old JSON store)
10. **Agent picker** — every agent from `~/.claude/agents` and `<repo>/.claude/agents` (project
    shadows user), each showing its origin and its memory scope.
11. **Memory-enabled agent** → the *same* list/editor/index-health experience as Workspace, pointed
    at that agent's folder, with a scope note: user = all projects · project = shared via git ·
    local = this machine only.
12. **Agent without memory** → explain it has no persistent memory and that adding
    `memory: project` (or user/local) to its frontmatter in the Agent Library turns it on.
    No write controls.

### First-timer help
13. Collapsible **Learning panel** (shared `LearningPanel` component, copy in
    `src/renderer/components/learningContent.ts` → `memory`).

## 4. States to design

Loading · no project open (tab hidden on Home) · empty folder ("Claude writes memories when you
ask it to remember something") · auto memory off · index near budget · index over budget ·
orphans present · dangling lines present · stale memories present · unsaved draft · save/delete
error (errors go through the app toast) · Clusters: never run / cached / running / failed ·
Subagent: no agents · agent without memory · agent memory folder not created yet (empty, first
write creates it).

## 5. Data available to the UI (`window.api.memory`, `src/preload/api.d.ts`)

```ts
type MemoryTarget = { workspace?: string; cwd?: string; agent?: { name: string; scope: 'user'|'project'|'local' } }
list(target)    → { entries: { name, path, mtimeMs, bytes }[], dir, autoMemoryEnabled, error }
read(name, target) / write(name, content, target) / delete(name, target) / create(name, description?, target)
stale(target)   → { entries: { name, ageDays, inboundLinks, deadRefs[], stale, reasons[] }[],
                    index?: { lines, bytes, maxLines, maxBytes, overBudget, nearBudget, orphans[], dangling[] } }
agents(cwd)     → { agents: { name, origin: 'user'|'project', memoryScope: 'user'|'project'|'local'|null, agentFile }[] }
aggregate(workspace, refresh?, cwd?) → clusters (refresh=true is the paid call)
```

Nothing else is needed; a redesign should not require new IPC. If it does, that is a separate PRD.

## 6. Hard constraints (from the repo's laws — a design that breaks these won't ship)

- **Native files are the truth.** No Session-Manager-only memory fields, categories, or stores.
- Tailwind class names are literals (no interpolation); overlays use the one z-ladder
  (`lib/zLayers.ts`).
- Errors surface via toast, never swallowed.
- No new LeftNav destination — this stays one tab.
- No per-OS chrome. Must work in light and dark.
- Any paid LLM action (Clusters refresh) is an explicit button, never on mount.

## 7. In-flight work to coordinate with

As of 2026-10-12 these UI PRDs are queued/running in this Epic; a redesign should land **after**
them (or replace them) to avoid file conflicts on `Memory.tsx` / `memory/*`:

- 1895 `memory-tab-index-health-ui` — `MemoryIndexHealth` strip + banner + "not in index" badge
- 1897 `memory-store-view-extract` — shared `MemoryStoreView` for both scopes
- 1898 `subagent-memory-native-view` — native agent picker
- 1899 `retire-legacy-agent-memory` — removes the old JSON store
- 1900 `memory-learning-content` — Learning panel copy

Main-side work (1888, 1889, 1890, 1893, 1894) has already landed.

## 8. Source files

`src/renderer/components/tabs/Memory.tsx`, `tabs/MemoryNaturalPanel.tsx`,
`tabs/memory/{MemoryClustersPanel,SubagentMemoryView}.tsx` (+ `MemoryIndexHealth`,
`MemoryStoreView` once landed) · backend `src/main/memoryTool.cjs`, `memoryAggregate.cjs`,
`lib/memoryIndex.cjs`, `lib/memoryDirResolve.cjs`, `lib/memoryStale.cjs` · page steward:
none yet for `memory` (no `.claude/agents/page-memory.md`).
