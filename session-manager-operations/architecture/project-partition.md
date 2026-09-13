# Project partition — the four things in this repo

> This repo is read by every agent as one undifferentiated blob, but it holds four distinct
> things with different consumers and different change-risk profiles. This doc writes down the
> boundary that already exists — it does not move, rename, or split anything. Whether the
> partition later becomes a physical directory move is a separate, not-yet-made decision.

## The four partitions

| Partition | What it is | Who consumes it |
| --- | --- | --- |
| **DESKTOP HARNESS** | The Electron app itself: main/preload/renderer, build config, tests, dev tooling. | End users running `npx claude-code-session-manager`; contributors developing the app. |
| **WEB PRESENCE** | Code in THIS repo that produces content displayed on bilko.run. The pages themselves live in `~/Projects/Bilko`, a sibling repo — see below. | bilko.run visitors; the `bilko-host-publisher` / `project-home-builder` agent personas. |
| **AGENT LAYER** | Skills, hooks, and MCP tooling this repo ships so OTHER repos can adopt session-manager's dev workflow. | Other projects' Claude Code sessions, by npm install or by-reference absolute path — never just this repo. |
| **OPERATIONS STATE** | `session-manager-operations/` — per-project runtime state and docs, governed by the single-writer law. Not code. | This app's own main process (owned namespaces) and skills/humans (unowned namespaces). |

Domain concepts (TAB/EPIC/PRD, single-writer law) are defined in
[`domain-model.md`](domain-model.md) — not restated here. This doc only assigns *paths* to
*partitions*.

## Root-level paths

| Path | Partition | Note |
| --- | --- | --- |
| `bin/` | DESKTOP HARNESS | `cli.cjs` spawns the bundled Electron binary. |
| `src/` | *(split — see below)* | |
| `scripts/` | *(split — see below)* | |
| `dist/` | DESKTOP HARNESS | Renderer build output. |
| `e2e/`, `tests/`, `test/`, `test-results/` | DESKTOP HARNESS | `test/` is being retired by PRD 1182. |
| `screenshots/` | DESKTOP HARNESS | Manual/e2e capture output. |
| `docs/` | DESKTOP HARNESS | Legacy dev/design notes and PRD drafts predating `session-manager-operations/architecture/`; not the authoritative ops docs. |
| `.github/` | DESKTOP HARNESS | CI workflows (build/test/publish). |
| `.claude/` | DESKTOP HARNESS | This repo's own local dev config (agent personas used to develop session-manager, worktrees, settings) — distinct from the AGENT LAYER, which is what THIS repo ships to *other* repos. |
| `CLAUDE.md`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `tailwind.config.js`, `postcss.config.js`, `playwright.config.ts`, `package.json`, `package-lock.json`, `.gitignore`, `LICENSE` | DESKTOP HARNESS | Root build/governance config. |
| `plugins/` | AGENT LAYER | `plugins/session-manager-dev/skills/` — 15 skills (verified count). |
| `.claude-plugin/` | AGENT LAYER | Marketplace manifest for the `session-manager-dev` plugin. |
| `.mcp.json` | AGENT LAYER | Registers `scheduler-mcp-server.cjs` — the agent-facing door onto the scheduler. |
| `web-remote/` | WEB PRESENCE | See [web-remote/CLAUDE.md](../../web-remote/CLAUDE.md) for the live-vs-dead split inside it (`app/` live, `relay/` dead). |
| `session-manager-operations/` | OPERATIONS STATE | See namespace table below. |
| `README.md` | DESKTOP HARNESS | Also shipped in the npm `files` array as end-user install docs. |
| `node_modules/`, `.git/` | *(excluded)* | Dependency cache / VCS internals — not partition members. |
| `<path>` (stray 0-byte file at repo root) | *(excluded)* | Untracked leftover artifact, foreign to this PRD's work — not touched here. |

## `src/` top-level folders

| Folder | Partition | Note |
| --- | --- | --- |
| `src/main/` | DESKTOP HARNESS | **Except** `bilkoHost.cjs`, `bilkoHostCore.cjs`, `projectPages.cjs` → WEB PRESENCE (producers of the bilko.run project page). ~87.7k lines. |
| `src/preload/` | DESKTOP HARNESS | |
| `src/renderer/` | DESKTOP HARNESS | ~87.1k lines. |
| `src/seed/` | DESKTOP HARNESS | |

