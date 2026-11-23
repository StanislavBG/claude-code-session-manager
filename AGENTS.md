# Claude Code Session Manager

Electron desktop app — local cockpit for Claude Code CLI. Terminal + config/ops/scheduling tabs.
Per-project state: `<cwd>/session-manager-operations/`.

**This file holds the laws. The rationale behind each lives in a linked reference doc — follow the link
before changing anything in that area.** Every reference doc is in the [architecture index](session-manager-operations/architecture/README.md).

> **SIZE BUDGET — 12,000 chars**, checked with `wc -c AGENTS.md CLAUDE.md` (both files together, total ≤ 12,000) before every commit. This file is
> read on every turn of every session. A new law is ONE line here; its rationale goes in the linked
> doc. Over budget means **split, don't append**. Correcting a wrong line does not license a longer
> one — rewrite at the same length, move the "why" to the doc. (Hit 65,768 chars by 2026-08-24;
> 0 of 359 PRDs pruned it. This paragraph is the only reaper.)

## Scoped MDs — Claude Code auto-loads each AGENTS.md via its CLAUDE.md stub; other agents read them first

| Path | Scope |
| --- | --- |
| [`src/AGENTS.md`](src/AGENTS.md) (+ `main/lib`, `main/scheduler`), [`src/renderer/AGENTS.md`](src/renderer/AGENTS.md) | main/preload, renderer |
| [`scripts/README.md`](scripts/README.md), [`tests/README.md`](tests/README.md) | scripts, tests |
| [`web/README.md`](web/README.md), [`web/remote-app/AGENTS.md`](web/remote-app/AGENTS.md), [`web-remote/AGENTS.md`](web-remote/AGENTS.md) | web presence, remote app, relay |
| [`plugins/AGENTS.md`](plugins/AGENTS.md) | plugins |
| [`session-manager-operations/AGENTS.md`](session-manager-operations/AGENTS.md), [`architecture/README.md`](session-manager-operations/architecture/README.md) | ops root, architecture |

## Stack

Electron 42 (CommonJS main + preload) · React 18 + Vite · Tailwind · zustand · xterm + node-pty · Moonshine for voice.

## Commands

