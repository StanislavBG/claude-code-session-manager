# Claude Code Session Manager

Electron desktop app — local cockpit for Claude Code CLI. Terminal + config/ops/scheduling tabs.
Per-project state: `<cwd>/session-manager-operations/`.

**This file holds the laws; each one's rationale is in its linked doc — read it before changing that area.**

> **SIZE BUDGET — 12,000 chars**, checked with `wc -c AGENTS.md CLAUDE.md` (combined total) before every commit. This file is
> read on every turn of every session. A new law is ONE line here; its rationale goes in the linked
> doc. Over budget means **split, don't append**. Correcting a wrong line does not license a longer
> one — rewrite at the same length, move the "why" to the doc. (Hit 65,768 chars by 2026-08-24;
> 0 of 359 PRDs pruned it. This paragraph is the only reaper.)

## Scoped MDs (auto-loaded via CLAUDE.md stubs; other agents: read first)

| Path | Scope |
| --- | --- |
| [src/AGENTS.md](src/AGENTS.md) (+ `main/lib`, `main/scheduler`), [src/renderer/AGENTS.md](src/renderer/AGENTS.md) | main/preload, renderer |
| [scripts/README.md](scripts/README.md), [tests/README.md](tests/README.md) | scripts, tests |
| [web/README.md](web/README.md), [web/remote-app/AGENTS.md](web/remote-app/AGENTS.md), [web-remote/AGENTS.md](web-remote/AGENTS.md) | web presence, remote app, relay |
| [plugins/AGENTS.md](plugins/AGENTS.md) | plugins |
| [ops/AGENTS.md](session-manager-operations/AGENTS.md), [architecture/README.md](session-manager-operations/architecture/README.md) | ops root, architecture |

## Stack

Electron 42 (CommonJS main + preload) · React 18 + Vite · Tailwind · zustand · xterm + node-pty · Moonshine for voice.

## Commands

