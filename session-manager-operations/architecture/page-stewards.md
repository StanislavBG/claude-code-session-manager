# Page stewards

> A page steward is one subagent per nav page, `.claude/agents/page-<NavKey>.md`, that audits, reviews and
> implements changes to that page. This file is the only copy of the principles; personas point here and
> never restate them.

## The six principles

### 1. Stateless — disk is the state

**Rule:** the page shows only state read from files on disk and keeps nothing authoritative in memory.
Reloading or restarting loses only transient UI such as hover, an open menu or scroll position. Per-project
state lives in `<cwd>/session-manager-operations/<namespace>/`, with paths built only by `opsPath()` from
`src/main/lib/opsOwnership.cjs` (the single-writer law). Machine-level state lives in Claude Code's own
`~/.claude/` files or in `~/.claude/session-manager/`. Zustand stores are projections of disk/IPC data, never
the source of truth.

**Precedent:** the Epic `stateless-ui-review-the-goal-of-the-local-harnes-dc39fabe`. Its goal: "The goal of the
local harness is to be stateless and only display state from files on disk." Enforcement:
`npm run lint:renderer-storage` bans `localStorage`/`sessionStorage` outside its ALLOWLIST. UI prefs persist
through `src/renderer/lib/uiPrefs.ts` / `src/renderer/lib/uiSettingsPrefs.ts`.

How to check: in owned files, find component state or module-level variables holding data that also lives on
disk with no re-read path, browser storage, or edits that are never written to a file.

### 2. Physical files — read and edit the real file

**Rule:** the page shows and edits the real files Claude Code itself reads, never an app-private copy, shadow
cache or export. Examples: `~/.claude/CLAUDE.md`, `~/.claude/settings.json`, `~/.claude/skills/<name>/SKILL.md`,
`~/.claude/agents/<name>.md`, `~/.claude/plugins/installed_plugins.json`. All file access goes renderer →
`window.api` → main.

**Precedent:** main resolves paths through `validatePath` in `src/main/config.cjs` and writes through
`src/main/lib/util/atomicFs.cjs`.

How to check: for every value shown, name the file it came from. For every save, name the file written and
confirm the CLI reads that exact path.

### 3. Current, not hardcoded

**Rule:** lists, counts, labels and options come from disk or the CLI at read time, and refresh when the file
changes outside the app. Do not hardcode catalogs of things that live on disk or in the CLI, such as models,
hook events, plugins or projects. A hand-maintained mirror (e.g. `src/renderer/lib/dataModelErd.ts`) names its
sources and changes in the same commit as they do. Generated data comes only from its generator.

**Precedent:** reference shape is `src/renderer/lib/useScopedConfigFiles.ts`,
`src/renderer/lib/useConfigDirWatch.ts`, `src/renderer/lib/useAgentsDirWatch.ts` (`window.api.config.watch` +
the `config:changed` event). `npm run sync:settings-schema` writes `src/renderer/data/claude-settings-schema.json`.

How to check: change the backing file outside the app and confirm the page updates without a reload. Look in
owned files for array/object literals of domain values.

### 4. One API per feature — no duplicates across tabs

**Rule:** a feature has exactly one IPC surface (`window.api.<ns>.<method>` → one main handler) and one
renderer hook or lib. A second page that needs the same data or action imports the owner's hook or lib. It
never adds a parallel IPC method, re-derives the value, or writes the same file through a different code path.

**Precedent:** `src/renderer/lib/usageWindow.ts` (shared by the footer and the Dashboard),
`src/renderer/lib/knownProjectAggregate.ts` (used by every "list the projects" surface), and
`src/renderer/lib/prettyModel.ts`. In `src/renderer/lib/navGroups.ts`, a machine-wide screen gets one door, not
a copy per face.

How to check: run `node scripts/page-surface.cjs --duplicates`. Every `window.api` method used by two pages'
owned files must go through one shared hook or lib; otherwise it is a finding.

### 5. Clear separation and platform adherence

**Rule:** the page owns its own files. Cross-page reuse goes only through `src/renderer/components/ui/`,
`src/renderer/lib/` or `src/renderer/state/`, never by importing another page's owned file.

**Precedent:**

(a) Electron:

- the renderer never touches fs or child_process
- main and preload are CommonJS `.cjs`; the renderer is ESM
- IPC payloads are zod-validated in `src/main/ipcSchemas.cjs`
- no `process.platform` UI branches
- z-index only through `src/renderer/lib/zLayers.ts`
- errors surface through `useToast().show('error', msg)`
- zustand stores are islands with no cross-store subscription

(b) Claude Code: on-disk formats follow Claude Code's documented schemas: the settings schema, skill and agent
frontmatter, hook event names, and MCP server config. The app is a cockpit over the platform's files, never a
fork of their format.

(c) Face law: the page appears only on the faces that `NAV_ITEMS` in `src/renderer/lib/navGroups.ts` declares.

How to check: in the shared list from `node scripts/page-surface.cjs <key>`, an import of another page's owned
file is a finding. Also run `npm run lint`.

### 6. Lean tests — no redundant test volume

**Rule:** the page's tests follow `tests/README.md` section "Test value — good test vs bloat". That means one
scenario test per workflow that drives public entrypoints, and no source-text assertions, mock-call-only
assertions or micro-files.

**Precedent:** the per-file verdicts (`keep`/`review`/`merge`/`bloat`) in `tests/quality/summary.json`, shown per
page by `node scripts/page-surface.cjs <key>`. Delete or merge a test only under that README's Reduction rule:
`scripts/test-quality/coverage-guard.cjs --base <sha>` exits 0, AND `scripts/test-quality/mutants.cjs` with the
same `--seed` shows no newly surviving mutant.

How to check: `npm run lint:test-smells` plus the verdicts.

## How a steward works

**Audit** — an audit PRD, or someone asks "audit <page>". Run `node scripts/page-surface.cjs <key>`. Check each
principle against the page's owned files. Note shared files but do not judge them, because they belong to every
page that reaches them. Write the audit report, commit only that file, and never edit product code or queue work.

**Review** — given a diff or commit range that touches the page. Apply the six checks to the changed lines only.
Reply with findings in the report's finding format; write no file.

**Implement** — a PRD runs with `agentType: page-<key>`. Follow the Run contract in
`~/.claude/agents/dev-lead.md` (ORIENT → RED → BUILD → FINISH) exactly. Before FINISH, run Review on your own
diff and list in the run report any principle it could not satisfy. Edit files outside the page's owned set only
when the PRD's Files section lists them.

In every mode, a problem in a shared file or another page's file is reported as a finding that names the owning
page. The steward does not fix it.

## Audit report

Path: `session-manager-operations/reviews/page-audits/<YYYY-MM-DD>-<key>.md`.

- Header: key, label, faces, entry, base SHA (`git rev-parse HEAD`), and the owned/shared/api/tests counts from
  the surface tool.
- Six subsections `### 1. Stateless` … `### 6. Lean tests`, each starting `Verdict: PASS` or `Verdict: FINDINGS`.
- `### Findings` table with columns: id (`<key>-F<n>`), severity, principle, file + symbol, evidence (a command
  plus an output excerpt, or quoted code), fix shape (`behavior` | `wire` | `migration` | `doc` |
  `test-reduction`), owner page.
- `### Test reduction candidates`: test file, verdict, reasons, proposed action (merge into <scenario test> /
  delete under the Reduction rule / keep).

## Severity

- **Critical:** a wrong file written, data loss, an unvalidated path or IPC payload, or a secret exposed.
- **Important:** a principle violation a user can observe, such as a stale list, state lost on reload, a
  hardcoded catalog drifting from disk, a second API for an existing feature, or another page's internals
  imported.
- **Minor:** test bloat, naming, doc drift, dead code.

## Naming

- The steward of NavKey `<k>` is `.claude/agents/page-<k>.md`, with `name: page-<k>` and a pinned `model`.
- The roster is `NAV_ITEMS` itself; never write a page list or a page count in a doc.
- `scripts/check-page-stewards.cjs` (`npm run lint:page-stewards`) enforces coverage.
- `scripts/page-surface.cjs` derives each page's files.
- Both scripts land in sibling PRDs, so they are cited in code spans, not markdown links: `npm run lint:docs`
  fails on a link that does not resolve.