**Ambiguous case, resolved:** `src/main/scheduler.cjs` is DESKTOP HARNESS runtime (it is the app's job
executor, running whether or not any agent ever touches it), while `scripts/scheduler-mcp-server.cjs`
(the MCP tool wrapper around it) is AGENT LAYER — the door an agent opens, not the engine behind it.
See [`code-map.md`](code-map.md) for `scheduler.cjs`'s own detail.

## `scripts/` top-level entries

| Entry | Partition | Note |
| --- | --- | --- |
| `render-project-pages.cjs`, `render-project-pages/`, `project-pages-logic/`, `project-pages-assets.cjs`, `project-pages-publish-gate.cjs`, `validate-project-pages-summary.cjs`, `generate-project-pages-font-data.mjs`, `build-manual.mjs`, `capture-manual-figures.mjs`, `build-project-pages-logic.mjs`, `build-project-pages-renderer.mjs` | WEB PRESENCE | Producers + their own build steps. Last two are companion build tooling for `project-pages-logic/`/`render-project-pages/`'s bundles, not named in the PRD's list but belong with it by the same reasoning. |
| `hooks/` (`guard-destructive-git.cjs`, `guard-inline-implementation.cjs`, `guard-prd-writes.cjs`, `__tests__/`) | AGENT LAYER | Adopted by OTHER repos **by reference** at this repo's absolute path — never vendored. |
| `scheduler-mcp-server.cjs`, `mint-epic.cjs` | AGENT LAYER | The agent-facing doors onto scheduler + Epic minting. |
| `postinstall.cjs`, `lib/` (`activeSessions.cjs`, `watchdogHelpers.cjs`), `scheduler-watchdog.cjs`, `scheduler-watchdog.sh`, `install-scheduler-watchdog.sh`, `install-scheduler-mcp-user-scope.sh`, `health.sh`, `audit-ops-hygiene.cjs`, `bench-intraday-walk.cjs`, `check-conditional-hooks.cjs`, `check-unregistered-tests.cjs`, `check-unstable-selectors.cjs`, `cleanup-nested-queue-stubs.cjs`, `cleanup-worktree-ops-stubs.cjs`, `mirror-epic-status.cjs`, `ops-sweep.cjs`, `__tests__/` | DESKTOP HARNESS | Dev/build/lint/watchdog tooling for the app itself. `scripts/lib/` is required only by `scheduler-watchdog.cjs`. |

## `package.json`'s `files` array, cross-checked

The AC's claim was verified against the actual array (`node -e "console.log(require('./package.json').files)"`)
and needed one correction: the array is **not** AGENT-LAYER-only — it ships all three code partitions
together, since `npm install` is the single distribution mechanism for the whole app:

- **AGENT LAYER** entries: `.claude-plugin/`, `plugins/`, `scripts/mint-epic.cjs`,
  `scripts/scheduler-mcp-server.cjs`, `scripts/hooks/guard-prd-writes.cjs`,
  `scripts/hooks/guard-destructive-git.cjs`, `scripts/hooks/guard-inline-implementation.cjs`.
- **WEB PRESENCE** entries: `scripts/render-project-pages.cjs`,
  `scripts/render-project-pages/dist/`, `scripts/project-pages-logic/dist/`,
  `scripts/validate-project-pages-summary.cjs`.
- **DESKTOP HARNESS** entries (the rest): `bin/`, `scripts/postinstall.cjs`, `scripts/lib/`,
  `src/main/`, `src/preload/`, `src/seed/`, `dist/index.html`, `dist/assets/`, `dist/vad/`,
  `screenshots/`, `README.md`.

## `session-manager-operations/` namespaces

All 12 namespaces (`architecture`, `bilko-host`, `design-mocks`, `feedback` [retired],
`HUMAN_LEARN`, `logs`, `manual`, `project-brief`, `project-pages`, `prompt-sessions`, `reviews`,
`scheduler`) are **OPERATIONS STATE** — that partition *is* `session-manager-operations/`. Which
of them has an app-owned single writer vs. is skill-authored is [CLAUDE.md](../../CLAUDE.md)'s
`OWNERS` enumeration under Domain model — not restated here.

**Ambiguous case, resolved:** `manual/` is operations state (a skill-authored artifact folder,
not app-owned) whose *product* — the Field Manual — is sold via the WEB PRESENCE partition
(bilko.run checkout). The folder's partition is OPERATIONS STATE; only its output crosses into
WEB PRESENCE territory.

## Verification

Repo root listed via `ls -la`, `src/`/`scripts/` listed via `ls`, diffed by hand against every
row above — no top-level path is unassigned or duplicated, aside from the two explicitly
excluded (`node_modules/`, `.git/`) and the one explicitly excluded stray file.