- `npm run dev` — Vite + Electron HMR (sets `SM_DEV=1`).
- `npm run build` — renderer build to `dist/`.
- `npm run typecheck` — `tsc --noEmit`. Must pass before commits.
- `npm run test:unit` — `vitest run`. One file: `npx vitest run <path>`. NOT `node --test`
  (can't resolve TS renderer imports).
- `npm run test:e2e` — Playwright Electron under `xvfb-run` (Linux).
- `npm run lint` — selectors + hooks (blank-screen guards) + doc hierarchy (`lint:docs`); run with typecheck.
- `npm run health` — `src/main/health.cjs` (exit 0 = GREEN).
- `npm publish` — `prepublishOnly`: build-info, build, lint:readme. Tag latest.
  Published as `claude-code-session-manager`; [distribution detail](session-manager-operations/architecture/conventions.md#distribution).

## Domain model — the laws

Full detail + rationale: [`domain-model.md`](session-manager-operations/architecture/domain-model.md).
Any new feature touching sessions, navigation, or per-project state must map onto the TAB → operations-root
→ EPIC → session hierarchy; the one Epic-less unit is the Task (TAB → operations-root `tasks/`, owner-approved 2026-11-22).

- **TAB = cwd = Main Project.** One TAB per project; extra sessions within a project are Epics, not tabs.
- **EPIC = one unit of work** (`PromptSession`). "Sessions" is the user-facing name; `Epic`/`PromptSession`/
  `epicId`/`epic-*` testids/on-disk paths stay the code name — don't "finish" the rename into identifiers.
- **EPIC : agent-CLI session = 1:1** (`claudeSessionId` = app id). Chat + Terminal = two VIEWS of it —
  switching never mints a new sessionId. Active Epics run in their own `git worktree` (branch `sm-epic/<id>`).
- **Epic creation is three independent selections:** `agentType` (Actor), `tag` (Mission), `agentCli` (absent =
  Claude Code; others: desktop-only). `tag` = closed 7-tag union. `developLoop:false` = no PRDs.
- **The opening prompt is AIM — Actor, Input, Mission, in that order**, composed only by
  `lib/epicIntake.ts`'s `composeEpicIntake`. It is framing, never a second source of truth for what the CLI loads.
- **A context pack = plugin + always-on rules**, per Epic (`PromptSession.packs`), loaded each turn/job via
  `--plugin-dir` + `--append-system-prompt` ([detail](session-manager-operations/architecture/domain-model.md#context-packs)).
- **An Epic's title + objective are fixed for the life of its session.** Iterate in follow-ups; start a
  new Epic, never repurpose one. (Queue-row rename: cosmetic only.)
- **Lifecycle is the single `status` field** — exactly `proposed` / `active` / `completed`, specified in
  [`prompt-sessions/README.md`](session-manager-operations/prompt-sessions/README.md#lifecycle). No `draft`;
  **every Epic is born `proposed`**, never directly `active`. Link there; never restate it.
- **SINGLE-CREATOR LAW: an Epic is created in exactly one place — a human pressing New Epic.** Enforced
  fail-closed in `src/main/lib/epic/epicMint.cjs`; `MINT_AUTHORITIES` has exactly two entries (the New Epic IPC
  handler, and `crossProjectFeedback.cjs`). A third entry = a domain-model change.
  **No agent-facing proposal channel** — an agent needing work runs `/develop` in its own Epic. PRDs join an existing Epic; they never conjure one.
- **A TASK is one headless `claude -p` run for a project** (no worktree/git/Epic/PRD), script-started only behind
  the human 'Scripts may run Tasks' switch ([why](session-manager-operations/architecture/domain-model.md#tasks)).
- **Cross-project feedback lands as a `proposed` Epic in the RECEIVING project** (`feedback_open_session`);
  a reply on its thread lands in the asking Epic via `feedback_reply`. Auto-approved only on a verified
  human quote or macro. Same-cwd → `/develop`.
- **A MACRO is a saved (agent, tag, prompt) hot key** (`macroLibrary.cjs`), per project; a **Project Home tool is
  global** (output per project); a **Project Video tool** (`surface: 'project-video'`) is one project's, shown only
  in its Project Home ▸ Video. Press = New Session (one mint); a script may start one only if a human
  ticked 'Can be started by a script' (POST /admin/macros/run).
- **Settings (System/Project/Local) is substrate, not per-Epic curation.** Per-Epic behavior is a
  Tag, persona, or PRD — never a Settings edit. `model` + `effort` are
  per-Epic (persona frontmatter beats Settings).
- **SINGLE-WRITER LAW over the operations root** (`src/main/lib/opsOwnership.cjs`). Every
  `session-manager-operations/<namespace>/` has exactly ONE owning writer; everyone else reads. Fail-closed —
  an undeclared writer throws. New namespace/writer = deliberate edit there. Build ops
  paths only via its `opsPath()`. Enumeration, owners, retention:
  [session-manager-operations/AGENTS.md](session-manager-operations/AGENTS.md).
- **Open-core: the APP and the Field Manual are both free, and stay free.** No license check,
  entitlement gate, trial limit, nag, "pro" tier, or paywalled feature/chapter.
- **The bilko.run relay stays live** — bridge `src/main/webRemote.cjs`, UI App Settings → Phone remote. Never
  remove the relay, its routes, or the product-page copy in `~/Projects/Bilko/`.

## Scheduler

Runs PRDs from `<cwd>/session-manager-operations/scheduler/epics/<epic-id>/prds/` as `claude -p` jobs. Detail:
[`code-map.md`](session-manager-operations/architecture/code-map.md),
[`scheduler/README.md`](session-manager-operations/scheduler/README.md).

- **PRD authoring is API-only** — `scheduler_create_prd` is the only way to write a PRD.
  App not running? Stop and ask the human to start it; never hand-write one.
- Flat scheduler/prds/ is **RETIRED** — auto-consolidated into prds-archived/ each `reconcile()` pass.
- Before writing a PRD, read [`PRD_AUTHORING.md`](src/main/templates/PRD_AUTHORING.md) — safety + checklist (§14).
- **Guard hooks adopt by REFERENCE via a stable shim** (`guardShims.cjs`,
  `~/.claude/session-manager/hooks/guard-*.cjs`) — readiness banner installs all four.
- A `needs_review` park self-heals first; its Epic gets one grouped notice when the ladder fails or the hold ends — never mints work.
- **Headless jobs run sandboxed** (`jobSandboxPolicy.cjs`): secrets unreadable; validator/dev-lead drop --dangerously-skip-permissions — [policy](session-manager-operations/architecture/scheduler-operations.md#11-job-sandbox).
- **Tool risk marks** (`~/.claude/tool-risk.json`, `<repo>/.claude/tool-risk.json`) block risky tools in jobs unless PRD `riskTools` clears them — [tool-risk.md](session-manager-operations/architecture/tool-risk.md).
- The Scheduler nav row is **PROJECT-face only** — every route it renders is cwd-derived.
- Stuck queue / parked `needs_review`? See
  [`scheduler-operations.md`](session-manager-operations/architecture/scheduler-operations.md) (ladder + diagnosis).

## Conventions

Full list + the incident behind each: [`conventions.md`](session-manager-operations/architecture/conventions.md).

- **Tab ID = claudeSessionId** (`--session-id` pass-through + JSONL lookup).
- **No CommonJS in renderer, no ES modules in main** — `.cjs` for main/preload bypasses `type: module`.
- **No backwards-compat shims** — single-author project; just rename/refactor.
- **Privacy invariant**: `RecordingStatus` MUST be mounted on the TOP z-ladder rung whenever `isRecording === true`.
- **One global z-ladder, `lib/zLayers.ts`** — class-name literals only, never interpolated (Tailwind JIT).
- **Telemetry is anonymous, on by default, opt-out** (`SM_TELEMETRY=0`) — see [telemetry.md](session-manager-operations/architecture/telemetry.md).
- **No per-OS UI chrome** — native frame everywhere; no layering branches on `process.platform`.
- **Toast is the user-facing error channel** — `useToast().show('error', msg)`; never swallow errors.
- **Needs you = an open question** (a chat ended needs-input). A parked PRD shows as being fixed, never needs review — `src/renderer/lib/needsHuman.ts`.
- **Renderer stores are islands** — no cross-store subscription; compose selectors per component.
- **`--model` must be pinned explicitly** on every `claude -p` / `--print` call site — unpinned drift costs.
- **The owner's real name and personal email never enter a tracked file or commit** — [why](session-manager-operations/architecture/identity-boundary.md).
- **Every doc follows the five doc kinds** — one topic, one topic doc, others link to it — [kinds](plugins/session-manager-dev/skills/maintaining-md-network/placement.md#doc-kinds).
- **AGENTS.md holds the map; CLAUDE.md is the `@AGENTS.md` stub** — [pair rule](plugins/session-manager-dev/skills/maintaining-md-network/placement.md#agentsmd-and-claudemd).

## Avoid

Each is a real incident; post-mortem in
[`conventions.md`](session-manager-operations/architecture/conventions.md) — read before working around one.

- Launching `claude -p` **without a slot from `lib/scheduler/sessionSlots.cjs`** (the sole
  machine-wide cap) — never reintroduce a private cap.
- Gating scheduler batches on **`parallelGroup`** — a per-PRD display hint, never a barrier.
  `dependsOn` is the sole ordering primitive.
- **Returning a freshly-built value from a zustand selector** (`?? []`, `.map(...)`, `Object.values(...)`) —
  infinite re-render → React #185 → **whole app renders blank**. `npm run lint:selectors`.
- **Declaring a hook below a top-level early return** — React #300/#310 → pane dies into its error boundary.
  `npm run lint:hooks`.
- Adding `shell: true` to `child_process.spawn` outside `watchers.cjs`/`app:test-fire-hook`.
- Re-implementing tmp+rename atomic writes — use `lib/util/atomicFs.cjs`.
- Reading remote URLs in prod — `createWindow` fails if `dist/index.html` is missing.
- Adding a LeftNav tab before checking if an existing surface owns that data.
- Adding pane state to parent tabs, or importing design primitives via wildcard.
- `scrollIntoView` / nested page scrollers — use `PageShell` + `lib/scrollWithin` (`lint:scroll`).