- `npm run dev` — Vite + Electron HMR (sets `SM_DEV=1`).
- `npm run build` — renderer build to `dist/`.
- `npm run typecheck` — `tsc --noEmit`. Must pass before commits.
- `npm run test:unit` — `vitest run`. One file: `npx vitest run <path>`. Never `node --test` (can't resolve TS).
- `npm run test:e2e` — Playwright Electron under `xvfb-run` (Linux).
- `npm run lint` — every `lint:*` (blank-screen guards, `lint:docs`, …); run with typecheck.
- `npm run health` — `src/main/health.cjs` (exit 0 = GREEN).
- `npm publish` — `claude-code-session-manager`, tag latest; [distribution](session-manager-operations/architecture/conventions.md#distribution).

## Domain model — the laws

Full detail + rationale: [`domain-model.md`](session-manager-operations/architecture/domain-model.md).
Any new feature touching sessions, navigation, or per-project state must map onto the TAB → operations-root
→ EPIC → session hierarchy; the one Epic-less unit is the Task (TAB → `tasks/`).

- **TAB = cwd = Main Project.** One TAB per project; extra sessions within a project are Epics, not tabs.
- **EPIC = one unit of work** (`PromptSession`). "Sessions" in the UI; code, testids and on-disk paths keep
  `Epic`/`epic` — never "finish" the rename.
- **EPIC : agent-CLI session = 1:1** (`claudeSessionId` = app id). Chat + Terminal = two VIEWS of it —
  switching never mints a new sessionId. Active Epics run in their own `git worktree` (branch `sm-epic/<id>`).
- **Epic creation is three independent selections:** `agentType` (Actor), `tag` (Mission), `agentCli` (absent =
  Claude Code; others: desktop-only). `tag` = closed 7-tag union. `developLoop:false` = no PRDs.
- **The opening prompt is AIM — Actor, Input, Mission, in that order**, composed only by
  `composeEpicIntake` (`lib/epicIntake.ts`) — framing, never a second source of what the CLI loads.
- **A context pack = plugin + always-on rules**, per Epic (`PromptSession.packs`), loaded every turn/job ([detail](session-manager-operations/architecture/domain-model.md#context-packs)).
- **An Epic's title + objective are fixed for the life of its session.** Iterate in follow-ups; mid-Epic defects are its side plans; never repurpose. (Row rename: cosmetic.)
- **Lifecycle is the single `status` field**, specified only in
  [`prompt-sessions/README.md`](session-manager-operations/prompt-sessions/README.md#lifecycle);
  **every Epic is born `proposed`**. Link there; never restate it.
- **SINGLE-CREATOR LAW: an Epic is created in exactly one place — a human pressing New Epic.** Fail-closed in
  `epicMint.cjs`: `MINT_AUTHORITIES` = New Epic IPC + `crossProjectFeedback.cjs`; a third = domain-model change.
  **No agent proposal channel** — an agent needing work runs `/develop` in its own Epic; PRDs join an Epic, never conjure one.
- **A TASK is one headless `claude -p` run for a project** (no worktree/git/Epic/PRD), script-started only behind
  'Scripts may run Tasks', set by a human or an agent quoting the human ([why](session-manager-operations/architecture/domain-model.md#tasks)).
- **Cross-project feedback lands as a `proposed` Epic in the RECEIVING project** (`feedback_open_session`);
  a thread reply lands in the asking Epic (`feedback_reply`). Auto-approved only on a verified
  human quote or macro. Same-cwd → `/develop`.
- **A MACRO is a saved (agent, tag, prompt) hot key** (`macroLibrary.cjs`), per project; a **Project Home tool is
  global** (output per project); a **Project Video tool** (`surface: 'project-video'`) is one project's (its
  Project Home ▸ Video). Press = New Session (one mint); a script may start one only if a human
  ticked 'Can be started by a script'.
- **Settings (System/Project/Local) is substrate, not per-Epic curation.** Per-Epic behavior is a
  Tag, persona, or PRD — never a Settings edit. `model` + `effort` are
  per-Epic (persona frontmatter beats Settings).
- **SINGLE-WRITER LAW over the operations root** (`src/main/lib/opsOwnership.cjs`). Each ops
  `<namespace>/` has ONE owning writer; others read; an undeclared writer throws. New namespace/writer =
  deliberate edit there; build paths only via `opsPath()`. Owners + retention: [ops AGENTS.md](session-manager-operations/AGENTS.md).
- **Open-core: the APP and the Field Manual are both free, and stay free.** Nothing is gated, nagged or paywalled.
- **The bilko.run relay stays live** — bridge `src/main/webRemote.cjs`, UI App Settings → Web remote. Never
  remove the relay, its routes, or the product-page copy in `~/Projects/Bilko/`.

## Scheduler

Runs PRDs from ops-root `scheduler/epics/<epic-id>/prds/` as `claude -p` jobs. Detail:
[`code-map.md`](session-manager-operations/architecture/code-map.md),
[`scheduler/README.md`](session-manager-operations/scheduler/README.md).

- **PRD authoring is API-only** — only `scheduler_create_prd` writes one; app down? Ask the
  human to start it, never hand-write one.
- Flat `scheduler/prds/` is **RETIRED** (`reconcile()` archives it).
- Before writing a PRD, read [`PRD_AUTHORING.md`](src/main/templates/PRD_AUTHORING.md) — safety + checklist (§14).
- **Guard hooks adopt by REFERENCE via a stable shim** (`guardShims.cjs`) — readiness banner installs all four.
- A `needs_review` park self-heals first ([ladder + diagnosis](session-manager-operations/architecture/scheduler-operations.md)); its Epic gets one grouped notice when the ladder fails or the hold ends — never mints work.
- **Tool risk marks** (`tool-risk.json`, user + repo) block risky tools in jobs unless PRD `riskTools` clears them — [tool-risk.md](session-manager-operations/architecture/tool-risk.md).
- The Scheduler nav row is **PROJECT-face only** — every route it renders is cwd-derived.

## Managed Agents laws (all local)

- [Strict persona schema; runs pin an AgentSnapshot](session-manager-operations/architecture/managed-agents-alignment.md#personas); [jobs and new Epics' chat get only declared gear](session-manager-operations/architecture/managed-agents-alignment.md#capabilities).
- [Jobs run sandboxed under a declared environment](session-manager-operations/architecture/managed-agents-alignment.md#environments), [never holding a credential](session-manager-operations/architecture/managed-agents-alignment.md#credentials).
- [An Epic's event log has one writer](session-manager-operations/architecture/managed-agents-alignment.md#event-log); [status edges obey legality tables, read as one phase](session-manager-operations/architecture/managed-agents-alignment.md#legality).
- [A human decision resumes the same session](session-manager-operations/architecture/managed-agents-alignment.md#confirm); [webhooks are loopback-only](session-manager-operations/architecture/managed-agents-alignment.md#webhooks).
- [Criteria carry checks; every PRD run records an outcome](session-manager-operations/architecture/managed-agents-alignment.md#outcomes).
- [Memory upkeep proposes, never deletes](session-manager-operations/architecture/managed-agents-alignment.md#memory); [model workarounds are registered](session-manager-operations/architecture/managed-agents-alignment.md#mitigations); [only a human purges an Epic](session-manager-operations/architecture/managed-agents-alignment.md#purge).

## Conventions

Each one's incident: [`conventions.md`](session-manager-operations/architecture/conventions.md).

- **Tab ID = claudeSessionId.**
- **No CommonJS in renderer, no ES modules in main** — `.cjs` for main/preload bypasses `type: module`.
- **No backwards-compat shims** — just rename/refactor.
- **Privacy invariant**: `RecordingStatus` MUST be mounted on the TOP z-ladder rung whenever `isRecording === true`.
- **One global z-ladder, `lib/zLayers.ts`** — class-name literals only, never interpolated (Tailwind JIT).
- **Telemetry is anonymous, on by default, opt-out** (`SM_TELEMETRY=0`) — [why](session-manager-operations/architecture/telemetry.md).
- **No per-OS UI chrome** — native frame everywhere; no layering branches on `process.platform`.
- **Toast is the user-facing error channel** — `useToast().show('error', msg)`; never swallow errors.
- **Needs you = an open question** (a chat ended needs-input). A parked PRD shows as being fixed, never needs review — `lib/needsHuman.ts`.
- **Renderer stores are islands** — no cross-store subscription; compose selectors per component.
- **`--model` must be pinned explicitly** on every `claude -p` / `--print` call site.
- **The owner's real name and personal email never enter a tracked file or commit** — [why](session-manager-operations/architecture/identity-boundary.md).
- **Five doc kinds; one topic, one topic doc** ([kinds](plugins/session-manager-dev/skills/maintaining-md-network/placement.md#doc-kinds)); **AGENTS.md is the map, CLAUDE.md its `@AGENTS.md` stub** — [pair rule](plugins/session-manager-dev/skills/maintaining-md-network/placement.md#agentsmd-and-claudemd).

## Avoid

Each is a real incident (post-mortem: `conventions.md`) — read it before working around one.

- Launching `claude -p` **without a slot from `lib/scheduler/sessionSlots.cjs`** — never reintroduce a private cap.
- Gating scheduler batches on **`parallelGroup`** — a per-PRD display hint, never a barrier.
  `dependsOn` is the sole ordering primitive.
- **Returning a freshly-built value from a zustand selector** (`?? []`, `.map(...)`, `Object.values(...)`) — `npm run lint:selectors`.
- **Declaring a hook below a top-level early return** — `npm run lint:hooks`.
- Adding `shell: true` to `child_process.spawn` outside `watchers.cjs`/`app:test-fire-hook`.
- Re-implementing tmp+rename atomic writes — use `lib/util/atomicFs.cjs`.
- Reading remote URLs in prod.
- Adding a LeftNav tab before checking if an existing surface owns that data.
- Adding pane state to parent tabs, or importing design primitives via wildcard.
- `scrollIntoView` / nested page scrollers — use `PageShell` + `lib/scrollWithin` (`lint:scroll`).
